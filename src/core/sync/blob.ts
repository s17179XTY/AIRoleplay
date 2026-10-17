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

/**
 * v2 的檔案金鑰：由 DEK + blobId **決定性推導**（HKDF-SHA256），不再每次上傳隨機產生。
 *
 * 為什麼要改：blobId 是內容定址，伺服器對同一份內容只會保留第一份密文（dedupe）。
 * 舊版每次重傳都換一把隨機 fileKey，一旦「KV 已寫入、但本機 blobState 沒存到」或
 * 「另一台裝置重新推同一份內容」，信封裡的新鑰匙就對不上 KV 裡的舊密文 ——
 * 之後任何裝置拉這顆 blob 都會拋 OperationError（The operation failed for an
 * operation-specific reason），整次同步直接失敗。
 *
 * 決定性推導讓「同一份內容永遠同一把鑰匙」：重傳、換裝置、清掉本機資料後重推都不會再對不上。
 * 舊資料的隨機 fileKey 仍在信封裡，decryptBlob 會先試舊格式、失敗再試 v2（見下）。
 */
async function deriveFileKey(dek: CryptoKey, blobId: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.exportKey('raw', dek);
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8('dsh-blob-filekey-v2|' + blobId), info: utf8('dsh-blob-aes-gcm') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function splitBody(body: Uint8Array<ArrayBuffer>): { iv: Uint8Array<ArrayBuffer>; ct: Uint8Array<ArrayBuffer> } {
  const head = body.slice(0, BLOB_MAGIC.length);
  if (new TextDecoder().decode(head) !== BLOB_MAGIC) throw new Error('blob 格式不符');
  return {
    iv: body.slice(BLOB_MAGIC.length, BLOB_MAGIC.length + IV_BYTES),
    ct: body.slice(BLOB_MAGIC.length + IV_BYTES),
  };
}

export interface EncryptedBlob {
  body: Uint8Array<ArrayBuffer>;
  /** 只有舊格式（legacy）才會回傳：用 DEK 包好的隨機檔案金鑰 */
  fileKey?: string;
}

/**
 * 加密 blob。
 * - 預設 v2：金鑰由 DEK+blobId 推導（不再需要把 fileKey 放進信封）。
 * - `{ legacy: true }` 只給「讀舊資料的測試」與極舊格式相容用。
 */
export async function encryptBlob(
  dek: CryptoKey,
  blobId: string,
  plain: Uint8Array<ArrayBuffer>,
  opts: { legacy?: boolean } = {},
): Promise<EncryptedBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

  if (opts.legacy) {
    const fileKeyRaw = crypto.getRandomValues(new Uint8Array(32));
    const fileKey = await crypto.subtle.importKey('raw', fileKeyRaw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(blobId) }, fileKey, plain));
    const wrapIv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, dek, fileKeyRaw));
    return {
      fileKey: toBase64Url(concatBytes(wrapIv, wrapped)),
      body: concatBytes(utf8(BLOB_MAGIC), iv, ct),
    };
  }

  const key = await deriveFileKey(dek, blobId);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(blobId) }, key, plain));
  return { body: concatBytes(utf8(BLOB_MAGIC), iv, ct) };
}

/** 雲端素材解不開：不是「網路問題」，而是舊版同步留下的壞資料。呼叫端應跳過、不要讓整次同步失敗。 */
export class BlobDecryptError extends Error {
  constructor(public readonly blobId: string, cause?: unknown) {
    super('云端素材解密失败：可能是旧版本同步留下的坏数据（重新上传/重推一次即可修复）');
    this.name = 'BlobDecryptError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * 解密 blob。先試信封帶的舊格式隨機金鑰（如果有），再試 v2 決定性金鑰。
 * 兩種都失敗才拋 `BlobDecryptError`（呼叫端要接住，標成 broken 繼續同步）。
 */
export async function decryptBlob(
  dek: CryptoKey,
  blobId: string,
  body: Uint8Array<ArrayBuffer>,
  fileKey?: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const { iv, ct } = splitBody(body);
  const attempts: Array<() => Promise<CryptoKey>> = [];

  if (fileKey) {
    attempts.push(async () => {
      const wrapped = fromBase64Url(fileKey);
      const wrapIv = wrapped.slice(0, IV_BYTES);
      const wrappedKey = wrapped.slice(IV_BYTES);
      const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: wrapIv }, dek, wrappedKey));
      return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
    });
  }
  attempts.push(() => deriveFileKey(dek, blobId));

  let lastError: unknown = null;
  for (const resolveKey of attempts) {
    try {
      const key = await resolveKey();
      const plain = new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: utf8(blobId) }, key, ct),
      );
      const actual = await blobIdFor(plain);
      if (actual !== blobId) throw new Error('blob 內容與 id 不符');
      return plain;
    } catch (err) {
      lastError = err;
    }
  }
  throw new BlobDecryptError(blobId, lastError);
}
