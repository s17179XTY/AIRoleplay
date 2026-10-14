/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { makeTestEnv } from './helpers/env';
import { MIGRATION_SQL } from './helpers/migration';
import { route } from '../src/router';
import { sha256Hex } from '../src/http';

const ORIGIN = 'https://air-roleplay.pages.dev';

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://api.example.com${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('router', () => {
  it('OPTIONS 預檢回 204 並帶正確 CORS 標頭', async () => {
    const env = makeTestEnv(MIGRATION_SQL);
    const res = await route(
      new Request('https://api.example.com/api/auth/login', {
        method: 'OPTIONS',
        headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
      }),
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('不在白名單的來源拿不到 CORS 標頭', async () => {
    const env = makeTestEnv(MIGRATION_SQL);
    const res = await route(
      new Request('https://api.example.com/api/me', { headers: { origin: 'https://evil.example' } }),
      env,
    );
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('预览部署网域（<hash>.air-roleplay.pages.dev）也放行——否则 Safari 只会显示 Load failed', async () => {
    const env = makeTestEnv(MIGRATION_SQL);
    const origin = 'https://7f63554d.air-roleplay.pages.dev';
    const res = await route(new Request('https://api.example.com/api/me', { headers: { origin } }), env);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
  });

  it('本机与区网开发来源也放行（手机连 dev server 要用）', async () => {
    const env = makeTestEnv(MIGRATION_SQL);
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://192.168.1.126:5173', 'http://10.0.0.5:5173']) {
      const res = await route(new Request('https://api.example.com/api/me', { headers: { origin } }), env);
      expect(res.headers.get('access-control-allow-origin'), origin).toBe(origin);
    }
  });

  it('不会误放行「长得像」的恶意来源', async () => {
    const env = makeTestEnv(MIGRATION_SQL);
    const bad = [
      'https://air-roleplay.pages.dev.evil.com',
      'https://evil-air-roleplay.pages.dev',
      'http://192.168.1.126.evil.com:5173',
      'ftp://192.168.1.126:5173',
    ];
    for (const origin of bad) {
      const res = await route(new Request('https://api.example.com/api/me', { headers: { origin } }), env);
      expect(res.headers.get('access-control-allow-origin'), origin).toBeNull();
    }
  });

  it('處理器炸掉時回 500，而且帶 CORS 標頭（否則瀏覽器只會顯示 Load failed）', async () => {
    const env = makeTestEnv(MIGRATION_SQL);
    const broken = {
      ...env,
      DB: {
        prepare() {
          throw new Error('boom');
        },
      },
    } as unknown as typeof env;
    const worker = (await import('../src/index')).default;
    const res = await worker.fetch(
      new Request('https://api.example.com/api/me', {
        // 要帶 token 才會真的去查資料庫（沒帶的話路由會在碰 DB 前就回 401）
        headers: { origin: 'https://air-roleplay.pages.dev', authorization: 'Bearer whatever' },
      }),
      broken,
    );
    expect(res.status).toBe(500);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://air-roleplay.pages.dev');
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('internal');
  });

  it('未帶 token 的 /api/sync/pull 回 401', async () => {
    const env = makeTestEnv(MIGRATION_SQL);
    const res = await route(new Request('https://api.example.com/api/sync/pull?cursor=0'), env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('unauthorized');
  });

  it('未知路徑回 404，方法不符回 405', async () => {
    const env = makeTestEnv(MIGRATION_SQL);
    expect((await route(new Request('https://api.example.com/api/nope'), env)).status).toBe(404);
    expect((await route(new Request('https://api.example.com/api/auth/login'), env)).status).toBe(405);
  });

  it('管理端邀請碼：錯的 secret 回 401，對的 secret 產生可用的碼（只存雜湊）', async () => {
    const env = makeTestEnv(MIGRATION_SQL);
    const denied = await route(post('/api/admin/invites', { note: 'alice' }, { 'x-admin-secret': 'wrong' }), env);
    expect(denied.status).toBe(401);

    const created = await route(post('/api/admin/invites', { note: 'alice' }, { 'x-admin-secret': 'test-secret' }), env);
    expect(created.status).toBe(200);
    const body = (await created.json()) as { code: string };
    expect(body.code).toMatch(/^INV-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const invite = await env.DB.prepare('SELECT code_hash, note FROM invites').first<{ code_hash: string; note: string }>();
    expect(invite?.code_hash).toBe(await sha256Hex(body.code));
    expect(invite?.note).toBe('alice');
  });

  it('完整註冊流程走 HTTP 也通（含 me）', async () => {
    const env = makeTestEnv(MIGRATION_SQL);
    const created = await route(post('/api/admin/invites', {}, { 'x-admin-secret': 'test-secret' }), env);
    const { code } = (await created.json()) as { code: string };
    const res = await route(
      post('/api/auth/register', {
        username: 'alice',
        inviteCode: code,
        authKey: 'k',
        kdf: '{}',
        wrappedDek: 'w',
        recoveryAuthKey: 'ra',
        recoveryWrappedDek: 'rw',
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accessToken: string };
    expect(typeof body.accessToken).toBe('string');

    const me = await route(
      new Request('https://api.example.com/api/me', { headers: { authorization: `Bearer ${body.accessToken}` } }),
      env,
    );
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { username: string };
    expect(meBody.username).toBe('alice');
  });

  it('push 走 HTTP：帶 token 可以推、token 錯了不行', async () => {
    const env = makeTestEnv(MIGRATION_SQL);
    const created = await route(post('/api/admin/invites', {}, { 'x-admin-secret': 'test-secret' }), env);
    const { code } = (await created.json()) as { code: string };
    const reg = await route(
      post('/api/auth/register', {
        username: 'bob',
        inviteCode: code,
        authKey: 'k',
        kdf: '{}',
        wrappedDek: 'w',
        recoveryAuthKey: 'ra',
        recoveryWrappedDek: 'rw',
      }),
      env,
    );
    const { accessToken } = (await reg.json()) as { accessToken: string };

    const bad = await route(post('/api/sync/push', { records: [] }, { authorization: 'Bearer nope' }), env);
    expect(bad.status).toBe(401);

    const good = await route(
      post(
        '/api/sync/push',
        { records: [{ kind: 'setting', id: 's1', rev: 1, baseRev: 0, updatedAt: 1, size: 6, ciphertext: 'CIPHER' }] },
        { authorization: `Bearer ${accessToken}` },
      ),
      env,
    );
    expect(good.status).toBe(200);
    const body = (await good.json()) as { accepted: unknown[] };
    expect(body.accepted).toHaveLength(1);
  });
});
