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

export async function handleLogin(
  env: Env,
  body: unknown,
  now = Date.now(),
  clientIp = 'unknown',
): Promise<ApiReply> {
  if (!(await allow(env.DB, `login:${clientIp}`, 10, 60, now))) {
    return fail(429, 'rate_limited', '伺服器忙，稍後自動重試');
  }
  if (typeof body !== 'object' || body === null) return fail(400, 'bad_body', '請求格式錯誤');
  const input = body as Record<string, unknown>;
  const username = normalizeUsername(input.username);
  const authKey = requiredString(input, 'authKey');
  // 帳號不存在與密碼錯誤回同一句話，不洩漏帳號是否存在
  if (!username || !authKey) return fail(401, 'bad_credentials', '帳號名或密碼錯誤');

  const user = await env.DB.prepare('SELECT id, auth_hash, auth_salt FROM users WHERE username = ?')
    .bind(username)
    .first<{ id: string; auth_hash: string; auth_salt: string }>();
  if (!user) return fail(401, 'bad_credentials', '帳號名或密碼錯誤');

  const candidate = await pbkdf2Hex(authKey, user.auth_salt);
  if (candidate !== user.auth_hash) return fail(401, 'bad_credentials', '帳號名或密碼錯誤');

  const tokens = await createSession(env, user.id, typeof input.label === 'string' ? input.label : '', now);
  return ok({ username, ...tokens });
}

export async function handleRefresh(env: Env, body: unknown, now = Date.now()): Promise<ApiReply> {
  if (typeof body !== 'object' || body === null) return fail(400, 'bad_body', '請求格式錯誤');
  const refreshToken = requiredString(body as Record<string, unknown>, 'refreshToken');
  if (!refreshToken) return fail(401, 'bad_refresh', '登入狀態已過期');

  const hash = await sha256Hex(refreshToken);
  const session = await env.DB.prepare(
    'SELECT id, user_id FROM sessions WHERE refresh_hash = ? AND revoked = 0 AND refresh_expires_at > ?',
  )
    .bind(hash, now)
    .first<{ id: string; user_id: string }>();
  if (!session) return fail(401, 'bad_refresh', '登入狀態已過期');

  const accessToken = randomToken();
  const nextRefresh = randomToken();
  await env.DB.prepare(
    'UPDATE sessions SET access_hash = ?, access_expires_at = ?, refresh_hash = ?, refresh_expires_at = ?, last_seen_at = ? WHERE id = ?',
  )
    .bind(
      await sha256Hex(accessToken),
      now + ACCESS_TTL_MS,
      await sha256Hex(nextRefresh),
      now + REFRESH_TTL_MS,
      now,
      session.id,
    )
    .run();

  return ok({ accessToken, refreshToken: nextRefresh });
}

export async function authenticate(
  env: Env,
  authorization: string | null,
  now = Date.now(),
): Promise<{ userId: string; sessionId: string } | null> {
  if (!authorization || !authorization.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length).trim();
  if (!token) return null;
  const session = await env.DB.prepare(
    'SELECT id, user_id FROM sessions WHERE access_hash = ? AND revoked = 0 AND access_expires_at > ?',
  )
    .bind(await sha256Hex(token), now)
    .first<{ id: string; user_id: string }>();
  if (!session) return null;
  return { userId: session.user_id, sessionId: session.id };
}

export async function handleLogout(env: Env, sessionId: string): Promise<ApiReply> {
  await env.DB.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').bind(sessionId).run();
  return ok();
}

export async function handleMe(env: Env, sessionId: string): Promise<ApiReply> {
  const row = await env.DB.prepare(
    'SELECT u.username, u.created_at, u.used_bytes, u.quota_bytes, u.wrapped_dek, u.kdf FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?',
  )
    .bind(sessionId)
    .first<{
      username: string;
      created_at: number;
      used_bytes: number;
      quota_bytes: number;
      wrapped_dek: string;
      kdf: string;
    }>();
  if (!row) return fail(401, 'unauthorized', '請先登入');
  return ok({
    username: row.username,
    createdAt: row.created_at,
    quota: { used: row.used_bytes, limit: row.quota_bytes },
    // 客戶端解 DEK 需要這兩個。wrapped_dek 是被 masterKey 加密過的密文、kdf 只是參數，都不是秘密。
    wrappedDek: row.wrapped_dek,
    kdf: row.kdf,
  });
}

/**
 * 配額扣減：用單一 UPDATE 的條件式寫法（used_bytes + delta <= quota_bytes），
 * 避免「先讀後寫」的競態。超出時回報目前用量讓 UI 顯示。
 */
