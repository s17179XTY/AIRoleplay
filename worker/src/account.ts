import { ok, type ApiReply } from './http';
import type { Env } from './types';

/**
 * 一次刪帳號最多清幾顆 KV blob。
 * KV 免費方案每日 1,000 次寫入，刪除也算一次；留一點餘裕給正常同步。
 */
export const MAX_BLOB_DELETE = 200;

/**
 * 刪除帳號：把雲端這一整份資料清乾淨。
 *
 * 為什麼要有這個端點：本地「清空資料」用的是 `clear()`，而 outbox 收斂點刻意不對
 * `clear()`（deleteRange）產生墓碑（見 `core/sync/outbox.ts` 的已知限制），
 * 所以刪本地＝雲端那份還在。要真的刪掉，只能在伺服器端一次清。
 *
 * 刪除的順序與範圍：
 * 1. 先用 `blobs` 表查出所有 blob_id，逐一刪掉 KV 上的 `<userId>/<blobId>`；
 * 2. 再刪 D1 的 records / changes / blobs / sessions / resets / users。
 *
 * 伺服器本來就只有密文，所以這裡不需要、也做不到任何解密。
 */
export async function handleDeleteAccount(env: Env, userId: string): Promise<ApiReply> {
  const blobs = await env.DB.prepare('SELECT blob_id FROM blobs WHERE user_id = ? LIMIT ?')
    .bind(userId, MAX_BLOB_DELETE)
    .all<{ blob_id: string }>();

  let blobsDeleted = 0;
  for (const row of blobs.results ?? []) {
    await env.BLOBS.delete(`${userId}/${row.blob_id}`);
    blobsDeleted += 1;
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM records WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM changes WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM blobs WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM resets WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);

  return ok({ deleted: true, blobs: blobsDeleted });
}
