import type { DshDB } from '../storage/db';
import { BLOB_INLINE_LIMIT, blobIdFor, decryptBlob, encryptBlob } from './blob';
import { readRowForSync, type EngineContext } from './engine';
import { setApplyingRemote } from './outbox';
import type { SyncKind } from './kinds';

/**
 * 一次同步最多搬幾個 blob。
 * KV 免費方案每日只有 1,000 次寫入，這個上限讓「一次同步」不會吃掉整天額度。
 */
export const MAX_BLOB_BATCH = 20;

/** 進行中的上傳（key = db|kind|id），避免同一個 blob 被併發上傳 */
const inFlightUploads = new Map<string, Promise<{ blobId: string; fileKey: string; size: number } | null>>();

/** 只有這兩種 kind 會走 blob：素材圖（二進位）與卡片檔案（互動頁 HTML 可達 1.25 MiB） */
export function isBlobBackedKind(kind: SyncKind): boolean {
  return kind === 'assetMeta' || kind === 'cardFile';
}

export async function plaintextOf(
  db: DshDB,
  kind: SyncKind,
  id: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!isBlobBackedKind(kind)) return null;
  const row = await readRowForSync(db, kind, id);
  if (!row) return null;
  if (kind === 'assetMeta') {
    const bytes = row.bytes as ArrayBuffer | undefined;
    return bytes ? new Uint8Array(bytes) : null;
  }
  const text = row.text as string | undefined;
  return typeof text === 'string' ? new TextEncoder().encode(text) : null;
}

/** 這一筆該不該走 blob（> 256 KiB 的文本、或任何二進位） */
export function needsBlob(kind: SyncKind, plaintext: Uint8Array): boolean {
  return kind === 'assetMeta' || plaintext.byteLength > BLOB_INLINE_LIMIT;
}

/**
 * 確保 blob 已經在雲端，回傳信封要帶的 blobRef 與 __fileKey。
 * 已上傳過就直接重用既有的 fileKey（重試必須產生同一份密文，否則先前推上去的信封解不開）。
 */
export async function ensureBlobUploaded(
  ctx: EngineContext,
  kind: SyncKind,
  id: string,
): Promise<{ blobId: string; fileKey: string; size: number } | null> {
  // 同一個 blob 的上傳去重：兩次同步重疊時，不要對同一個 KV key 併發寫入
  // （Cloudflare KV 對「同一個 key」限制每秒 1 次寫入，撞到會直接失敗）
  const key = `${ctx.db.name}|${kind}|${id}`;
  const running = inFlightUploads.get(key);
  if (running) return running;
  const task = uploadBlob(ctx, kind, id).finally(() => inFlightUploads.delete(key));
  inFlightUploads.set(key, task);
  return task;
}

async function uploadBlob(
  ctx: EngineContext,
  kind: SyncKind,
  id: string,
): Promise<{ blobId: string; fileKey: string; size: number } | null> {
  const plaintext = await plaintextOf(ctx.db, kind, id);
  if (!plaintext) return null;
  const blobId = await blobIdFor(plaintext);

  const existing = await ctx.db.blobState.get(blobId);
  if (existing?.state === 'uploaded' && existing.fileKey) {
    return { blobId, fileKey: existing.fileKey, size: plaintext.byteLength };
  }

  const { fileKey, body } = await encryptBlob(ctx.dek, blobId, plaintext);
  await ctx.client.putBlob(blobId, body);
  await ctx.db.blobState.put({ blobId, state: 'uploaded', refId: id, size: plaintext.byteLength, fileKey });
  return { blobId, fileKey, size: plaintext.byteLength };
}

/**
 * 把遠端的 blob 抓回本地並解密寫進原表。
 * 'have' = 本地已有、'fetched' = 這次抓到了、'pending' = KV 還沒傳播（最終一致）→ 呼叫端稍後重試。
 */
export async function ensureBlobLocal(
  ctx: EngineContext,
  kind: SyncKind,
  id: string,
): Promise<'have' | 'fetched' | 'pending'> {
  if (!isBlobBackedKind(kind)) return 'have';

  const plaintext = await plaintextOf(ctx.db, kind, id);
  if (plaintext && plaintext.byteLength > 0) return 'have';

  const state = (await ctx.db.blobState.toArray()).find((s) => s.refId === id && s.blobId);
  if (!state?.fileKey) return 'pending';

  const body = await ctx.client.getBlob(state.blobId);
  if (!body) return 'pending';

  const row = await readRowForSync(ctx.db, kind, id);
  if (!row) return 'pending';

  // getBlob 的 Uint8Array 泛型是 ArrayBufferLike，而 decryptBlob 收 Uint8Array<ArrayBuffer>（TS 5.7 的 BufferSource 限制）
  const copy = new Uint8Array(body);
  const plain = await decryptBlob(ctx.dek, state.blobId, state.fileKey, copy);
  setApplyingRemote(true);
  try {
    if (kind === 'assetMeta') {
      await ctx.db.table('assets').put({ ...row, bytes: plain.buffer, size: plain.byteLength });
    } else {
      await ctx.db.table('cardFiles').put({ ...row, text: new TextDecoder().decode(plain) });
    }
    await ctx.db.blobState.put({ ...state, state: 'uploaded', size: plain.byteLength });
  } finally {
    setApplyingRemote(false);
  }
  return 'fetched';
}
