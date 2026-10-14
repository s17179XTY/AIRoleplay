import type { D1Database } from './types';

/**
 * 固定視窗限流：每個 (bucket, 視窗起點) 一列，超過 limit 就回 false。
 * bucket 由呼叫端組（例如 register:<ip>、login:<ip>），所以不同端點各自計數。
 */
export async function allow(
  db: D1Database,
  bucket: string,
  limit: number,
  windowSec: number,
  now = Date.now(),
): Promise<boolean> {
  const windowMs = windowSec * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await db
    .prepare(
      'INSERT INTO rate (bucket, window_start, count) VALUES (?, ?, 1) ' +
        'ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1 RETURNING count',
    )
    .bind(bucket, windowStart)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}
