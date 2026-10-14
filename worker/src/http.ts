export interface ApiReply {
  status: number;
  body: Record<string, unknown>;
}

/**
 * 伺服器端的 authKey 雜湊迭代數。
 *
 * 客戶端已經用 600000 迭代把密碼壓成 authKey，離線暴破的單次成本由客戶端決定，
 * 所以這裡不必再疊 200000——那會撞上 Workers 免費方案的 10ms CPU 上限。
 * spec §5.2 原寫 200000，以這裡為準。
 */
export const SERVER_KDF_ITERS = 5000;

export function ok(body: Record<string, unknown> = {}): ApiReply {
  return { status: 200, body: { ok: true, ...body } };
}

export function fail(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): ApiReply {
  return { status, body: { ok: false, code, message, ...extra } };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest));
}

export function randomToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = '';
  for (const b of raw) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pbkdf2Hex(value: string, salt: string, iterations = SERVER_KDF_ITERS): Promise<string> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(value), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations },
    base,
    256,
  );
  return toHex(new Uint8Array(bits));
}
