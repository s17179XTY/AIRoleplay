import type { DshDB } from '../storage/db';
import { decryptEnvelope, encryptEnvelope, type Envelope } from './envelope';
import { keyOf, SYNC_TABLES, sanitizeForSync, type SyncKind } from './kinds';
import { clearOutbox, setApplyingRemote, takeOutbox, type OutboxEntry } from './outbox';
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
    const envelope: Envelope = {
      v: 1,
      rev,
      updatedAt: Date.now(),
      deviceId: ctx.deviceId,
      data: sanitizeForSync(entry.kind, row),
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

  const row = { ...envelope.data } as Record<string, unknown>;
  setApplyingRemote(true);
  try {
    await table.put(row);
    await ctx.db.syncRev.put({ kind, id: record.id, rev: record.rev ?? envelope.rev });
  } finally {
    setApplyingRemote(false);
  }

  if (record.blobRef) {
    await ctx.db.blobState.put({
      blobId: record.blobRef,
      state: 'remote',
      refId: record.id,
      size: record.size ?? 0,
    });
  }
  return 'applied';
}

export async function pullChanges(
  ctx: EngineContext,
  opts: { maxPages?: number } = {},
): Promise<{ applied: number; cursor: number }> {
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
  return { applied, cursor };
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
  return { pushed, conflicts, applied: pulled.applied, cursor: pulled.cursor };
}
