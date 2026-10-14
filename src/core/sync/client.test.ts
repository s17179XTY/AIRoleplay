import { describe, it, expect, vi } from 'vitest';
import { createSyncClient, SyncApiError } from './client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('sync client', () => {
  it('登入成功後把 token 交出去', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, username: 'alice', accessToken: 'A1', refreshToken: 'R1' }));
    const seen: unknown[] = [];
    const client = createSyncClient({ baseUrl: 'https://api.test', fetchImpl, onTokens: (t) => seen.push(t) });
    const out = await client.login({ username: 'alice', authKey: 'k' });
    expect(out.username).toBe('alice');
    expect(seen).toEqual([{ accessToken: 'A1', refreshToken: 'R1' }]);
  });

  it('帶 token 的請求會附 Authorization 與正確 URL', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(200, { ok: true, cursor: 0, hasMore: false, records: [], quota: { used: 0, limit: 1 } });
    }) as unknown as typeof fetch;
    const client = createSyncClient({
      baseUrl: 'https://api.test/',
      fetchImpl,
      getTokens: () => ({ accessToken: 'A1', refreshToken: 'R1' }),
    });
    await client.pull(0);
    expect(calls[0].url).toBe('https://api.test/api/sync/pull?cursor=0&limit=200');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer A1');
  });

  it('401 會自動 refresh 並重試一次', async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/refresh')) return jsonResponse(200, { ok: true, accessToken: 'A2', refreshToken: 'R2' });
      attempt += 1;
      if (attempt === 1) return jsonResponse(401, { ok: false, code: 'unauthorized', message: '請先登入' });
      return jsonResponse(200, { ok: true, cursor: 5, hasMore: false, records: [], quota: { used: 0, limit: 1 } });
    }) as unknown as typeof fetch;
    const client = createSyncClient({
      baseUrl: 'https://api.test',
      fetchImpl,
      getTokens: () => ({ accessToken: 'A1', refreshToken: 'R1' }),
    });
    const out = await client.pull(0);
    expect(out.cursor).toBe(5);
    expect(attempt).toBe(2);
  });

  it('refresh 也失敗就拋 401，並清掉 token', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/api/auth/refresh')
        ? jsonResponse(401, { ok: false, code: 'bad_refresh', message: '登入狀態已過期' })
        : jsonResponse(401, { ok: false, code: 'unauthorized', message: '請先登入' }),
    ) as unknown as typeof fetch;
    const seen: unknown[] = [];
    const client = createSyncClient({
      baseUrl: 'https://api.test',
      fetchImpl,
      getTokens: () => ({ accessToken: 'A1', refreshToken: 'R1' }),
      onTokens: (t) => seen.push(t),
    });
    await expect(client.pull(0)).rejects.toBeInstanceOf(SyncApiError);
    expect(seen).toEqual([null]);
  });

  it('伺服器錯誤會被包成 SyncApiError（帶 code 與 status）', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(413, { ok: false, code: 'quota_exceeded', message: '雲端空間已滿', quota: { used: 9, limit: 10 } }),
    ) as unknown as typeof fetch;
    const client = createSyncClient({
      baseUrl: 'https://api.test',
      fetchImpl,
      getTokens: () => ({ accessToken: 'A1', refreshToken: 'R1' }),
    });
    await expect(client.push({ records: [] })).rejects.toMatchObject({ status: 413, code: 'quota_exceeded' });
  });

  it('網路錯誤原樣往上拋（讓引擎決定要不要退避）', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const client = createSyncClient({
      baseUrl: 'https://api.test',
      fetchImpl,
      getTokens: () => ({ accessToken: 'A1', refreshToken: 'R1' }),
    });
    await expect(client.pull(0)).rejects.toBeInstanceOf(TypeError);
  });

  it('logout 即使伺服器失敗也會把本地 token 清掉', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const seen: unknown[] = [];
    const client = createSyncClient({
      baseUrl: 'https://api.test',
      fetchImpl,
      getTokens: () => ({ accessToken: 'A1', refreshToken: 'R1' }),
      onTokens: (t) => seen.push(t),
    });
    await expect(client.logout()).rejects.toBeInstanceOf(TypeError);
    expect(seen).toEqual([null]);
  });

  it('putBlob 走二進位通道、帶 Authorization，不吃 JSON', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, blobId: 'b1', size: 4 }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createSyncClient({
      baseUrl: 'https://api.test',
      fetchImpl,
      getTokens: () => ({ accessToken: 'A1', refreshToken: 'R1' }),
    });

    const out = await client.putBlob('b1', new Uint8Array([1, 2, 3, 4]));

    expect(out.size).toBe(4);
    expect(calls[0].url).toBe('https://api.test/api/blob/b1');
    expect(calls[0].init.method).toBe('PUT');
    expect((calls[0].init.headers as Record<string, string>)['content-type']).toBe('application/octet-stream');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer A1');
    expect(calls[0].init.body).toBeInstanceOf(ArrayBuffer);
  });

  it('getBlob 拿回位元組；404 回 null（最終一致性要重試，不是錯誤）', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([9, 8, 7]), { status: 200 })) as unknown as typeof fetch;
    const client = createSyncClient({
      baseUrl: 'https://api.test',
      fetchImpl,
      getTokens: () => ({ accessToken: 'A1', refreshToken: 'R1' }),
    });
    expect(Array.from((await client.getBlob('b1'))!)).toEqual([9, 8, 7]);

    const notFound = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, code: 'blob_missing' }), { status: 404 }),
    ) as unknown as typeof fetch;
    const client2 = createSyncClient({
      baseUrl: 'https://api.test',
      fetchImpl: notFound,
      getTokens: () => ({ accessToken: 'A1', refreshToken: 'R1' }),
    });
    expect(await client2.getBlob('b1')).toBeNull();
  });

  it('blob 請求遇到 401 也會自動 refresh 再重試一次', async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/refresh')) return jsonResponse(200, { ok: true, accessToken: 'A2', refreshToken: 'R2' });
      attempt += 1;
      if (attempt === 1) return new Response(JSON.stringify({ ok: false, code: 'unauthorized' }), { status: 401 });
      return new Response(JSON.stringify({ ok: true, blobId: 'b1', size: 2 }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createSyncClient({
      baseUrl: 'https://api.test',
      fetchImpl,
      getTokens: () => ({ accessToken: 'A1', refreshToken: 'R1' }),
    });
    expect((await client.putBlob('b1', new Uint8Array([1, 2]))).size).toBe(2);
    expect(attempt).toBe(2);
  });
});
