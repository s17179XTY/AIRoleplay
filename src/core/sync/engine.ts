import type { DshDB } from '../storage/db';
import { decryptEnvelope, encryptEnvelope, type Envelope } from './envelope';
import { keyOf, mergeRemoteRow, SYNC_TABLES, sanitizeForSync, type SyncKind } from './kinds';
import { clearOutbox, setApplyingRemote, takeOutbox, type OutboxEntry } from './outbox';
import {
  ensureBlobLocal, ensureBlobUploaded, MAX_BLOB_BATCH, migrateBlobKeys, needsBlob, plaintextOf,
} from './blobs';
import type { PulledRecord, SyncClient } from './client';

export interface EngineContext {
  db: DshDB;
  client: SyncClient;
  dek: CryptoKey;
  deviceId: string;
}

/** 與 worker 的 MAX_PUSH_BATCH 對齊：超過就會被伺服器拒收 */
export const PUSH_BATCH = 20;

export async function getSyncState(ctx: EngineContext): Promise<{ cursor: number; deviceId: string }> {
  const stored = await ctx.db.syncState.get('deviceId');
  if (!stored) await ctx.db.syncState.put({ key: 'deviceId', value: ctx.deviceId });
  const cursor = await ctx.db.syncState.get('cursor');
  return { cursor: Number(cursor?.value ?? 0), deviceId: ctx.deviceId };
}

export async function readRowForSync(
  db: DshDB,
  kind: SyncKind,
  id: string,
): Promise<Record<string, unknown> | null> {
  const table = db.table(SYNC_TABLES[kind]);
  if (kind === 'cardFile' || kind === 'cardUiState') {
    // id 是「主鍵:次鍵」拼出來的（見 kinds.keyOf）
    const at = id.indexOf(':');
    const row = await table.get([id.slice(0, at), id.slice(at + 1)]);
    return (row as Record<string, unknown>) ?? null;
  }
  const row = await table.get(id);
  return (row as Record<string, unknown>) ?? null;
}

/** 讀取這筆記錄已經同步到的版本（沒推過就是 0） */
export async function getRev(db: DshDB, kind: SyncKind, id: string): Promise<number> {
  const row = await db.syncRev.get([kind, id]);
  return row?.rev ?? 0;
}

export async function setRev(db: DshDB, kind: SyncKind, id: string, rev: number): Promise<void> {
  await db.syncRev.put({ kind, id, rev });
}

/**
 * 把 outbox 裡的一批變更加密後推上雲。
 * - 未推送過的記錄 baseRev = 0；已推送過的用本地 __rev 當 baseRev
 * - 伺服器回報衝突時，把被覆蓋的版本解密後存進 syncConflicts（本地留副本，不靜默丟資料）
 */
