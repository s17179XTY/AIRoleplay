import { describe, it, expect, beforeEach } from 'vitest';
import { switchDatabase } from '../storage/db';
import { installSyncTap, setApplyingRemote, pendingCount, takeOutbox, clearOutbox } from './outbox';

beforeEach(async () => {
  const name = `outbox-test-${Math.random().toString(36).slice(2)}`;
  const target = await switchDatabase(name);
  // 正常情況下 onDatabaseCreated 已經在建立時掛好；這裡再叫一次是為了證明「重複安裝無害」。
  await installSyncTap(target);
});

describe('outbox 收斂點', () => {
  it('任何寫入都會留下一筆待推送', async () => {
    const { db } = await import('../storage/db');
    await db.chats.put({
      id: 'chat_1', cardId: 'card_1', title: 't', vars: {}, promptSnapshot: '',
      providerId: null, modelPresetId: null, currentLeafId: null, createdAt: 1, updatedAt: 1, archived: 0,
    });
    expect(await pendingCount()).toBe(1);
  });

  it('同一筆改兩次只留一筆（[kind+id] 主鍵去重）', async () => {
    const { db } = await import('../storage/db');
    await db.settings.put({ key: 'fontSize', value: '16' });
    await db.settings.put({ key: 'fontSize', value: '18' });
    expect(await pendingCount()).toBe(1);
  });

  it('刪除會留下墓碑標記', async () => {
    const { db } = await import('../storage/db');
    await db.settings.put({ key: 'k', value: 'v' });
    await db.settings.delete('k');
    const items = await takeOutbox(10);
    expect(items).toHaveLength(1);
    expect(items[0].deleted).toBe(1);
  });

  it('bulkPut 會逐筆進 outbox', async () => {
    const { db } = await import('../storage/db');
    await db.messages.bulkPut([
      { id: 'm1', chatId: 'c1', parentId: null, role: 'user', raw: 'a', status: 'complete', tokensIn: 0, tokensOut: 0, model: '', createdAt: 1 },
      { id: 'm2', chatId: 'c1', parentId: 'm1', role: 'assistant', raw: 'b', status: 'complete', tokensIn: 0, tokensOut: 0, model: '', createdAt: 2 },
    ]);
    expect(await pendingCount()).toBe(2);
  });

  it('同步層自己套用遠端資料時不會回灌 outbox（不會無限迴圈）', async () => {
    const { db } = await import('../storage/db');
    setApplyingRemote(true);
    await db.settings.put({ key: 'fromServer', value: '1' });
    setApplyingRemote(false);
    expect(await pendingCount()).toBe(0);
  });

  it('本地專用表不會被攔截', async () => {
    const { db } = await import('../storage/db');
    await db.syncState.put({ key: 'cursor', value: '5' });
    expect(await pendingCount()).toBe(0);
  });

  it('clearOutbox 只清掉已推送的那些', async () => {
    const { db } = await import('../storage/db');
    await db.settings.put({ key: 'a', value: '1' });
    await db.settings.put({ key: 'b', value: '2' });
    const items = await takeOutbox(1);
    await clearOutbox(items);
    expect(await pendingCount()).toBe(1);
  });
});
