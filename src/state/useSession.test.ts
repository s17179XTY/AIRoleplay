import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../core/storage/db';
import { createMockAdapter } from '../core/providers/mock';
import { setAdapter, useSession } from './useSession';

beforeEach(async () => {
  await db.messages.clear();
  await db.chats.clear();
  await db.cards.clear();
  useSession.setState({
    ready: false, cardName: '', chatId: null, messages: [], draft: '', streaming: false, error: null,
  });
  setAdapter(createMockAdapter('回复内容', { chunkSize: 100, delayMs: 0 }));
});

describe('会话 store', () => {
  it('init 会种下演示卡并建会话', async () => {
    await useSession.getState().init();
    const s = useSession.getState();
    expect(s.ready).toBe(true);
    expect(s.chatId).toBeTruthy();
    expect(await db.cards.count()).toBe(1);
    expect(s.messages).toHaveLength(1);
  });

  it('send 落库两条消息并用 parentId 串成树', async () => {
    await useSession.getState().init();
    await useSession.getState().send('你好');
    const s = useSession.getState();
    expect(s.messages).toHaveLength(3);
    expect(s.messages[1].role).toBe('user');
    expect(s.messages[2].parentId).toBe(s.messages[1].id);
    expect(s.messages[2].raw).toContain('回复内容');
    expect(s.streaming).toBe(false);
  });

  it('第二次 send 会把世界线延长而不是覆盖', async () => {
    await useSession.getState().init();
    await useSession.getState().send('第一句');
    await useSession.getState().send('第二句');
    expect(useSession.getState().messages).toHaveLength(5);
  });

  it('branchTo 之后世界线缩短，再 send 会长出新分支', async () => {
    await useSession.getState().init();
    await useSession.getState().send('第一句');
    const firstUser = useSession.getState().messages[1];
    await useSession.getState().branchTo(firstUser.id);
    expect(useSession.getState().messages).toHaveLength(2);
    await useSession.getState().send('换个方向');
    expect(useSession.getState().messages).toHaveLength(4);
    const all = await db.messages.where('chatId').equals(useSession.getState().chatId!).toArray();
    // 原助理回复仍留在库里，但已不在当前世界线上
    expect(all.length).toBe(5);
  });
});
