import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../core/storage/db';
import { createMockAdapter } from '../core/providers/mock';
import { setAdapter, useSession } from './useSession';

beforeEach(async () => {
  await db.messages.clear();
  await db.chats.clear();
  await db.cards.clear();
  useSession.setState({
    ready: false, cardId: null, cardName: '', card: null, modelLabel: 'mock', chatId: null,
    messages: [], draft: '', streaming: false, error: null, regexRules: [], memories: [], memoryCount: 0, cardUiHtml: null,
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
    expect(s.messages).toHaveLength(0);
    expect(s.cardUiHtml).toContain('generated-content-preview');
  });

  it('send 落库两条消息并用 parentId 串成树', async () => {
    await useSession.getState().init();
    await useSession.getState().send('你好');
    const s = useSession.getState();
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0].role).toBe('user');
    expect(s.messages[1].parentId).toBe(s.messages[0].id);
    expect(s.messages[1].raw).toContain('回复内容');
    expect(s.streaming).toBe(false);
  });

  it('第二次 send 会把世界线延长而不是覆盖', async () => {
    await useSession.getState().init();
    await useSession.getState().send('第一句');
    await useSession.getState().send('第二句');
    expect(useSession.getState().messages).toHaveLength(4);
  });

  it('AI 输出里的记忆被托管，并在下一轮注入提示词', async () => {
    const seen: string[][] = [];
    setAdapter({
      id: 'mock',
      async listModels() { return []; },
      async *streamChat(_cfg, req) {
        seen.push(req.messages.map((m) => m.content));
        yield { type: 'text', delta: '<plot>正文</plot>' };
        yield {
          type: 'text',
          delta: '<details><summary>近期记忆</summary>[1]（2026-10-13 傍晚）她拆穿了偷窥者。</details>',
        };
        yield { type: 'done', finishReason: 'stop' };
      },
    });
    await useSession.getState().init();
    await useSession.getState().send('第一句');
    const stored = await db.memories.toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toContain('拆穿了偷窥者');
    await useSession.getState().send('第二句');
    const secondCall = seen[seen.length - 1].join('\n');
    expect(secondCall).toContain('【近期记忆】');
    expect(secondCall).toContain('拆穿了偷窥者');
    // 历史里的记忆区块被剥离：记忆正文只出现在回注条目里，不会重复
    const dup = seen[seen.length - 1].filter((c) => c.includes('拆穿了偷窥者')).length;
    expect(dup).toBe(1);
  });

  it('删除消息会连同其后的分支一起删除', async () => {
    await useSession.getState().init();
    await useSession.getState().send('第一句');
    const before = useSession.getState().messages.length;
    const userMsg = useSession.getState().messages[0];
    await useSession.getState().deleteMessage(userMsg.id);
    const after = useSession.getState().messages.length;
    expect(after).toBe(before - 2);
    const left = await db.messages.where('chatId').equals(useSession.getState().chatId!).toArray();
    expect(left.length).toBe(before - 2);
  });

  it('branchTo 之后世界线缩短，再 send 会长出新分支', async () => {
    await useSession.getState().init();
    await useSession.getState().send('第一句');
    const firstUser = useSession.getState().messages[0];
    await useSession.getState().branchTo(firstUser.id);
    expect(useSession.getState().messages).toHaveLength(1);
    await useSession.getState().send('换个方向');
    expect(useSession.getState().messages).toHaveLength(3);
    const all = await db.messages.where('chatId').equals(useSession.getState().chatId!).toArray();
    // 原助理回复仍留在库里，但已不在当前世界线上
    expect(all.length).toBe(4);
  });
});