export async function consumeQuota(
  env: Env,
  userId: string,
  deltaBytes: number,
): Promise<{ allowed: boolean; used: number; limit: number }> {
  const row = await env.DB.prepare(
    'UPDATE users SET used_bytes = used_bytes + ? WHERE id = ? AND used_bytes + ? <= quota_bytes RETURNING used_bytes, quota_bytes',
  )
    .bind(deltaBytes, userId, deltaBytes)
    .first<{ used_bytes: number; quota_bytes: number }>();
  if (row) return { allowed: true, used: row.used_bytes, limit: row.quota_bytes };
  const current = await env.DB.prepare('SELECT used_bytes, quota_bytes FROM users WHERE id = ?')
    .bind(userId)
    .first<{ used_bytes: number; quota_bytes: number }>();
  return { allowed: false, used: current?.used_bytes ?? 0, limit: current?.quota_bytes ?? 0 };
}

/**
 * 已登入裝置列表。只回自己的 session，並標出「就是這台」。
 * 只吐識別與時間，不吐 token 相關的任何雜湊。
 */
export async function handleListDevices(env: Env, userId: string, currentSessionId: string): Promise<ApiReply> {
  const rows = await env.DB.prepare(
    'SELECT id, label, created_at, last_seen_at FROM sessions WHERE user_id = ? AND revoked = 0 ORDER BY last_seen_at DESC LIMIT 50',
  )
    .bind(userId)
    .all<{ id: string; label: string; created_at: number; last_seen_at: number }>();
  return ok({
    devices: rows.results.map((r) => ({
      id: r.id,
      label: r.label || '未命名裝置',
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      current: r.id === currentSessionId,
    })),
  });
}

/** 踢掉一台裝置。只能踢自己的——別人的 session 一律當成不存在（不回 403，避免探測）。 */
export async function handleRevokeDevice(env: Env, userId: string, sessionId: string): Promise<ApiReply> {
  const row = await env.DB.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?')
    .bind(sessionId, userId)
    .first<{ id: string }>();
  if (!row) return fail(404, 'device_not_found', '找不到這台裝置');
  await env.DB.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').bind(sessionId).run();
  return ok({ id: sessionId });
}

/**
 * 改密碼：客戶端用舊 masterKey 解出 DEK、用新密碼重新包好再送過來。
 * 伺服器只驗舊 authKey、換掉雜湊與密文，**不撤銷既有 session**——
 * 其他裝置記憶體裡的 DEK 還有效，能繼續用到下次重新解鎖（spec §9）。
 */
export async function handleChangePassword(env: Env, userId: string, body: unknown): Promise<ApiReply> {
  if (typeof body !== 'object' || body === null) return fail(400, 'bad_body', '請求格式錯誤');
  const input = body as Record<string, unknown>;
  const oldAuthKey = requiredString(input, 'oldAuthKey');
  const newAuthKey = requiredString(input, 'newAuthKey');
  const newKdf = requiredString(input, 'newKdf');
  const newWrappedDek = requiredString(input, 'newWrappedDek');
  const newRecoveryAuthKey = requiredString(input, 'newRecoveryAuthKey');
  const newRecoveryWrappedDek = requiredString(input, 'newRecoveryWrappedDek');
  if (!oldAuthKey || !newAuthKey || !newKdf || !newWrappedDek || !newRecoveryAuthKey || !newRecoveryWrappedDek) {
    return fail(400, 'bad_body', '缺少必要欄位');
  }

  const user = await env.DB.prepare('SELECT auth_hash, auth_salt FROM users WHERE id = ?')
    .bind(userId)
    .first<{ auth_hash: string; auth_salt: string }>();
  if (!user) return fail(401, 'unauthorized', '請先登入');
  if ((await pbkdf2Hex(oldAuthKey, user.auth_salt)) !== user.auth_hash) {
    return fail(401, 'bad_credentials', '目前密碼不正確');
  }

  const authSalt = randomToken(16);
  const recoverySalt = randomToken(16);
  await env.DB.prepare(
    'UPDATE users SET kdf = ?, auth_hash = ?, auth_salt = ?, wrapped_dek = ?, recovery_hash = ?, recovery_salt = ?, recovery_wrapped_dek = ? WHERE id = ?',
  )
    .bind(
      newKdf,
      await pbkdf2Hex(newAuthKey, authSalt),
      authSalt,
      newWrappedDek,
      await pbkdf2Hex(newRecoveryAuthKey, recoverySalt),
      recoverySalt,
      newRecoveryWrappedDek,
      userId,
    )
    .run();

  return ok();
}

/**
 * 救援第一步：用恢復碼的驗證值換一個一次性 resetToken（5 分鐘）。
 * 伺服器不保存恢復碼本身，所以這裡只比對雜湊；帳號不存在與恢復碼錯誤回同一句話。
 */