export async function pushPending(
  ctx: EngineContext,
  opts: { batch?: number } = {},
): Promise<{ pushed: number; conflicts: number }> {
  const entries = await takeOutbox(opts.batch ?? PUSH_BATCH, ctx.db);
  if (entries.length === 0) return { pushed: 0, conflicts: 0 };

  const payloadRecords: Array<Record<string, unknown>> = [];
  const sent: OutboxEntry[] = [];

  for (const entry of entries) {
    if (entry.deleted === 1) {
      payloadRecords.push({
        kind: entry.kind,
        id: entry.id,
        rev: 0,
        baseRev: 0,
        updatedAt: Date.now(),
        deleted: true,
        size: 0,
      });
      sent.push(entry);
      continue;
    }

    const row = await readRowForSync(ctx.db, entry.kind, entry.id);
    if (!row) {
      // 本地已經沒有這筆（先建後刪）：直接送墓碑
      payloadRecords.push({
        kind: entry.kind,
        id: entry.id,
        rev: 0,
        baseRev: 0,
        updatedAt: Date.now(),
        deleted: true,
        size: 0,
      });
      sent.push(entry);
      continue;
    }

    const baseRev = await getRev(ctx.db, entry.kind, entry.id);
    const rev = baseRev + 1;

    // 大檔／二進位先確保 blob 已經在雲端，信封只帶 blobRef 與（用 DEK 包好的）fileKey
    const plaintext = await plaintextOf(ctx.db, entry.kind, entry.id);
    const blob = plaintext && needsBlob(entry.kind, plaintext) ? await ensureBlobUploaded(ctx, entry.kind, entry.id) : null;

    const data = sanitizeForSync(entry.kind, row);
    if (blob) {
      // v2 的檔案金鑰由 DEK+blobId 決定性推導，信封不需要再帶 __fileKey
      delete data.__fileKey;
      // 內容已經在 blob 裡，信封不能再帶一份——否則又會撞上 D1 單行 2 MB / 我們自己 256 KiB 的上限
      delete data.text;
      delete data.bytes;
    }

    const envelope: Envelope = {
      v: 1,
      rev,
      updatedAt: Date.now(),
      deviceId: ctx.deviceId,
      data,
    };
    const ciphertext = await encryptEnvelope(ctx.dek, entry.kind, entry.id, envelope);
    payloadRecords.push({
      kind: entry.kind,
      id: entry.id,
      rev,
      baseRev,
      updatedAt: envelope.updatedAt,
      size: ciphertext.length,
      ciphertext,
      blobRef: blob?.blobId,
    });
    sent.push(entry);
  }

  const result = await ctx.client.push({ records: payloadRecords as never });

  const revByKey = new Map(result.accepted.map((a) => [`${a.kind}|${a.id}`, a.rev]));
  for (const entry of sent) {
    const rev = revByKey.get(`${entry.kind}|${entry.id}`);
    if (rev !== undefined && entry.deleted === 0) {
      await setRev(ctx.db, entry.kind, entry.id, rev);
    }
  }

  for (const conflict of result.conflicts) {
    // 超過 64 KiB 的衝突版本伺服器不會回傳內容，只回報
    if (!conflict.serverCiphertext) continue;
    try {
      const decoded = await decryptEnvelope(ctx.dek, conflict.kind, conflict.id, conflict.serverCiphertext);
      await ctx.db.syncConflicts.add({
        kind: conflict.kind,
        id: conflict.id,
        rev: conflict.serverRev,
        updatedAt: decoded.updatedAt,
        ciphertext: conflict.serverCiphertext,
        detectedAt: Date.now(),
      });
    } catch {
      // 解不開的衝突版本直接跳過：不讓一個壞信封卡住整批同步
    }
  }

  await clearOutbox(sent, ctx.db);
  await ctx.db.syncState.put({ key: 'lastPushAt', value: String(Date.now()) });
  return { pushed: sent.length, conflicts: result.conflicts.length };
}

/**
 * 把伺服器上的一筆變更套用到本地。
 * 套用期間打開 applyingRemote，否則「套用遠端 → 產生本地變更 → 又被推回雲端」會無限迴圈。
 */
