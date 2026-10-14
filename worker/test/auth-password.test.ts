/// <reference types="node" />
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestEnv } from './helpers/env';
import { MIGRATION_SQL } from './helpers/migration';
import { sha256Hex } from '../src/http';
import {
  handleChangePassword, handleLogin, handleRecoverFinish, handleRecoverStart, handleRegister, authenticate,
} from '../src/auth';
import type { Env } from '../src/types';

const USER = 'alice';
const EMAIL = 'INV-PW';

async function setup(): Promise<{
  env: Env;
  userId: string;
  accessToken: string;
  refreshToken: string;
  recoveryCode: string;
}> {
  const env = makeTestEnv(MIGRATION_SQL);
  await env.DB.prepare('INSERT INTO invites (code_hash, note, created_at, expires_at, used_by, used_at) VALUES (?,?,?,?,NULL,NULL)')
    .bind(await sha256Hex(EMAIL), null, 1, null)
    .run();
  const reg = await handleRegister(
    env,
    {
      username: USER,
      inviteCode: EMAIL,
      authKey: 'auth-old',
      kdf: '{"algo":"PBKDF2-SHA256","iters":1000,"v":1}',
      wrappedDek: 'wrapped-old',
      recoveryAuthKey: 'recovery-old',
      recoveryWrappedDek: 'recovery-wrapped-old',
    },
    1000,
    'ip-1',
  );
  // handleChangePassword 收的是 userId（u_xxx），不是帳號名——測試這裡踩過一次
  const row = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(USER).first<{ id: string }>();
  return {
    env,
    userId: row!.id,
    accessToken: reg.body.accessToken as string,
    refreshToken: reg.body.refreshToken as string,
    recoveryCode: 'recovery-old',
  };
}

describe('改密碼', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('舊 authKey 錯 → 401，且什麼都沒改', async () => {
    const res = await handleChangePassword(ctx.env, ctx.userId, {
      oldAuthKey: 'wrong',
      newAuthKey: 'auth-new',
      newKdf: '{"algo":"PBKDF2-SHA256","iters":2000,"v":1}',
      newWrappedDek: 'wrapped-new',
      newRecoveryAuthKey: 'recovery-new',
      newRecoveryWrappedDek: 'recovery-wrapped-new',
    });
    expect(res.status).toBe(401);
    const row = await ctx.env.DB.prepare('SELECT wrapped_dek, kdf FROM users WHERE username = ?')
      .bind(USER)
      .first<{ wrapped_dek: string; kdf: string }>();
    expect(row?.wrapped_dek).toBe('wrapped-old');
    expect(row?.kdf).toContain('1000');
  });

  it('成功後：舊 authKey 登不進去、新 authKey 可以，wrappedDek 也換了', async () => {
    const res = await handleChangePassword(ctx.env, ctx.userId, {
      oldAuthKey: 'auth-old',
      newAuthKey: 'auth-new',
      newKdf: '{"algo":"PBKDF2-SHA256","iters":2000,"v":1}',
      newWrappedDek: 'wrapped-new',
      newRecoveryAuthKey: 'recovery-new',
      newRecoveryWrappedDek: 'recovery-wrapped-new',
    });
    expect(res.status).toBe(200);

    expect((await handleLogin(ctx.env, { username: USER, authKey: 'auth-old' }, 2000, 'ip-x')).status).toBe(401);
    const ok = await handleLogin(ctx.env, { username: USER, authKey: 'auth-new' }, 2000, 'ip-x');
    expect(ok.status).toBe(200);

    const me = await ctx.env.DB.prepare('SELECT wrapped_dek FROM users WHERE username = ?')
      .bind(USER)
      .first<{ wrapped_dek: string }>();
    expect(me?.wrapped_dek).toBe('wrapped-new');
  });

  it('改密碼不會撤銷既有 session（其他裝置的 DEK 還在記憶體裡，能繼續用）', async () => {
    await handleChangePassword(ctx.env, ctx.userId, {
      oldAuthKey: 'auth-old',
      newAuthKey: 'auth-new',
      newKdf: '{}',
      newWrappedDek: 'wrapped-new',
      newRecoveryAuthKey: 'recovery-new',
      newRecoveryWrappedDek: 'recovery-wrapped-new',
    });
    expect(await authenticate(ctx.env, `Bearer ${ctx.accessToken}`, 2000)).not.toBeNull();
  });

  it('缺欄位 → 400', async () => {
    expect((await handleChangePassword(ctx.env, ctx.userId, { oldAuthKey: 'auth-old' })).status).toBe(400);
  });
});

