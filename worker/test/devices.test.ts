/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { makeTestEnv } from './helpers/env';
import { MIGRATION_SQL } from './helpers/migration';
import { route } from '../src/router';

const ORIGIN = 'https://air-roleplay.pages.dev';

async function registerUser(username: string, invite: string) {
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
        label: invite,
      }),
    }),
    env,
  );
  const body = (await res.json()) as { accessToken: string; refreshToken: string };
  return { env, accessToken: body.accessToken, refreshToken: body.refreshToken };
}

const get = (path: string, token?: string) =>
  new Request(`https://api.example.com${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

const del = (path: string, token?: string) =>
  new Request(`https://api.example.com${path}`, { method: 'DELETE', headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('裝置管理', () => {
  it('列出自己的裝置，並標出「就是這台」', async () => {
    const { env, accessToken } = await registerUser('alice', '手機');
    const res = await route(get('/api/devices', accessToken), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { devices: Array<{ label: string; current: boolean }> };
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0].label).toBe('手機');
    expect(body.devices[0].current).toBe(true);
  });

  it('同一帳號第二次登入會多一台裝置，且只有一台是 current', async () => {
    const { env, accessToken } = await registerUser('alice', '手機');
    const login = await route(
      new Request('https://api.example.com/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'alice', authKey: 'auth-alice', label: '平板' }),
      }),
      env,
    );
    const second = (await login.json()) as { accessToken: string };

    const res = await route(get('/api/devices', accessToken), env);
    const body = (await res.json()) as { devices: Array<{ label: string; current: boolean }> };
    expect(body.devices).toHaveLength(2);
    expect(body.devices.filter((d) => d.current)).toHaveLength(1);
    expect(body.devices.map((d) => d.label).sort()).toEqual(['平板', '手機']);

    const other = await route(get('/api/devices', second.accessToken), env);
    const otherBody = (await other.json()) as { devices: Array<{ current: boolean }> };
    expect(otherBody.devices.filter((d) => d.current)).toHaveLength(1);
  });

  it('踢掉另一台裝置後，那台的 token 立刻失效', async () => {
    const { env, accessToken } = await registerUser('alice', '手機');
    const login = await route(
      new Request('https://api.example.com/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'alice', authKey: 'auth-alice', label: '平板' }),
      }),
      env,
    );
    const second = (await login.json()) as { accessToken: string };

    const list = await route(get('/api/devices', accessToken), env);
    const { devices } = (await list.json()) as { devices: Array<{ id: string; label: string; current: boolean }> };
    const tablet = devices.find((d) => d.label === '平板')!;

    const revoked = await route(del(`/api/devices/${tablet.id}`, accessToken), env);
    expect(revoked.status).toBe(200);

    expect((await route(get('/api/me', second.accessToken), env)).status).toBe(401);
    expect((await route(get('/api/me', accessToken), env)).status).toBe(200); // 自己沒被踢

    const after = await route(get('/api/devices', accessToken), env);
    const afterBody = (await after.json()) as { devices: unknown[] };
    expect(afterBody.devices).toHaveLength(1);
  });

  it('不能踢別人的裝置（回 404，不洩漏存在與否）', async () => {
    const a = await registerUser('alice', '手機');
    const login = await route(
      new Request('https://api.example.com/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'alice', authKey: 'auth-alice', label: '平板' }),
      }),
      a.env,
    );
    const aSecond = (await login.json()) as { accessToken: string };
    const aList = await route(get('/api/devices', aSecond.accessToken), a.env);
    const { devices } = (await aList.json()) as { devices: Array<{ id: string; label: string }> };
    const victim = devices.find((d) => d.label === '手機')!.id;

    // 建第二個帳號（同一個 env 的另一個使用者）
    const created = await route(
      new Request('https://api.example.com/api/admin/invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-secret': 'test-secret' },
        body: JSON.stringify({}),
      }),
      a.env,
    );
    const { code } = (await created.json()) as { code: string };
    const reg = await route(
      new Request('https://api.example.com/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'bob', inviteCode: code, authKey: 'auth-bob', kdf: '{}',
          wrappedDek: 'w', recoveryAuthKey: 'ra', recoveryWrappedDek: 'rw',
        }),
      }),
      a.env,
    );
    const bob = (await reg.json()) as { accessToken: string };

    const res = await route(del(`/api/devices/${victim}`, bob.accessToken), a.env);
    expect(res.status).toBe(404);
    expect((await route(get('/api/me', aSecond.accessToken), a.env)).status).toBe(200); // alice 沒被影響
  });

  it('未帶 token 的裝置列表回 401', async () => {
    const { env } = await registerUser('alice', '手機');
    expect((await route(get('/api/devices'), env)).status).toBe(401);
  });

  it('CORS 白名單允許 DELETE 方法', async () => {
    const { env } = await registerUser('alice', '手機');
    const res = await route(
      new Request('https://api.example.com/api/devices/x', {
        method: 'OPTIONS',
        headers: { origin: ORIGIN, 'access-control-request-method': 'DELETE' },
      }),
      env,
    );
    expect(res.headers.get('access-control-allow-methods')).toContain('DELETE');
  });
});
