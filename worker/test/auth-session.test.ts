/// <reference types="node" />
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestD1 } from './helpers/d1';
import { MIGRATION_SQL } from './helpers/migration';
import { sha256Hex } from '../src/http';
import { handleRegister, handleLogin, handleRefresh, handleLogout, handleMe, authenticate } from '../src/auth';
import type { Env } from '../src/types';

const env = (): Env => ({ DB: makeTestD1(MIGRATION_SQL), BLOBS: {} as never, ALLOWED_ORIGINS: '*', ADMIN_SECRET: 's' });

const registerBody = (inviteCode = 'INV-1') => ({
  username: 'alice',
  inviteCode,
  authKey: 'auth-key-b64',
  kdf: '{"algo":"PBKDF2-SHA256","iters":600000,"v":1}',
  wrappedDek: 'wrapped-dek-b64',
  recoveryAuthKey: 'rec-auth-b64',
  recoveryWrappedDek: 'rec-wrapped-b64',
  label: '手機',
});

async function setup() {
  const e = env();
  await e.DB.prepare('INSERT INTO invites (code_hash, note, created_at, expires_at, used_by, used_at) VALUES (?,?,?,?,?,?)')
    .bind(await sha256Hex('INV-1'), null, 1, null, null, null)
    .run();
  const reg = await handleRegister(e, registerBody(), 1000, 'ip-1');
  return { env: e, reg };
}

describe('登入與 session', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('正確 authKey 可登入；錯誤 authKey 一律回同一句話', async () => {
    const good = await handleLogin(ctx.env, { username: 'ALICE', authKey: 'auth-key-b64' }, 2000, 'ip-2');
    expect(good.status).toBe(200);
    expect(typeof good.body.accessToken).toBe('string');

    const bad = await handleLogin(ctx.env, { username: 'alice', authKey: 'wrong' }, 2000, 'ip-3');
    expect(bad.status).toBe(401);
    expect(bad.body.message).toBe('帳號名或密碼錯誤');

    const ghost = await handleLogin(ctx.env, { username: 'nobody', authKey: 'wrong' }, 2000, 'ip-4');
    expect(ghost.status).toBe(401);
    expect(ghost.body.message).toBe('帳號名或密碼錯誤');
  });

  it('access token 能通過 authenticate；過期就失效', async () => {
    const access = ctx.reg.body.accessToken as string;
    const hit = await authenticate(ctx.env, `Bearer ${access}`, 2000);
    expect(hit).not.toBeNull();
    const expired = await authenticate(ctx.env, `Bearer ${access}`, 2000 + 15 * 60 * 1000 + 1);
    expect(expired).toBeNull();
  });

  it('refresh 會輪替 token，舊 refresh 立刻失效', async () => {
    const oldRefresh = ctx.reg.body.refreshToken as string;
    const rotated = await handleRefresh(ctx.env, { refreshToken: oldRefresh }, 3000);
    expect(rotated.status).toBe(200);
    expect(rotated.body.refreshToken).not.toBe(oldRefresh);
    const reuse = await handleRefresh(ctx.env, { refreshToken: oldRefresh }, 3000);
    expect(reuse.status).toBe(401);
  });

  it('登出後 token 立刻失效（可即時撤銷）', async () => {
    const auth = await authenticate(ctx.env, `Bearer ${ctx.reg.body.accessToken}`, 2000);
    expect(auth).not.toBeNull();
    await handleLogout(ctx.env, auth!.sessionId);
    expect(await authenticate(ctx.env, `Bearer ${ctx.reg.body.accessToken}`, 2000)).toBeNull();
  });

  it('me 回傳帳號、配額與已用空間', async () => {
    const auth = await authenticate(ctx.env, `Bearer ${ctx.reg.body.accessToken}`, 2000);
    const me = await handleMe(ctx.env, auth!.sessionId);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe('alice');
    expect(me.body.quota).toEqual({ used: 0, limit: 1073741824 });
  });

  it('畸形 Authorization 標頭不會炸', async () => {
    expect(await authenticate(ctx.env, null, 2000)).toBeNull();
    expect(await authenticate(ctx.env, 'Basic xyz', 2000)).toBeNull();
    expect(await authenticate(ctx.env, 'Bearer ', 2000)).toBeNull();
  });
});
