import { fail, ok, pbkdf2Hex, randomToken, sha256Hex, type ApiReply } from './http';
import { allow } from './rate';
import type { Env } from './types';

const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;
const RESERVED_USERNAMES = new Set(['admin', 'api', 'local']);

export const ACCESS_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_QUOTA_BYTES = 1073741824;

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().toLowerCase();
  if (!USERNAME_RE.test(name)) return null;
  if (RESERVED_USERNAMES.has(name)) return null;
  return name;
}

function requiredString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function createSession(
  env: Env,
  userId: string,
  label: string,
  now: number,
): Promise<SessionTokens> {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at, label, created_at, last_seen_at, revoked) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,0)',
  )
    .bind(
      randomToken(16),
      userId,
      await sha256Hex(accessToken),
      now + ACCESS_TTL_MS,
      await sha256Hex(refreshToken),
      now + REFRESH_TTL_MS,
      label.slice(0, 60),
      now,
      now,
    )
    .run();
  return { accessToken, refreshToken };
}

export async function handleRegister(
  env: Env,
  body: unknown,
  now = Date.now(),
  clientIp = 'unknown',
): Promise<ApiReply> {
  if (!(await allow(env.DB, `register:${clientIp}`, 10, 60, now))) {
    return fail(429, 'rate_limited', '伺服器忙，稍後自動重試');
  }
  if (typeof body !== 'object' || body === null) return fail(400, 'bad_body', '請求格式錯誤');
  const input = body as Record<string, unknown>;

  const username = normalizeUsername(input.username);
  if (!username) return fail(400, 'username_invalid', '帳號名 3–32 字元，只能用小寫字母、數字、- 和 _');

  const inviteCode = requiredString(input, 'inviteCode');
  const authKey = requiredString(input, 'authKey');
  const kdf = requiredString(input, 'kdf');
  const wrappedDek = requiredString(input, 'wrappedDek');
  const recoveryAuthKey = requiredString(input, 'recoveryAuthKey');
  const recoveryWrappedDek = requiredString(input, 'recoveryWrappedDek');
  if (!inviteCode || !authKey || !kdf || !wrappedDek || !recoveryAuthKey || !recoveryWrappedDek) {
    return fail(400, 'bad_body', '缺少必要欄位');
  }

  const codeHash = await sha256Hex(inviteCode);
  const invite = await env.DB.prepare('SELECT code_hash, expires_at, used_by FROM invites WHERE code_hash = ?')
    .bind(codeHash)
    .first<{ code_hash: string; expires_at: number | null; used_by: string | null }>();
  if (!invite || invite.used_by !== null) return fail(403, 'invite_invalid', '邀請碼無效或已被使用');
  if (invite.expires_at !== null && invite.expires_at < now) {
    return fail(403, 'invite_invalid', '邀請碼無效或已被使用');
  }

  const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first<{ id: string }>();
  if (existing) return fail(409, 'username_taken', '這個帳號名已經有人用了');

  const userId = `u_${randomToken(12)}`;
  const authSalt = randomToken(16);
  const recoverySalt = randomToken(16);

  await env.DB.prepare(
    'INSERT INTO users (id, username, kdf, auth_hash, auth_salt, wrapped_dek, recovery_wrapped_dek, recovery_hash, recovery_salt, quota_bytes, used_bytes, created_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,0,?)',
  )
    .bind(
      userId,
      username,
      kdf,
      await pbkdf2Hex(authKey, authSalt),
      authSalt,
      wrappedDek,
      recoveryWrappedDek,
      await pbkdf2Hex(recoveryAuthKey, recoverySalt),
      recoverySalt,
      DEFAULT_QUOTA_BYTES,
      now,
    )
    .run();

  await env.DB.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ? AND used_by IS NULL')
    .bind(userId, now, codeHash)
    .run();

  const tokens = await createSession(env, userId, typeof input.label === 'string' ? input.label : '', now);
  return ok({ username, ...tokens });
}
