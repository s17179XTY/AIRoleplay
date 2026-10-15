import { describe, it, expect, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { db, DEFAULT_DB_NAME, switchDatabase } from '../core/storage/db';
import { createMockAdapter } from '../core/providers/mock';
import { setAdapter, useSession } from './useSession';
import type { ProviderAdapter, StreamEvent } from '../core/providers/types';

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

/** 一直吐字直到被 abort 的假模型：拿來測「停止生成」 */
function hangingAdapter(firstChunk: string): ProviderAdapter {
  return {
    id: 'mock',
    async listModels() {
      return [];
    },
    async *streamChat(_cfg, req): AsyncGenerator<StreamEvent> {
      if (firstChunk) yield { type: 'text', delta: firstChunk };
      await new Promise<void>((_resolve, reject) => {
        if (req.signal?.aborted) {
          reject(abortError());
          return;
        }
        req.signal?.addEventListener('abort', () => reject(abortError()));
      });
      yield { type: 'text', delta: '不该出现的后半段' };
    },
  };
}

beforeEach(async () => {
  await db.messages.clear();
  await db.chats.clear();
  await db.cards.clear();
  await db.memories.clear();
  await db.settings.clear();
  await db.configs.clear();
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

  it('AI 输出里的记忆被托管；但不再当成独立条目注入（改由摘要库接管）', async () => {
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
    // 新设计：窗口内的原文保留记忆块，但**不再**把它归成【近期记忆】独立注入
    expect(secondCall).not.toContain('【近期记忆】');
    expect(secondCall).not.toContain('【永久记忆】');
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

  it('stop() 中止生成：保住已吐出的内容、状态是 incomplete、不算错误', async () => {
    setAdapter(hangingAdapter('第一段'));
    await useSession.getState().init();
    const pending = useSession.getState().send('第一句');
    await waitFor(() => expect(useSession.getState().draft).toBe('第一段'));

    useSession.getState().stop();
    await pending;

    const s = useSession.getState();
    expect(s.streaming).toBe(false);
    expect(s.error).toBeNull();
    expect(s.draft).toBe('');
    expect(s.messages).toHaveLength(2);
    expect(s.messages[1].role).toBe('assistant');
    expect(s.messages[1].raw).toBe('第一段');
    expect(s.messages[1].raw).not.toContain('不该出现');
    expect(s.messages[1].status).toBe('incomplete');
  });

  it('stop() 在第一個字之前：不留空的助理訊息', async () => {
    setAdapter(hangingAdapter(''));
    await useSession.getState().init();
    const pending = useSession.getState().send('第一句');
    await waitFor(() => expect(useSession.getState().streaming).toBe(true));

    useSession.getState().stop();
    await pending;

    const s = useSession.getState();
    expect(s.streaming).toBe(false);
    expect(s.error).toBeNull();
    expect(s.messages).toHaveLength(1); // 只剩使用者那一則
    expect(s.messages[0].role).toBe('user');
    const stored = await db.messages.where('chatId').equals(s.chatId!).toArray();
    expect(stored).toHaveLength(1);
  });

  /**
   * 回歸：取消把手以前是在 streamReply 裡才建立，而那之前還有一串 await（讀正則、讀記憶、組提示詞）。
   * 使用者在這個空窗按「停止」會完全沒反應、生成照跑。
   */
  it('stop() 在「還在準備提示詞」階段按下也要生效', async () => {
    setAdapter(hangingAdapter(''));
    await useSession.getState().init();
    const pending = useSession.getState().send('第一句');
    // 不等 streaming 變 true，立刻按停止（模擬「按了沒反應」的情境）
    useSession.getState().stop();
    await pending;

    const s = useSession.getState();
    expect(s.streaming).toBe(false);
    expect(s.error).toBeNull();
    expect(s.messages).toHaveLength(1);
  });

  it('regenerate 只重做助理回覆，不会多插一条使用者訊息', async () => {    await useSession.getState().init();
    await useSession.getState().send('第一句');
    const before = useSession.getState().messages;
    expect(before).toHaveLength(2);

    await useSession.getState().regenerate();
    const after = useSession.getState().messages;
    expect(after).toHaveLength(2);
    expect(after[0].id).toBe(before[0].id);      // 還是同一條使用者訊息
    expect(after[1].id).not.toBe(before[1].id);  // 助理回覆是新的分支

    const all = await db.messages.where('chatId').equals(useSession.getState().chatId!).toArray();
    expect(all.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(all.filter((m) => m.role === 'assistant')).toHaveLength(2); // 舊分支留在庫裡
  });

  it('记忆托管关掉时：不解析、不归档（但文字照常显示）', async () => {
    const reply = '<plot>正文</plot><details><summary>近期记忆</summary>[1]（2026-10-13 傍晚）她拆穿了偷窥者。</details>';
    setAdapter(createMockAdapter(reply, { chunkSize: 500, delayMs: 0 }));
    await db.settings.put({ key: 'memoryEnabled', value: '0' });
    await useSession.getState().init();
    await useSession.getState().send('第一句');

    expect(await db.memories.count()).toBe(0);
    expect(useSession.getState().memories).toHaveLength(0);
    // 記憶區塊仍然留在訊息原文裡（顯示用）
    expect(useSession.getState().messages[1].raw).toContain('拆穿了偷窥者');
  });

  /**
   * 回歸：登入 / 登出會把整個 IndexedDB 連線換成帳號專屬的庫，同步則會拉進另一台裝置的變更。
   * 這兩件事都不會經過 React 的 state——沒有 reload() 的話畫面就停在換庫前，看起來像資料沒了。
   */
  it('reload：換庫之後用新庫的資料重畫（不管是自己的對話還是剛種下的內置卡）', async () => {
    await useSession.getState().init();
    await useSession.getState().send('第一句');
    expect(useSession.getState().messages).toHaveLength(2);
    const oldChat = useSession.getState().chatId;

    // 模擬登入：換到一個全新的帳號庫（那裡沒有剛才那筆對話）
    const other = `dsh-roleplay@reload-${Math.random().toString(36).slice(2)}`;
    await switchDatabase(other);
    await useSession.getState().reload();

    const s = useSession.getState();
    expect(s.ready).toBe(true);
    expect(s.chatId).not.toBe(oldChat);
    expect(s.cardId).toBeTruthy();                       // 新庫自動種回內置卡
    expect(await db.chats.count()).toBeGreaterThan(0);
    expect(s.messages).toHaveLength(0);                  // 新庫沒有剛才那些訊息

    // 還原，別影響後面的用例
    await switchDatabase(DEFAULT_DB_NAME);
  });
});
