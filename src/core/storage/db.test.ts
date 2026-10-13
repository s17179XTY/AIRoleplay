import { describe, it, expect, beforeEach } from 'vitest';
import { DshDB } from './db';

let db: DshDB;
beforeEach(async () => {
  db = new DshDB('test-' + Math.random());
  await db.open();
});

describe('存储内核', () => {
  it('能写入并读回一条消息，且按 chatId 查询', async () => {
    await db.messages.add({
      id: 'm1', chatId: 'c1', parentId: null, role: 'user', raw: '你好',
      status: 'complete', tokensIn: 0, tokensOut: 0, model: '', createdAt: 1,
    });
    const list = await db.messages.where('chatId').equals('c1').toArray();
    expect(list).toHaveLength(1);
    expect(list[0].raw).toBe('你好');
  });

  it('cardFiles 复合主键可读写', async () => {
    await db.cardFiles.put({ cardId: 'card1', path: 'ui/index.html', kind: 'html', text: '<b>hi</b>' });
    const f = await db.cardFiles.get(['card1', 'ui/index.html']);
    expect(f?.text).toBe('<b>hi</b>');
  });
});
