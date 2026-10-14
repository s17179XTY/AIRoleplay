import { utf8, toBase64Url, fromBase64Url, concatBytes } from './bytes';

export const BLOB_INLINE_LIMIT = 262144; // 256 KiB
export const BLOB_MAGIC = 'DSHB1';
const IV_BYTES = 12;

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** 內容定址：同內容同 id，天然去重也免衝突 */
export async function blobIdFor(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return toBase64Url(await sha256(bytes));
}

export async function encryptBlob(
  dek: CryptoKey,
  blobId: string,
  plain: Uint8Array<ArrayBuffer>,
): Promise<{ fileKey: string; body: Uint8Array<ArrayBuffer> }> {
  const fileKeyRaw = crypto.getRandomValues(new Uint8Array(32));
  const fileKey = await crypto.subtle.importKey('raw', fileKeyRaw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(blobId) }, fileKey, plain),
  );
  const body = concatBytes(utf8(BLOB_MAGIC), iv, ct);

  const wrapIv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, dek, fileKeyRaw));
  return { fileKey: toBase64Url(concatBytes(wrapIv, wrapped)), body };
}

export async function decryptBlob(
  dek: CryptoKey,
  blobId: string,
  fileKey: string,
  body: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const head = body.slice(0, BLOB_MAGIC.length);
  if (new TextDecoder().decode(head) !== BLOB_MAGIC) throw new Error('blob 格式不符');
  const iv = body.slice(BLOB_MAGIC.length, BLOB_MAGIC.length + IV_BYTES);
  const ct = body.slice(BLOB_MAGIC.length + IV_BYTES);

  const wrapped = fromBase64Url(fileKey);
  const wrapIv = wrapped.slice(0, IV_BYTES);
  const wrappedKey = wrapped.slice(IV_BYTES);
  const fileKeyRaw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: wrapIv }, dek, wrappedKey));
  const key = await crypto.subtle.importKey('raw', fileKeyRaw, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: utf8(blobId) }, key, ct),
  );
  const actual = await blobIdFor(plain);
  if (actual !== blobId) throw new Error('blob 內容與 id 不符');
  return plain;
}