export async function handleRecoverStart(env: Env, body: unknown, now = Date.now()): Promise<ApiReply> {
  if (typeof body !== 'object' || body === null) return fail(400, 'bad_body', '請求格式錯誤');
  const input = body as Record<string, unknown>;
  const username = normalizeUsername(input.username);
  const recoveryAuthKey = requiredString(input, 'recoveryAuthKey');
  if (!username || !recoveryAuthKey) return fail(401, 'bad_recovery', '帳號名或恢復碼錯誤');

  if (!(await allow(env.DB, `recover:${username}`, 5, 3600, now))) {
    return fail(429, 'rate_limited', '伺服器忙，稍後自動重試');
  }

  const user = await env.DB.prepare('SELECT id, recovery_hash, recovery_salt, recovery_wrapped_dek FROM users WHERE username = ?')
    .bind(username)
    .first<{ id: string; recovery_hash: string; recovery_salt: string; recovery_wrapped_dek: string }>();
  if (!user) return fail(401, 'bad_recovery', '帳號名或恢復碼錯誤');
  if ((await pbkdf2Hex(recoveryAuthKey, user.recovery_salt)) !== user.recovery_hash) {
    return fail(401, 'bad_recovery', '帳號名或恢復碼錯誤');
  }

  const resetToken = randomToken();
  await env.DB.prepare('INSERT INTO resets (token_hash, user_id, expires_at, used) VALUES (?,?,?,0)')
    .bind(await sha256Hex(resetToken), user.id, now + 5 * 60 * 1000)
    .run();

  // recovery_wrapped_dek 是被恢復碼衍生的金鑰加密的密文；客戶端必須拿它才解得出 DEK。
  // 只有「已證明知道恢復碼」的請求才拿得到，所以不構成洩漏。
  return ok({ resetToken, recoveryWrappedDek: user.recovery_wrapped_dek, expiresInSeconds: 300 });
}

/**
 * 救援第二步：用 resetToken 換掉密碼與恢復碼，並**撤銷所有 session**
 * （既然要救援，就當作舊裝置可能已經不可信）。
 */
export async function handleRecoverFinish(env: Env, body: unknown, now = Date.now()): Promise<ApiReply> {
  if (typeof body !== 'object' || body === null) return fail(400, 'bad_body', '請求格式錯誤');
  const input = body as Record<string, unknown>;
  const resetToken = requiredString(input, 'resetToken');
  const newAuthKey = requiredString(input, 'newAuthKey');
  const newKdf = requiredString(input, 'newKdf');
  const newWrappedDek = requiredString(input, 'newWrappedDek');
  const newRecoveryAuthKey = requiredString(input, 'newRecoveryAuthKey');
  const newRecoveryWrappedDek = requiredString(input, 'newRecoveryWrappedDek');
  if (!resetToken || !newAuthKey || !newKdf || !newWrappedDek || !newRecoveryAuthKey || !newRecoveryWrappedDek) {
    return fail(400, 'bad_body', '缺少必要欄位');
  }

  const tokenHash = await sha256Hex(resetToken);
  const reset = await env.DB.prepare('SELECT user_id, expires_at, used FROM resets WHERE token_hash = ?')
    .bind(tokenHash)
    .first<{ user_id: string; expires_at: number; used: number }>();
  if (!reset || reset.used === 1 || reset.expires_at < now) {
    return fail(401, 'bad_reset_token', '救援連結已失效，請重新用恢復碼');
  }

  // 先標記已用（一次性），再改資料
  await env.DB.prepare('UPDATE resets SET used = 1 WHERE token_hash = ?').bind(tokenHash).run();

  const authSalt = randomToken(16);
  const recoverySalt = randomToken(16);
  await env.DB.prepare(
    'UPDATE users SET kdf = ?, auth_hash = ?, auth_salt = ?, wrapped_dek = ?, recovery_hash = ?, recovery_salt = ?, recovery_wrapped_dek = ? WHERE id = ?',
  )
    .bind(
      newKdf,
      await pbkdf2Hex(newAuthKey, authSalt),
      authSalt,
      newWrappedDek,
      await pbkdf2Hex(newRecoveryAuthKey, recoverySalt),
      recoverySalt,
      newRecoveryWrappedDek,
      reset.user_id,
    )
    .run();

  await env.DB.prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ?').bind(reset.user_id).run();
  return ok();
}

/**
 * 管理端產生邀請碼。明文碼只在回應裡出現一次，資料庫只存 sha256。
 * 呼叫端（router）必須先驗 x-admin-secret。
 */
export async function handleCreateInvite(
  env: Env,
  adminSecret: string | null,
  body: unknown,
): Promise<ApiReply> {
  if (!adminSecret || adminSecret !== env.ADMIN_SECRET) {
    return fail(401, 'unauthorized', '請先登入');
  }
  const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const note = typeof input.note === 'string' ? input.note : null;
  const ttlDays = typeof input.ttlDays === 'number' ? input.ttlDays : null;
  const now = Date.now();

  const raw = randomToken(9)
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .padEnd(12, 'X')
    .slice(0, 12);
  const code = `INV-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  const expiresAt = ttlDays === null ? null : now + ttlDays * 86400000;

  await env.DB.prepare('INSERT INTO invites (code_hash, note, created_at, expires_at, used_by, used_at) VALUES (?,?,?,?,NULL,NULL)')
    .bind(await sha256Hex(code), note, now, expiresAt)
    .run();

  return ok({ code, note, expiresAt });
}