export async function applyRemoteRecord(
  ctx: EngineContext,
  record: PulledRecord,
): Promise<'applied' | 'deleted' | 'skipped'> {
  const kind = record.kind as SyncKind;
  const table = ctx.db.table(SYNC_TABLES[kind]);
  if (!table) return 'skipped';

  if (record.deleted) {
    setApplyingRemote(true);
    try {
      if (kind === 'cardFile' || kind === 'cardUiState') {
        const at = record.id.indexOf(':');
        await table.delete([record.id.slice(0, at), record.id.slice(at + 1)]);
      } else {
        await table.delete(record.id);
      }
      // 墓碑也要清掉版本紀錄，否則之後重建同一筆會被當成舊版本
      await ctx.db.syncRev.delete([kind, record.id]);
    } finally {
      setApplyingRemote(false);
    }
    return 'deleted';
  }

  if (!record.ciphertext) return 'skipped';

  let envelope: Envelope<Record<string, unknown>>;
  try {
    envelope = await decryptEnvelope<Record<string, unknown>>(ctx.dek, record.kind, record.id, record.ciphertext);
  } catch {
    // 解不開（別的帳號的庫、或金鑰不符）：這一筆跳過，讓 UI 去顯示「資料屬於其他帳號」
    return 'skipped';
  }

  const remote = { ...envelope.data } as Record<string, unknown>;
  // __fileKey 只是信封的傳輸欄位，不該落地到正常資料表
  delete remote.__fileKey;
  // 遠端信封不含祕密與已走 blob 的本體：以本地現有的列為底合併，否則會把本地資料抹掉
  const local = (await readRowForSync(ctx.db, kind, record.id)) as Record<string, unknown> | null;
  const row = mergeRemoteRow(kind, remote, local);
  setApplyingRemote(true);
  try {
    await table.put(row);
    await ctx.db.syncRev.put({ kind, id: record.id, rev: record.rev ?? envelope.rev });
  } finally {
    setApplyingRemote(false);
  }

  if (record.blobRef) {
    const existing = await ctx.db.blobState.get(record.blobRef);
    const fileKey = (envelope.data as { __fileKey?: string }).__fileKey;
    await ctx.db.blobState.put({
      blobId: record.blobRef,
      kind: kind === 'assetMeta' || kind === 'cardFile' ? kind : undefined,
      // 本機已經上傳過的 blob 不能因為拉到自己推上去的信封就被降級成 remote：
      // 那會讓每一輪同步都以為「還沒上傳」，再重傳一次（KV 寫入翻倍、還會讓額度更快用完）。
      state: existing?.state === 'uploaded' ? 'uploaded' : 'remote',
      refId: record.id,
      size: record.size ?? 0,
      // 本地已有的 fileKey 優先保留：拉到的信封若沒帶（舊資料）也不能把能用的鑰匙弄丟
      fileKey: fileKey ?? existing?.fileKey,
    });
  }
  return 'applied';
}

export async function pullChanges(
  ctx: EngineContext,
  opts: { maxPages?: number } = {},
): Promise<{
  applied: number;
  cursor: number;
  blobs: { fetched: number; pending: number; broken: number; repaired: number };
}> {
  const maxPages = opts.maxPages ?? 20;
  let cursor = (await getSyncState(ctx)).cursor;
  let applied = 0;

  for (let page = 0; page < maxPages; page++) {
    const result = await ctx.client.pull(cursor);
    for (const record of result.records) {
      const outcome = await applyRemoteRecord(ctx, record);
      if (outcome === 'applied') applied += 1;
    }
    cursor = result.cursor;
    await ctx.db.syncState.put({ key: 'cursor', value: String(cursor) });
    await ctx.db.syncState.put({ key: 'quotaUsed', value: String(result.quota.used) });
    await ctx.db.syncState.put({ key: 'quotaLimit', value: String(result.quota.limit) });
    if (!result.hasMore) break;
  }

  await ctx.db.syncState.put({ key: 'lastSyncAt', value: String(Date.now()) });
  const blobs = await fetchRemoteBlobs(ctx);
  return { applied, cursor, blobs };
}

/**
 * 把「雲端有、本地還沒有明文」的 blob 抓回來。
 *
 * 為什麼一定要補這一步：卡片互動頁與素材圖走 blob 通道，拉到的信封只有中繼資料，
 * 不抓回來的話新裝置上「卡片打開是空的、圖片全不見」——看起來就像資料沒同步過來。
 * KV 是最終一致的，抓不到就維持 state='remote'，下次同步再試（不標失敗、不清本地參照）。
 */
export async function fetchRemoteBlobs(ctx: EngineContext): Promise<{
  fetched: number;
  pending: number;
  broken: number;
  repaired: number;
}> {
  // 先把「舊格式/壞掉但本地有明文」的 blob 換成 v2 並覆寫雲端（修復舊版同步留下的雷）
  const migrated = await migrateBlobKeys(ctx);

  let fetched = 0;
  let pending = migrated.pending;
  let broken = 0;
  const waiting = await ctx.db.blobState.where('state').equals('remote').limit(MAX_BLOB_BATCH).toArray();
  for (const state of waiting) {
    if (!state.kind) {
      // 早期版本寫入的 blobState 沒有 kind，無法反查是哪一筆記錄；跳過，等它被重新排進 outbox
      pending += 1;
      continue;
    }
    const outcome = await ensureBlobLocal(ctx, state.kind, state.refId);
    if (outcome === 'fetched' || outcome === 'have') fetched += 1;
    else if (outcome === 'broken') broken += 1;
    else pending += 1;
  }
  return { fetched, pending, broken, repaired: migrated.repaired };
}

