import { fail, ok, type ApiReply } from './http';
import { consumeQuota } from './auth';
import { releaseBlobsForRecord } from './blob';
import type { Env } from './types';

export const MAX_PULL_LIMIT = 200;
/**
 * 每批推送筆數上限。
 * 理由：Workers 免費方案每次呼叫的 D1 查詢數只有 50。20 筆大約是
 * 20 次「讀現值」+ 20 次 upsert + 20 次 changes 追加 ≈ 60 條 statement，
 * 但 DB.batch 會把它們合成少數幾次往返；超過 20 筆就換下一批。
 */
export const MAX_PUSH_BATCH = 20;
export const MAX_ROW_BYTES = 262144;
export const CONFLICT_INLINE_BYTES = 65536;
/**
 * Cloudflare D1 對單一 prepared statement 的綁定參數有 100 的硬上限，超過就整條查詢失敗，
 * 被 worker 最外層 catch 變成 500。這個上限是「綁定參數」不是「? 個數」，所以要把
 * 固定參數（user_id 1 個）先扣掉再換算每批幾組 (kind, id)：
 *   floor((100 - 1) / 2) = 49 組 → 99 個參數。
 * 舊版寫死 50 組 → 1 + 50*2 = 101，第一次同步（initialPush > 50 筆）之後的 pull 必定失敗。
 */
export const MAX_BOUND_PARAMS = 100;
const PARAMS_PER_PAIR = 2;
const PAIR_CHUNK = Math.floor((MAX_BOUND_PARAMS - 1) / PARAMS_PER_PAIR);

