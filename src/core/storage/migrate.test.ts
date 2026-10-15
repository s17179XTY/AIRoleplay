import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { migrateMemorySchema } from './migrate';
import { installSyncTap } from '../sync/outbox';
import { MEMORY_SCHEMA_VERSION, SETTING_MEMORY_SCHEMA } from './types';

beforeEach(async () => {
  await db.memories.clear();
  await db.settings.clear();
  await db.syncOutbox.clear();
  await installSyncTap(db);
});

const oldRow = (id: string, tier: 'recent' | 'permanent' | 'summary' = 'recent') => ({
  id, chatId: 'c1', tier, text: '旧的', dateLabel: '10-01',
  sourceMessageId: null, archivedAt: null, order: 1,
});

describe('记忆库迁移（强制清掉旧条目）', () => {
  it('旧的 recent/permanent 条目被逐条删除，而且产生墓碑（云端才会一起清）', async () => {
    await db.memories.put(oldRow('m1'));
    await db.memories.put(oldRow('m2', 'permanent'));

    const r = await migrateMemorySchema(db);

    expect(r.ran).toBe(true);
    expect(r.deleted).toBe(2);
    expect(await db.memories.count()).toBe(0);
    const tombstones = (await db.syncOutbox.toArray()).filter((t) => t.kind === 'memory' && t.deleted === 1);
    expect(tombstones.map((t) => t.id).sort()).toEqual(['m1', 'm2']);
  });

  it('已经迁移过就不再跑，标记只写一次', async () => {
    await db.memories.put(oldRow('m1'));
    await migrateMemorySchema(db);

    await db.memories.put(oldRow('m3'));
    const again = await migrateMemorySchema(db);

    expect(again.ran).toBe(false);
    expect(again.deleted).toBe(0);
    expect(await db.memories.get('m3')).toBeTruthy();
    expect((await db.settings.get(SETTING_MEMORY_SCHEMA))?.value).toBe(MEMORY_SCHEMA_VERSION);
  });

  it('已经是摘要的条目不会被删', async () => {
    await db.memories.put(oldRow('s1', 'summary'));
    const r = await migrateMemorySchema(db);
    expect(r.deleted).toBe(0);
    expect(await db.memories.get('s1')).toBeTruthy();
  });

  it('没有旧数据时也写标记（只留一次空跑）', async () => {
    const r = await migrateMemorySchema(db);
    expect(r).toEqual({ deleted: 0, ran: true });
    expect((await db.settings.get(SETTING_MEMORY_SCHEMA))?.value).toBe(MEMORY_SCHEMA_VERSION);
  });
});
