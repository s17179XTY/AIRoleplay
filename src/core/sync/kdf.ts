import { utf8, toBase64Url } from './bytes';

export interface KdfParams {
  algo: 'PBKDF2-SHA256';
  iters: number;
  v: 1;
}

export const PROD_KDF: KdfParams = { algo: 'PBKDF2-SHA256', iters: 600000, v: 1 };
export const TEST_KDF: KdfParams = { algo: 'PBKDF2-SHA256', iters: 1000, v: 1 };
export const RECOVERY_ITERS = 200000;

type SaltPurpose = 'auth' | 'enc' | 'recauth' | 'recwrap';

function saltFor(purpose: SaltPurpose, username: string): Uint8Array<ArrayBuffer> {
  return utf8(`dsh1|${purpose}|${username.toLowerCase()}`);
}

async function deriveBits(password: string, salt: Uint8Array<ArrayBuffer>, iters: number): Promise<Uint8Array<ArrayBuffer>> {
  const base = await crypto.subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iters },
    base,
    256,
  );
  return new Uint8Array(bits);
}

export async function deriveAuthKey(password: string, username: string, kdf: KdfParams): Promise<string> {
  return toBase64Url(await deriveBits(password, saltFor('auth', username), kdf.iters));
}

export async function deriveMasterKey(password: string, username: string, kdf: KdfParams): Promise<CryptoKey> {
  const raw = await deriveBits(password, saltFor('enc', username), kdf.iters);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Crockford Base32：去掉 I / L / O / U，避免抄錯。
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateRecoveryCode(): string {
  // 256 能被 32 整除，所以 % 32 是均勻分佈，不需要拒絕取樣。
  const raw = new Uint8Array(52);
  crypto.getRandomValues(raw);
  let out = '';
  for (let i = 0; i < raw.length; i++) out += CROCKFORD[raw[i] % 32];
  return out;
}

export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
}

export function formatRecoveryCode(code: string): string {
  return normalizeRecoveryCode(code).replace(/(.{4})(?=.)/g, '$1-');
}

export async function deriveRecoveryAuthKey(code: string, username: string): Promise<string> {
  return toBase64Url(await deriveBits(normalizeRecoveryCode(code), saltFor('recauth', username), RECOVERY_ITERS));
}

export async function deriveRecoveryKey(code: string, username: string): Promise<CryptoKey> {
  const raw = await deriveBits(normalizeRecoveryCode(code), saltFor('recwrap', username), RECOVERY_ITERS);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
