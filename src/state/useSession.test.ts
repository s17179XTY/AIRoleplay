import { describe, it, expect, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { db, DEFAULT_DB_NAME, switchDatabase } from '../core/storage/db';
import { createMockAdapter } from '../core/providers/mock';
import { setAdapter, useSession } from './useSession';
import { listSummaries } from '../core/storage/memoryStore';
import { SETTING_CONTEXT_LIMIT, SETTING_CONTEXT_MODE } from '../core/storage/types';
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
    messages: [], draft: '', streaming: false, summarizing: false, error: null,
    regexRules: [], memories: [], memoryCount: 0, cardUiHtml: null,
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

  it('AI 输出里的记忆块不再被存成条目；窗口内的原文保留它、也不独立注入', async () => {
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
    // 新设计：记忆块不再解析进表（表里只放「掉出窗口的交换」压出来的摘要）
    expect(await db.memories.count()).toBe(0);

    await useSession.getState().send('第二句');
    const secondCall = seen[seen.length - 1].join('\n');
    // 窗口内的原文完整保留（不再剥离记忆块）…
    expect(secondCall).toContain('拆穿了偷窥者');
    // …但不会被归成【近期记忆】独立注入（那是旧设计，会造成重复）
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

  it('branchTo 之后世界线缩短，并**自动长出一条新的 AI 回复**（不用自己再送一次）', async () => {
    await useSession.getState().init();
    await useSession.getState().send('第一句');
    const firstUser = useSession.getState().messages[0];
    const oldAssistant = useSession.getState().messages[1];

    await useSession.getState().branchTo(firstUser.id);

    const after = useSession.getState().messages;
    expect(after).toHaveLength(2);
    expect(after[0].id).toBe(firstUser.id);
    expect(after[1].role).toBe('assistant');
    expect(after[1].id).not.toBe(oldAssistant.id);   // 是新生成的分支

    await useSession.getState().send('换个方向');
    expect(useSession.getState().messages).toHaveLength(4);
    const all = await db.messages.where('chatId').equals(useSession.getState().chatId!).toArray();
    // 原助理回复仍留在库里，但已不在当前世界线上
    expect(all.length).toBe(5);
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

  /**
   * 回归：切到别的 tab 时 PlayScreen 会被卸载，切回来会重新挂载并再叫一次 init()。
   * 没有幂等守卫的话 openCard() 会把 streaming / draft 重置掉 ——
   * 生成其实还在跑，但停止按钮变回发送、吐到一半的草稿消失。
   */
  it('init 是幂等的：再叫一次不会重置 streaming / draft', async () => {
    await useSession.getState().init();
    useSession.setState({ streaming: true, draft: '吐到一半' });
    await useSession.getState().init();
    expect(useSession.getState().streaming).toBe(true);
    expect(useSession.getState().draft).toBe('吐到一半');
  });

  it('窗口外的交换会被压成摘要，注入时带「不是最新消息」前缀', async () => {
    const seen: string[][] = [];
    setAdapter({
      id: 'mock',
      async listModels() { return []; },
      async *streamChat(_cfg, req) {
        seen.push(req.messages.map((m) => m.content));
        yield { type: 'text', delta: '<plot>正文</plot>' };
        yield { type: 'done', finishReason: 'stop' };
      },
    });
    await db.settings.put({ key: SETTING_CONTEXT_MODE, value: 'recent' });
    await db.settings.put({ key: SETTING_CONTEXT_LIMIT, value: '2' });
    await useSession.getState().init();
    for (let i = 1; i <= 4; i += 1) await useSession.getState().send(`第${i}句`);

    const chatId = useSession.getState().chatId!;
    const summaries = await listSummaries(chatId);
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries[0].origin).toBe('model');
    expect(summaries[0].fromMessageId).toBeTruthy();
    expect(summaries[0].rangeLabel).toContain('第');

    const lastCall = seen[seen.length - 1].join('\n');
    expect(lastCall).toContain('更早的对话摘要');
    expect(lastCall).toContain('不是最新消息');
  });

  it('压缩期间禁止发送', async () => {
    await useSession.getState().init();
    useSession.setState({ summarizing: true });
    await useSession.getState().send('不该送出去');
    expect(useSession.getState().streaming).toBe(false);
    expect(useSession.getState().messages.some((m) => m.raw === '不该送出去')).toBe(false);
    useSession.setState({ summarizing: false });
  });

  it('preview() 的数字来自真实的 assemble（与发送时同一套）', async () => {
    await useSession.getState().init();
    await useSession.getState().send('你好');
    const p = await useSession.getState().preview();
    expect(p.totalTokens).toBeGreaterThan(0);
    expect(p.budget).toBeGreaterThan(0);
    expect(p.mode).toBe('recent');
    expect(p.windowLimit).toBe(6);
    expect(p.windowCount).toBe(2);
    expect(p.rows.some((r) => r.label.startsWith('历史'))).toBe(true);
    expect(p.rows.some((r) => r.label === '系统提示词')).toBe(true);
  });
});
