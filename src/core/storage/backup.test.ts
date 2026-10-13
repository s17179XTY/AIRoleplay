import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { exportAll, importAll } from './backup';
import { saveCardPackage } from './cardRepo';
import { seedPackage } from './seedPackage';

beforeEach(async () => {
  await db.cards.clear();
  await db.cardFiles.clear();
  await db.assets.clear();
  await db.chats.clear();
  await db.messages.clear();
  await db.settings.clear();
});

describe('全量备份', () => {
  it('导出后清空再导入，数据完整回来', async () => {
    const cardId = await saveCardPackage(seedPackage());
    await db.chats.add({
      id: 'chat-1', cardId, title: 't', vars: {}, promptSnapshot: '设定', providerId: null,
      modelPresetId: null, currentLeafId: null, createdAt: 1, updatedAt: 1, archived: 0,
    });
    const backup = await exportAll();
    expect(backup.byteLength).toBeGreaterThan(100);

    await db.cards.clear();
    await db.cardFiles.clear();
    await db.assets.clear();
    await db.chats.clear();
    expect(await db.cards.count()).toBe(0);

    await importAll(backup);
    expect(await db.cards.count()).toBe(1);
    expect(await db.chats.count()).toBe(1);
    const assets = await db.assets.toArray();
    expect(assets).toHaveLength(1);
    expect(assets[0].bytes.byteLength).toBeGreaterThan(0);
    const file = await db.cardFiles.get([cardId, 'ui/index.html']);
    expect(file?.text).toContain('data-dsh-field');
  });

  it('拒绝非本应用备份', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ app: 'other' }));
    await expect(importAll(bytes)).rejects.toThrow();
  });
});