describe('恢復碼救援', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('恢復碼錯 → 401', async () => {
    expect((await handleRecoverStart(ctx.env, { username: USER, recoveryAuthKey: 'nope' }, 2000)).status).toBe(401);
  });

  it('驗證通過後回傳 recoveryWrappedDek（客戶端要靠它解出 DEK）', async () => {
    const res = await handleRecoverStart(ctx.env, { username: USER, recoveryAuthKey: 'recovery-old' }, 2000);
    expect(res.status).toBe(200);
    expect(res.body.recoveryWrappedDek).toBe('recovery-wrapped-old');
  });

  it('帳號不存在也回同一句話（不洩漏帳號是否存在）', async () => {
    const a = await handleRecoverStart(ctx.env, { username: 'nobody', recoveryAuthKey: 'x' }, 2000);
    expect(a.status).toBe(401);
    expect(a.body.message).toBe('帳號名或恢復碼錯誤');
  });

  it('完整流程：拿 resetToken → 換密碼與恢復碼 → 所有舊 session 失效、新密碼可用', async () => {
    const start = await handleRecoverStart(ctx.env, { username: USER, recoveryAuthKey: 'recovery-old' }, 2000);
    expect(start.status).toBe(200);
    const token = start.body.resetToken as string;
    expect(token).toBeTruthy();

    const finish = await handleRecoverFinish(
      ctx.env,
      {
        resetToken: token,
        newAuthKey: 'auth-rescued',
        newKdf: '{"algo":"PBKDF2-SHA256","iters":1500,"v":1}',
        newWrappedDek: 'wrapped-rescued',
        newRecoveryAuthKey: 'recovery-rescued',
        newRecoveryWrappedDek: 'recovery-wrapped-rescued',
      },
      2001,
    );
    expect(finish.status).toBe(200);

    // 舊 token 全部失效
    expect(await authenticate(ctx.env, `Bearer ${ctx.accessToken}`, 2001)).toBeNull();
    expect((await handleLogin(ctx.env, { username: USER, authKey: 'auth-old' }, 2001, 'ip-x')).status).toBe(401);

    // 新密碼可用
    const ok = await handleLogin(ctx.env, { username: USER, authKey: 'auth-rescued' }, 2001, 'ip-x');
    expect(ok.status).toBe(200);

    // 恢復碼也換了：舊的不能再用、新的可以
    expect((await handleRecoverStart(ctx.env, { username: USER, recoveryAuthKey: 'recovery-old' }, 2001)).status).toBe(401);
    expect((await handleRecoverStart(ctx.env, { username: USER, recoveryAuthKey: 'recovery-rescued' }, 2001)).status).toBe(200);
  });

  it('resetToken 是一次性的', async () => {
    const start = await handleRecoverStart(ctx.env, { username: USER, recoveryAuthKey: 'recovery-old' }, 2000);
    const token = start.body.resetToken as string;
    const body = {
      resetToken: token,
      newAuthKey: 'auth-rescued',
      newKdf: '{}',
      newWrappedDek: 'w',
      newRecoveryAuthKey: 'ra',
      newRecoveryWrappedDek: 'rw',
    };
    expect((await handleRecoverFinish(ctx.env, body, 2001)).status).toBe(200);
    expect((await handleRecoverFinish(ctx.env, body, 2002)).status).toBe(401);
  });

  it('resetToken 五分鐘後過期', async () => {
    const start = await handleRecoverStart(ctx.env, { username: USER, recoveryAuthKey: 'recovery-old' }, 2000);
    const token = start.body.resetToken as string;
    const res = await handleRecoverFinish(
      ctx.env,
      {
        resetToken: token,
        newAuthKey: 'a',
        newKdf: '{}',
        newWrappedDek: 'w',
        newRecoveryAuthKey: 'ra',
        newRecoveryWrappedDek: 'rw',
      },
      2000 + 5 * 60 * 1000 + 1,
    );
    expect(res.status).toBe(401);
  });

  it('救援請求會被限流（每帳號每小時 5 次）', async () => {
    for (let i = 0; i < 5; i++) {
      await handleRecoverStart(ctx.env, { username: USER, recoveryAuthKey: 'wrong' }, 3000);
    }
    const limited = await handleRecoverStart(ctx.env, { username: USER, recoveryAuthKey: 'recovery-old' }, 3000);
    expect(limited.status).toBe(429);
  });
});
