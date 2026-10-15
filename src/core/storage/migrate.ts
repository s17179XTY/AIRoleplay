import { db as liveDb, type DshDB } from './db';
import { MEMORY_SCHEMA_VERSION, SETTING_MEMORY_SCHEMA } from './types';

/**
 * 一次性迁移：旧版把 AI 回复里的「近期记忆 / 永久记忆」解析出来存进 `memories` 表，
 * 新版改成只放「掉出上下文窗口的交换」压出来的摘要。旧条目一律清掉（使用者明确要求）。
 *
 * **一定要逐条 `delete(id)`，不能用 `clear()`**：
 * `clear()` 走的是 deleteRange，而 outbox 收敛点（`src/core/sync/outbox.ts`）
 * 刻意不对 deleteRange 产生墓碑 —— 后果是本地清干净了、云端那份还在，
 * 换一台装置同步又会把它拉回来。逐条删才会产生墓碑、才会推到云端一起删。
 */
export async function migrateMemorySchema(target: DshDB = liveDb): Promise<{ deleted: number; ran: boolean }> {
  const marker = await target.settings.get(SETTING_MEMORY_SCHEMA).catch(() => undefined);
  if (marker?.value === MEMORY_SCHEMA_VERSION) return { deleted: 0, ran: false };

  const old = (await target.memories.toArray()).filter((m) => m.tier !== 'summary');
  for (const row of old) await target.memories.delete(row.id);

  await target.settings.put({ key: SETTING_MEMORY_SCHEMA, value: MEMORY_SCHEMA_VERSION });
  return { deleted: old.length, ran: true };
}
