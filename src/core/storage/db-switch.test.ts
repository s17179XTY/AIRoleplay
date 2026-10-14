import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase, switchDatabase, currentDbName, dbNameFor, DEFAULT_DB_NAME } from './db';

afterEach(async () => {
  await switchDatabase(DEFAULT_DB_NAME);
});

describe('可換庫的 db', () => {
  it('DB 名稱：未登入用預設名、登入帳號各自一庫', () => {
    expect(dbNameFor('alice')).toBe('dsh-roleplay@alice');
    expect(DEFAULT_DB_NAME).toBe('dsh-roleplay');
  });

  it('切到別的庫之後，寫入不會污染原本的庫', async () => {
    const a = await switchDatabase('test-db-a');
    await a.cards.put({
      id: 'card_a', name: 'A 卡', author: '', version: '1', description: '', tags: [],
      source: 'local', spec: 'dsh-card/1', createdAt: 1, updatedAt: 1,
    });

    const b = await switchDatabase('test-db-b');
    expect(await b.cards.count()).toBe(0);

    const back = await switchDatabase('test-db-a');
    expect(await back.cards.count()).toBe(1);
    expect(currentDbName()).toBe('test-db-a');
  });

  it('v2 多了五張同步用表，既有 13 張表還在', async () => {
    const d = openDatabase('test-db-schema');
    await d.open();
    const names = d.tables.map((t) => t.name).sort();
    expect(names).toContain('syncOutbox');
    expect(names).toContain('syncState');
    expect(names).toContain('syncRev');
    expect(names).toContain('syncConflicts');
    expect(names).toContain('blobState');
    expect(names).toContain('cards');
    expect(names).toContain('cardUiState');
    d.close();
  });
});
