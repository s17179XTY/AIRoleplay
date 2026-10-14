import { fail, ok, type ApiReply } from './http';
import { consumeQuota } from './auth';
import type { Env } from './types';

/** KV 單值上限是 25 MiB，我們自己收在 8 MiB（spec §6.4） */
export const MAX_BLOB_BYTES = 8388608;

/** key 一律帶 userId 前綴：不做跨帳號去重，否則「兩人有同一個檔案」會從 key 洩漏 */
export function blobKey(userId: string, blobId: string): string {
  return `${userId}/${blobId}`;
}

export async function handlePutBlob(
  env: Env,
  userId: string,
  blobId: string,
  bytes: ArrayBuffer,
  now = Date.now(),
): Promise<ApiReply> {
  const size = bytes.byteLength;
  if (size > MAX_BLOB_BYTES) return fail(413, 'blob_too_large', '單檔超過 8 MiB');
  if (size === 0) return fail(400, 'blob_empty', '空檔案不需要上傳');
  if (!blobId) return fail(400, 'bad_blob_id', '缺少 blob id');

  const existing = await env.DB.prepare('SELECT size FROM blobs WHERE blob_id = ? AND user_id = ?')
    .bind(blobId, userId)
    .first<{ size: number }>();
  // 內容定址：同一個 id 就是同一份內容，重傳不重複扣配額（也讓重試變成冪等）
  if (existing) return ok({ blobId, size: existing.size, deduped: true });

  const quota = await consumeQuota(env, userId, size);
  if (!quota.allowed) {
    return fail(413, 'quota_exceeded', '雲端空間已滿', { quota: { used: quota.used, limit: quota.limit } });
  }

  try {
    await env.BLOBS.put(blobKey(userId, blobId), bytes, { metadata: { size } });
  } catch (err) {
    // 寫 KV 失敗要把配額還回去，否則配額會被慢慢吃掉
    await env.DB.prepare('UPDATE users SET used_bytes = MAX(0, used_bytes - ?) WHERE id = ?').bind(size, userId).run();
    throw err;
  }

  await env.DB.prepare('INSERT INTO blobs (blob_id, user_id, size, created_at, ref_count) VALUES (?,?,?,?,1)')
    .bind(blobId, userId, size, now)
    .run();

  return ok({ blobId, size });
}

export async function handleGetBlob(
  env: Env,
  userId: string,
  blobId: string,
): Promise<ApiReply & { bytes?: ArrayBuffer }> {
  const row = await env.DB.prepare('SELECT size FROM blobs WHERE blob_id = ? AND user_id = ?')
    .bind(blobId, userId)
    .first<{ size: number }>();
  const bytes = await env.BLOBS.get(blobKey(userId, blobId), 'arrayBuffer');
  // 兩種情況都回 404：記錄不存在，或 KV 還沒傳播到這個節點（最終一致性）→ 客戶端稍後重試
  if (!bytes) return fail(404, 'blob_missing', '檔案還沒同步過來，請稍後重試');
  return { ...ok({ blobId, size: row?.size ?? bytes.byteLength }), bytes };
}

/** records 刪除或改寫時把引用數減一；歸零就刪 KV 並把配額退回去 */
export async function releaseBlobsForRecord(
  env: Env,
  userId: string,
  blobRef: string | null,
  sizeBytes: number,
): Promise<void> {
  if (!blobRef) return;
  await env.DB.prepare('UPDATE blobs SET ref_count = ref_count - 1 WHERE blob_id = ? AND user_id = ?')
    .bind(blobRef, userId)
    .run();
  const row = await env.DB.prepare('SELECT ref_count, size FROM blobs WHERE blob_id = ? AND user_id = ?')
    .bind(blobRef, userId)
    .first<{ ref_count: number; size: number }>();
  if (!row || row.ref_count > 0) return;
  await env.BLOBS.delete(blobKey(userId, blobRef));
  await env.DB.prepare('DELETE FROM blobs WHERE blob_id = ? AND user_id = ?').bind(blobRef, userId).run();
  await env.DB.prepare('UPDATE users SET used_bytes = MAX(0, used_bytes - ?) WHERE id = ?')
    .bind(row.size || sizeBytes, userId)
    .run();
}
