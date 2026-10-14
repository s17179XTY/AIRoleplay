import { utf8, fromUtf8, toBase64Url, fromBase64Url, toHex, concatBytes } from './bytes';

export interface Envelope<T = unknown> {
  v: 1;
  rev: number;
  updatedAt: number;
  deviceId: string;
  data: T;
}

const IV_BYTES = 12;

export async function generateDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function exportDekRaw(dek: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', dek));
}

export async function importDekRaw(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

// AAD 綁定 kind 與 id：把某筆記錄的密文搬到別的 id（或別的類型）底下就解不開。
function aad(kind: string, id: string): Uint8Array<ArrayBuffer> {
  return utf8(`${kind}|${id}`);
}

export async function wrapDek(dek: CryptoKey, wrappingKey: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const raw = await exportDekRaw(dek);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, raw));
  return toBase64Url(concatBytes(iv, ct));
}

export async function unwrapDek(wrapped: string, wrappingKey: CryptoKey): Promise<CryptoKey> {
  const all = fromBase64Url(wrapped);
  const iv = all.slice(0, IV_BYTES);
  const ct = all.slice(IV_BYTES);
  const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrappingKey, ct));
  return importDekRaw(raw);
}

export async function encryptEnvelope(dek: CryptoKey, kind: string, id: string, env: Envelope): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(kind, id) }, dek, utf8(JSON.stringify(env))),
  );
  return toBase64Url(concatBytes(iv, ct));
}

export async function decryptEnvelope<T = unknown>(
  dek: CryptoKey,
  kind: string,
  id: string,
  ciphertext: string,
): Promise<Envelope<T>> {
  const all = fromBase64Url(ciphertext);
  const iv = all.slice(0, IV_BYTES);
  const ct = all.slice(IV_BYTES);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(kind, id) }, dek, ct),
  );
  return JSON.parse(fromUtf8(plain)) as Envelope<T>;
}

export async function dekFingerprint(dek: CryptoKey): Promise<string> {
  const raw = await exportDekRaw(dek);
  const digest = await crypto.subtle.digest('SHA-256', raw);
  return toHex(new Uint8Array(digest));
}
