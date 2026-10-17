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

/** 一次同步最多把幾顆「舊格式/壞掉」的 blob 改成 v2 並覆寫雲端（修復用，別一次吃掉太多流量） */
export const MAX_BLOB_MIGRATE = 6;

/** 進行中的上傳（key = db|kind|id），避免同一個 blob 被併發上傳 */
const inFlightUploads = new Map<string, Promise<{ blobId: string; size: number } | null>>();

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
 * 確保 blob 已經在雲端，回傳信封要帶的 blobRef。
 * v2 之後檔案金鑰由 DEK+blobId 決定性推導，信封不再需要 __fileKey。
 */
export async function ensureBlobUploaded(
  ctx: EngineContext,
  kind: SyncKind,
  id: string,
): Promise<{ blobId: string; size: number } | null> {
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
): Promise<{ blobId: string; size: number } | null> {
  const plaintext = await plaintextOf(ctx.db, kind, id);
  if (!plaintext) return null;
  const blobId = await blobIdFor(plaintext);

  const existing = await ctx.db.blobState.get(blobId);
  if (existing?.state === 'uploaded') {
    // 已上傳過：直接重用同一個 blobId（v2 金鑰是推導出來的，不需要保存）
    return { blobId, size: plaintext.byteLength };
  }

  // 一律 v2 加密 + **覆寫**雲端那顆 blob。
  // 為什麼要覆寫：blobId 是內容定址，雲端可能早就有一份（別台裝置/舊版本上傳）。
  // 以前只 dedupe 不覆寫，信封裡的鑰匙就會跟 KV 裡的密文版本對不上 →
  // 之後任何裝置拉這顆 blob 都真的解不開（OperationError）。覆寫讓「最後一次推送」
  // 永遠對應 KV 裡真正的密文；同內容的金鑰是決定性的，其他裝置也解得開。
  const { body } = await encryptBlob(ctx.dek, blobId, plaintext);
  await ctx.client.putBlob(blobId, body, { replace: true });
  await ctx.db.blobState.put({
    blobId,
    kind: kind as 'assetMeta' | 'cardFile',
    state: 'uploaded',
    refId: id,
    size: plaintext.byteLength,
  });
  return { blobId, size: plaintext.byteLength };
}

/**
 * 把遠端的 blob 抓回本地並解密寫進原表。
 * 'have' = 本地已有、'fetched' = 這次抓到了、'pending' = KV 還沒傳播（最終一致）→ 稍後重試、
 * 'broken' = 雲端那份解不開（舊版同步遺留）→ 跳過，**不要拖垮整次同步**。
 */
export async function ensureBlobLocal(
  ctx: EngineContext,
  kind: SyncKind,
  id: string,
): Promise<'have' | 'fetched' | 'pending' | 'broken'> {
  if (!isBlobBackedKind(kind)) return 'have';

  const plaintext = await plaintextOf(ctx.db, kind, id);
  if (plaintext && plaintext.byteLength > 0) return 'have';

  const state = (await ctx.db.blobState.where('refId').equals(id).toArray()).find((s) => s.blobId);
  if (!state) return 'pending';

  const body = await ctx.client.getBlob(state.blobId);
  if (!body) return 'pending';

  const row = await readRowForSync(ctx.db, kind, id);
  if (!row) return 'pending';

  // getBlob 的 Uint8Array 泛型是 ArrayBufferLike，而 decryptBlob 收 Uint8Array<ArrayBuffer>（TS 5.7 的 BufferSource 限制）
  const copy = new Uint8Array(body);
  let plain: Uint8Array<ArrayBuffer>;
  try {
    // decryptBlob 會先試舊格式（信封帶的隨機 fileKey），再試 v2 決定性金鑰
    plain = await decryptBlob(ctx.dek, state.blobId, copy, state.fileKey);
  } catch {
    // 壞資料不該讓整次 sync 失敗（以前就是這樣：一個舊 blob 解不開 → 「同步失敗」+ 一句看不懂的
    // OperationError，其他資料也跟著永遠同步不了）。標記 broken、跳過，UI 會提示。
    console.warn('[sync] blob 解密失敗，已跳過（可能是舊版同步遺留的壞資料）', {
      kind, id, blobIdPrefix: state.blobId.slice(0, 10), legacyFileKey: Boolean(state.fileKey),
    });
    await ctx.db.blobState.put({ ...state, state: 'broken' });
    return 'broken';
  }

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

/**
 * 把「舊格式（隨機 fileKey）或壞掉」的 blob 換成 v2 決定性金鑰，並覆寫雲端密文。
 *
 * 觸發對象：
 * - `uploaded` 但還帶著舊 fileKey → 舊版上傳，密文/鑰匙可能對不上；
 * - `remote` 但本地已有明文 → 拉取時留下的參照，本地內容可以拿來修復雲端；
 * - `broken` 但本地有明文 → 直接重推一份好的上去。
 *
 * 只處理本地真的有明文的 blob（沒明文就無從修復），一次最多 MAX_BLOB_MIGRATE 顆。
 */
export async function migrateBlobKeys(ctx: EngineContext): Promise<{ repaired: number; pending: number }> {
  const rows = await ctx.db.blobState.toArray();
  const candidates = rows
    .filter((s) => s.kind && (s.state === 'broken' || s.state === 'remote' || (s.state === 'uploaded' && Boolean(s.fileKey))))
    .slice(0, MAX_BLOB_MIGRATE);

  let repaired = 0;
  for (const state of candidates) {
    const plain = await plaintextOf(ctx.db, state.kind!, state.refId);
    if (!plain || plain.byteLength === 0) continue;
    const blobId = await blobIdFor(plain);
    if (blobId !== state.blobId) continue; // 參照過期（內容換過了），留給 outbox 重推
    try {
      const { body } = await encryptBlob(ctx.dek, blobId, plain);
      await ctx.client.putBlob(blobId, body, { replace: true });
      await ctx.db.blobState.put({
        blobId,
        kind: state.kind,
        state: 'uploaded',
        refId: state.refId,
        size: plain.byteLength,
      });
      repaired += 1;
    } catch {
      // 連不上或 KV 暫時失敗：下次同步再試
    }
  }
  return { repaired, pending: Math.max(0, candidates.length - repaired) };
}