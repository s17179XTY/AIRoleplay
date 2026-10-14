import type { Tokens } from './client';

const TOKEN_KEY = 'dsh-sync-tokens';
const USER_KEY = 'dsh-sync-user';

export function loadTokens(): Tokens | null {
  try {
    const raw = globalThis.localStorage?.getItem(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { accessToken?: string; refreshToken?: string };
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
  } catch {
    return null;
  }
}

export function saveTokens(tokens: Tokens | null): void {
  try {
    if (!tokens) globalThis.localStorage?.removeItem(TOKEN_KEY);
    else globalThis.localStorage?.setItem(TOKEN_KEY, JSON.stringify(tokens));
  } catch {
    // localStorage 被禁用（隱私模式）：當成沒登入，不讓它炸掉整個 app
  }
}

/**
 * 記住帳號名。重新載入頁面後 token 還在、但 DEK 只存在記憶體裡，
 * 需要知道「是誰」才能提示使用者輸入密碼解鎖（見 useSync 的 locked 狀態）。
 */
export function loadUsername(): string | null {
  try {
    return globalThis.localStorage?.getItem(USER_KEY) ?? null;
  } catch {
    return null;
  }
}

export function saveUsername(username: string | null): void {
  try {
    if (!username) globalThis.localStorage?.removeItem(USER_KEY);
    else globalThis.localStorage?.setItem(USER_KEY, username);
  } catch {
    // 同上
  }
}

/** 後端位址。沒設定就回空字串，UI 顯示「這個版本沒有連線後端」而不是亂打請求。 */
export function syncApiBaseUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const raw = env?.VITE_SYNC_API ?? '';
  return raw.trim().replace(/\/+$/, '');
}

/**
 * 記住這個帳號用的 KDF 參數。
 * 登入時客戶端必須先知道迭代數才能算出 authKey，而伺服器不可能告訴未認證的人——
 * 所以同一台裝置登入過一次就記下來，新裝置預設用 PROD_KDF（登入成功後以 /api/me 回傳的為準）。
 */
export function loadKdf(username: string): { algo: 'PBKDF2-SHA256'; iters: number; v: 1 } | null {
  try {
    const raw = globalThis.localStorage?.getItem(`dsh-sync-kdf:${username.toLowerCase()}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { algo?: string; iters?: number; v?: number };
    if (parsed.algo !== 'PBKDF2-SHA256' || typeof parsed.iters !== 'number' || parsed.v !== 1) return null;
    return { algo: 'PBKDF2-SHA256', iters: parsed.iters, v: 1 };
  } catch {
    return null;
  }
}

export function saveKdf(username: string, kdf: { algo: string; iters: number; v: number }): void {
  try {
    globalThis.localStorage?.setItem(`dsh-sync-kdf:${username.toLowerCase()}`, JSON.stringify(kdf));
  } catch {
    // 同上
  }
}