export interface PushRecord {
  kind: string;
  id: string;
  rev: number;
  baseRev: number;
  updatedAt: number;
  deleted?: boolean;
  size?: number;
  ciphertext?: string;
  blobRef?: string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function handlePull(
  env: Env,
  userId: string,
  cursor: number,
  limit = MAX_PULL_LIMIT,
): Promise<ApiReply> {
  const take = Math.max(1, Math.min(limit, MAX_PULL_LIMIT));
  const changes = await env.DB.prepare(
    'SELECT seq, kind, id, deleted FROM changes WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?',
  )
    .bind(userId, cursor, take)
    .all<{ seq: number; kind: string; id: string; deleted: number }>();

  const nextCursor = changes.results.length > 0 ? changes.results[changes.results.length - 1].seq : cursor;
  const live = changes.results.filter((c) => c.deleted === 0);

  const recordMap = new Map<string, Record<string, unknown>>();
  for (const group of chunk(live, PAIR_CHUNK)) {
    const clause = group.map(() => '(kind = ? AND id = ?)').join(' OR ');
    const params: unknown[] = [userId];
    for (const g of group) params.push(g.kind, g.id);
    const rows = await env.DB.prepare(
      `SELECT kind, id, rev, updated_at, size, ciphertext, blob_ref FROM records WHERE user_id = ? AND (${clause})`,
    )
      .bind(...params)
      .all<Record<string, unknown>>();
    for (const row of rows.results) recordMap.set(`${row.kind}|${row.id}`, row);
  }

  const records = changes.results.map((c) => {
    if (c.deleted === 1) return { kind: c.kind, id: c.id, deleted: true };
    const row = recordMap.get(`${c.kind}|${c.id}`);
    // 對不上（理論上不該發生）時當成墓碑處理：寧可讓客戶端刪掉本地那份，也不要留下解不開的記錄
    if (!row) return { kind: c.kind, id: c.id, deleted: true };
    return {
      kind: row.kind,
      id: row.id,
      deleted: false,
      rev: row.rev,
      updatedAt: row.updated_at,
      size: row.size,
      ciphertext: row.ciphertext,
      blobRef: row.blob_ref ?? undefined,
    };
  });

  const user = await env.DB.prepare('SELECT used_bytes, quota_bytes FROM users WHERE id = ?')
    .bind(userId)
    .first<{ used_bytes: number; quota_bytes: number }>();

  return ok({
    cursor: nextCursor,
    hasMore: changes.results.length === take,
    records,
    quota: { used: user?.used_bytes ?? 0, limit: user?.quota_bytes ?? 0 },
  });
}

export async function handlePush(
  env: Env,
  userId: string,
  body: unknown,
  now = Date.now(),
): Promise<ApiReply> {
  if (typeof body !== 'object' || body === null) return fail(400, 'bad_body', '請求格式錯誤');
  const input = body as { records?: PushRecord[] };
  if (!Array.isArray(input.records)) return fail(400, 'bad_body', '缺少 records');
  if (input.records.length > MAX_PUSH_BATCH) {
    return fail(400, 'batch_too_large', `每批最多 ${MAX_PUSH_BATCH} 筆`);
  }

  const accepted: Array<{ kind: string; id: string; rev: number }> = [];
  const conflicts: Array<Record<string, unknown>> = [];

  for (const record of input.records) {
    if (typeof record.kind !== 'string' || typeof record.id !== 'string') {
      return fail(400, 'bad_record', '記錄缺少 kind 或 id');
    }

    // 墓碑優先：刪除不做 rev 比較，永遠生效
    if (record.deleted) {
      const before = await env.DB.prepare('SELECT blob_ref FROM records WHERE user_id = ? AND kind = ? AND id = ?')
        .bind(userId, record.kind, record.id)
        .first<{ blob_ref: string | null }>();
      await env.DB.prepare('DELETE FROM records WHERE user_id = ? AND kind = ? AND id = ?')
        .bind(userId, record.kind, record.id)
        .run();
      // 記錄沒了，它引用的 blob 也該被釋放（引用數歸零就刪 KV、退配額）
      await releaseBlobsForRecord(env, userId, before?.blob_ref ?? null, 0);
      await env.DB.prepare('INSERT INTO changes (user_id, kind, id, deleted, at) VALUES (?,?,?,1,?)')
        .bind(userId, record.kind, record.id, now)
        .run();
      continue;
    }

    const size = record.size ?? (record.ciphertext ?? '').length;
    if (size > MAX_ROW_BYTES) return fail(413, 'row_too_large', '單筆記錄超過 256 KiB，請走 blob');
    if (typeof record.ciphertext !== 'string' || record.ciphertext.length === 0) {
      return fail(400, 'bad_record', '記錄缺少 ciphertext');
    }

    const existing = await env.DB.prepare('SELECT rev, size, ciphertext, blob_ref FROM records WHERE user_id = ? AND kind = ? AND id = ?')
      .bind(userId, record.kind, record.id)
      .first<{ rev: number; size: number; ciphertext: string; blob_ref: string | null }>();

    // blobRef 換了就把舊 blob 的引用數減一（舊檔案沒人引用時會被回收、配額退回）
    const nextBlob = record.blobRef ?? null;
    if (existing?.blob_ref && existing.blob_ref !== nextBlob) {
      await releaseBlobsForRecord(env, userId, existing.blob_ref, 0);
    }

    const serverRev = existing?.rev ?? 0;
    const clientBase = record.baseRev ?? 0;
    let nextRev = clientBase + 1;

    if (existing && clientBase !== serverRev) {
      // LWW：以到達順序為準，但把被覆蓋的版本回傳給客戶端留副本
      nextRev = Math.max(serverRev, clientBase) + 1;
      const inline = existing.size <= CONFLICT_INLINE_BYTES;
      conflicts.push({
        kind: record.kind,
        id: record.id,
        serverRev,
        ...(inline ? { serverCiphertext: existing.ciphertext } : {}),
      });
    }

    const delta = size - (existing?.size ?? 0);
    if (delta > 0) {
      const quota = await consumeQuota(env, userId, delta);
      if (!quota.allowed) {
        // 回傳的形狀與 push/pull 的 quota 欄位一致，UI 才能共用同一個顯示邏輯
        return fail(413, 'quota_exceeded', '雲端空間已滿', {
          quota: { used: quota.used, limit: quota.limit },
        });
      }
    }

    await env.DB.prepare(
      'INSERT INTO records (user_id, kind, id, rev, updated_at, size, ciphertext, blob_ref) VALUES (?,?,?,?,?,?,?,?) ' +
        'ON CONFLICT(user_id, kind, id) DO UPDATE SET rev = excluded.rev, updated_at = excluded.updated_at, size = excluded.size, ciphertext = excluded.ciphertext, blob_ref = excluded.blob_ref',
    )
      .bind(userId, record.kind, record.id, nextRev, record.updatedAt ?? now, size, record.ciphertext, record.blobRef ?? null)
      .run();

    await env.DB.prepare('INSERT INTO changes (user_id, kind, id, deleted, at) VALUES (?,?,?,0,?)')
      .bind(userId, record.kind, record.id, now)
      .run();

    accepted.push({ kind: record.kind, id: record.id, rev: nextRev });
  }

  const user = await env.DB.prepare('SELECT used_bytes, quota_bytes FROM users WHERE id = ?')
    .bind(userId)
    .first<{ used_bytes: number; quota_bytes: number }>();

  // 已逐筆扣了配額：扣的是「真正寫進去的那幾筆」，中途失敗不需要補償
  return ok({
    accepted,
    conflicts,
    quota: { used: user?.used_bytes ?? 0, limit: user?.quota_bytes ?? 0 },
  });
}
