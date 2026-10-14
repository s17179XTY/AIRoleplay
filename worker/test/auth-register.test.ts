/// <reference types="node" />
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestD1 } from './helpers/d1';
import { MIGRATION_SQL } from './helpers/migration';
import { sha256Hex } from '../src/http';
import { normalizeUsername, handleRegister } from '../src/auth';
import type { Env } from '../src/types';

function makeEnv(): Env {
  return { DB: makeTestD1(MIGRATION_SQL), BLOBS: {} as never, ALLOWED_ORIGINS: '*', ADMIN_SECRET: 'test-secret' };
}

const body = (over: Record<string, unknown> = {}) => ({
  username: 'alice',
  inviteCode: 'INV-TEST-0001',
  authKey: 'auth-key-b64',
  kdf: '{"algo":"PBKDF2-SHA256","iters":600000,"v":1}',
  wrappedDek: 'wrapped-dek-b64',
  recoveryAuthKey: 'recovery-auth-b64',
  recoveryWrappedDek: 'recovery-wrapped-b64',
  label: '測試機',
  ...over,
});

async function seedInvite(env: Env, code: string, opts: { expiresAt?: number | null; used?: boolean } = {}) {
  await env.DB.prepare('INSERT INTO invites (code_hash, note, created_at, expires_at, used_by, used_at) VALUES (?,?,?,?,?,?)')
    .bind(await sha256Hex(code), '給 alice', 1000, opts.expiresAt ?? null, opts.used ? 'someone' : null, opts.used ? 2000 : null)
    .run();
}

describe('normalizeUsername', () => {
  it('小寫化並trim，規格外的字元一律拒絕', () => {
    expect(normalizeUsername('  Alice ')).toBe('alice');
    expect(normalizeUsername('a-b_c9')).toBe('a-b_c9');
    expect(normalizeUsername('ab')).toBeNull();
    expect(normalizeUsername('a'.repeat(33))).toBeNull();
    expect(normalizeUsername('壞名字')).toBeNull();
    expect(normalizeUsername('admin')).toBeNull();
    expect(normalizeUsername(123)).toBeNull();
  });
});

describe('handleRegister', () => {
  let env: Env;
  beforeEach(() => {
    env = makeEnv();
  });

  it('有效邀請碼可註冊，回傳 token 對，且不存任何明文秘密', async () => {
    await seedInvite(env, 'INV-TEST-0001');
    const reply = await handleRegister(env, body());
    expect(reply.status).toBe(200);
    expect(typeof reply.body.accessToken).toBe('string');
    expect(typeof reply.body.refreshToken).toBe('string');

    const row = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind('alice').first<Record<string, unknown>>();
    expect(row?.auth_hash).not.toBe('auth-key-b64');
    expect(row?.auth_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain('auth-key-b64');
    expect(row?.wrapped_dek).toBe('wrapped-dek-b64');
  });

  it('邀請碼一次性：第二次註冊同一碼會被拒', async () => {
    await seedInvite(env, 'INV-TEST-0001');
    expect((await handleRegister(env, body())).status).toBe(200);
    const second = await handleRegister(env, body({ username: 'bob' }));
    expect(second.status).toBe(403);
    expect(second.body.code).toBe('invite_invalid');
  });

  it('過期或已用的邀請碼被拒', async () => {
    await seedInvite(env, 'EXPIRED', { expiresAt: 500 });
    expect((await handleRegister(env, body({ inviteCode: 'EXPIRED' }), 1000)).status).toBe(403);
    await seedInvite(env, 'USED', { used: true });
    expect((await handleRegister(env, body({ inviteCode: 'USED' }), 1000)).status).toBe(403);
  });

  it('帳號名重複被拒（409）', async () => {
    await seedInvite(env, 'A1');
    await seedInvite(env, 'A2');
    await handleRegister(env, body({ inviteCode: 'A1' }));
    const dup = await handleRegister(env, body({ inviteCode: 'A2' }));
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('username_taken');
  });

  it('帳號名不合規則被拒（400），且不消耗邀請碼', async () => {
    await seedInvite(env, 'INV-TEST-0001');
    const bad = await handleRegister(env, body({ username: 'Admin' }));
    expect(bad.status).toBe(400);
    const still = await env.DB.prepare('SELECT used_by FROM invites WHERE code_hash = ?')
      .bind(await sha256Hex('INV-TEST-0001'))
      .first<{ used_by: string | null }>();
    expect(still?.used_by).toBeNull();
  });

  it('缺少欄位被拒（400）', async () => {
    await seedInvite(env, 'INV-TEST-0001');
    expect((await handleRegister(env, { username: 'alice' })).status).toBe(400);
    expect((await handleRegister(env, body({ wrappedDek: '' }))).status).toBe(400);
  });

  it('同 IP 連續註冊超過 10 次會被限流（429）', async () => {
    for (let i = 0; i < 10; i++) await seedInvite(env, `BULK-${i}`);
    for (let i = 0; i < 10; i++) {
      const r = await handleRegister(env, body({ username: `user${i}`, inviteCode: `BULK-${i}` }), 1000, 'ip-1');
      expect(r.status).toBe(200);
    }
    await seedInvite(env, 'BULK-LAST');
    const limited = await handleRegister(env, body({ username: 'userx', inviteCode: 'BULK-LAST' }), 1000, 'ip-1');
    expect(limited.status).toBe(429);
  });
});