/** 首次註冊：把本地既有的全部資料排進 outbox 並推上去 */
export async function initialPush(
  ctx: EngineContext,
  onProgress?: (done: number, total: number) => void,
): Promise<{ pushed: number }> {
  const kinds = Object.keys(SYNC_TABLES) as SyncKind[];
  let queued = 0;
  for (const kind of kinds) {
    const rows = (await ctx.db.table(SYNC_TABLES[kind]).toArray()) as Record<string, unknown>[];
    if (rows.length === 0) continue;
    await ctx.db.syncOutbox.bulkPut(
      rows.map((row) => ({ kind, id: keyOf(kind, row), deleted: 0 as const, queuedAt: Date.now() })),
    );
    queued += rows.length;
  }

  let pushed = 0;
  for (;;) {
    const step = await pushPending(ctx);
    pushed += step.pushed;
    onProgress?.(pushed, queued);
    if (step.pushed === 0) break;
  }
  return { pushed };
}

export async function syncNow(ctx: EngineContext): Promise<{
  pushed: number;
  conflicts: number;
  applied: number;
  cursor: number;
  /** 有幾顆雲端素材解不開（舊版遺留）；>0 時 UI 要提示，但不影響其他資料同步 */
  blobsBroken: number;
  /** 這一輪修復（改成 v2 金鑰 + 覆寫雲端）了幾顆 */
  blobsRepaired: number;
}> {
  let pushed = 0;
  let conflicts = 0;
  for (;;) {
    const step = await pushPending(ctx);
    pushed += step.pushed;
    conflicts += step.conflicts;
    if (step.pushed === 0) break;
  }
  const pulled = await pullChanges(ctx);
  return {
    pushed,
    conflicts,
    applied: pulled.applied,
    cursor: pulled.cursor,
    blobsBroken: pulled.blobs.broken,
    blobsRepaired: pulled.blobs.repaired,
  };
}

/* ------------------------------------------------------------------ *
 * 登入時的「兩邊都有資料」取捨（spec §6）
 * ------------------------------------------------------------------ */

export interface ContentSnapshot {
  table: string;
  rows: Record<string, unknown>[];
}

/** 給內容表拍一張快照（不含同步用的本地表）。「以本地為準」時要先拍，否則 pull 會蓋掉它 */
export async function snapshotContentTables(db: DshDB): Promise<ContentSnapshot[]> {
  const out: ContentSnapshot[] = [];
  for (const [kind, table] of Object.entries(SYNC_TABLES) as [SyncKind, string][]) {
    void kind;
    const rows = (await db.table(table).toArray()) as Record<string, unknown>[];
    if (rows.length > 0) out.push({ table, rows });
  }
  return out;
}

/** 把快照蓋回本地（會經過 outbox 收斂點 → 自動排進待推送） */
export async function restoreContentTables(db: DshDB, snapshot: ContentSnapshot[]): Promise<void> {
  for (const { table, rows } of snapshot) {
    await db.table(table).bulkPut(rows as never);
  }
}

/** 本地一共有幾筆內容（用來判斷「兩邊是不是都有資料」） */
export async function contentRowCount(db: DshDB): Promise<number> {
  let total = 0;
  for (const table of Object.values(SYNC_TABLES)) {
    total += await db.table(table).count();
  }
  return total;
}

/** 把增量游標歸零，讓下一次 pull 從頭拉一遍（「以本地為準」時用） */
export async function resetCursor(db: DshDB): Promise<void> {
  await db.syncState.put({ key: 'cursor', value: '0' });
}