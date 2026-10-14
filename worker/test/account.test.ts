/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { makeTestEnv } from './helpers/env';
import { testKV } from './helpers/kv';
import { MIGRATION_SQL } from './helpers/migration';
import { route } from '../src/router';

const ORIGIN = 'https://air-roleplay.pages.dev';

/** 註冊一個帳號（順手用 admin 端點發一張邀請碼），回傳 token 與 env */
async function registerUser(username: string) {
  const env = makeTestEnv(MIGRATION_SQL);
  const created = await route(
    new Request('https://api.example.com/api/admin/invites', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-secret': 'test-secret' },
      body: JSON.stringify({}),
    }),
    env,
  );
  const { code } = (await created.json()) as { code: string };

  const res = await route(
    new Request('https://api.example.com/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username,
        inviteCode: code,
        authKey: `auth-${username}`,
        kdf: '{}',
        wrappedDek: 'w',
        recoveryAuthKey: 'ra',
        recoveryWrappedDek: 'rw',
        label: 'device-a',
      }),
    }),
    env,
  );
  const body = (await res.json()) as { accessToken: string; refreshToken: string };
  return { env, accessToken: body.accessToken, refreshToken: body.refreshToken };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

describe('删除帐号 DELETE /api/account', () => {
  it('没有 token 回 401，而且不会误删任何东西', async () => {
    const { env } = await registerUser('alice');
    const res = await route(
      new Request('https://api.example.com/api/account', { method: 'DELETE', headers: { origin: ORIGIN } }),
      env,
    );
    expect(res.status).toBe(401);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>()).toEqual({ n: 1 });
  });

  it('删除后云端 records / changes / sessions / users 全清，access token 立刻失效', async () => {
    const { env, accessToken } = await registerUser('alice');

    // 先写一笔记录，确保真的有东西可删
    const pushed = await route(
      new Request('https://api.example.com/api/sync/push', {
        method: 'POST',
        headers: auth(accessToken),
        body: JSON.stringify({
          records: [{
            kind: 'setting', id: 'k1', rev: 1, baseRev: 0, updatedAt: 1, size: 3, ciphertext: 'abc',
          }],
        }),
      }),
      env,
    );
    expect(pushed.status).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM records').first<{ n: number }>()).toEqual({ n: 1 });

    const res = await route(
      new Request('https://api.example.com/api/account', { method: 'DELETE', headers: auth(accessToken) }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, deleted: true });

    for (const table of ['records', 'changes', 'sessions', 'resets', 'users']) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
      expect(row?.n, table + ' 应该被清空').toBe(0);
    }

    // 旧 token 不能再用
    const me = await route(new Request('https://api.example.com/api/me', { headers: auth(accessToken) }), env);
    expect(me.status).toBe(401);
  });

  it('删除帐号会连 KV 上的素材一起删掉（key 是 <userId>/<blobId>）', async () => {
    const { env, accessToken } = await registerUser('alice');
    const userId = (await env.DB.prepare('SELECT id FROM users LIMIT 1').first<{ id: string }>())!.id;

    const put = await route(
      new Request('https://api.example.com/api/blob/img_1', {
        method: 'PUT',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/octet-stream' },
        body: new Uint8Array([1, 2, 3, 4]),
      }),
      env,
    );
    expect(put.status).toBe(200);
    expect(testKV(env).keys()).toContain(`${userId}/img_1`);

    const res = await route(
      new Request('https://api.example.com/api/account', { method: 'DELETE', headers: auth(accessToken) }),
      env,
    );
    expect(res.status).toBe(200);
    expect(testKV(env).keys()).not.toContain(`${userId}/img_1`);
  });

  it('别人的帐号不受影响', async () => {
    const a = await registerUser('alice');
    const b = await registerUser('bob');

    await route(
      new Request('https://api.example.com/api/account', { method: 'DELETE', headers: auth(a.accessToken) }),
      a.env,
    );

    const me = await route(new Request('https://api.example.com/api/me', { headers: auth(b.accessToken) }), b.env);
    expect(me.status).toBe(200);
  });
});
