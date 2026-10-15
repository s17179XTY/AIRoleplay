import { create } from 'zustand';
import { db, newId } from '../core/storage/db';
import type { ConfigRecord, MemoryRecord, MessageRecord } from '../core/storage/types';
import { DEFAULT_CAPABILITY, DEFAULT_PARAMS } from '../core/storage/types';
import { assemble } from '../core/assembler/assemble';
import { createMockAdapter, mockReplyFor } from '../core/providers/mock';
import { isAbortError, type ProviderAdapter } from '../core/providers/types';
import { ensureSeedCard, listCards, loadCardPackage, worldbookOf } from '../core/storage/cardRepo';
import { findText } from '../core/cards/package';
import { getActive } from '../core/storage/providerRepo';
import { displayRules, loadRulesForChat, promptRules } from '../core/storage/regexRepo';
import { applyRegexRules, stripMemoryAndThink, type RegexRule } from '../core/cards/regex';
import { deleteMemory, ingestMemories, listMemories, toSummaryItems } from '../core/storage/memoryStore';
import { extractAll } from '../core/render/extract';
import { adapterFor } from '../core/providers/registry';
import type { CardPackage } from '../core/cards/package';
import { MEMORY_ENABLED_KEY } from '../core/storage/reset';

const MOCK_CFG = { id: 'mock', baseUrl: '', apiKey: '', extraHeaders: {} };

let adapter: ProviderAdapter | null = null;
export function setAdapter(a: ProviderAdapter | null): void {
  adapter = a;
}

/** 目前這輪生成的取消把手。使用者按「停止」就是 abort 它。 */
let currentAbort: AbortController | null = null;

export function isStreamingAbortable(): boolean {
  return currentAbort !== null;
}

export interface SessionState {
  ready: boolean;
  cardId: string | null;
  cardName: string;
  card: CardPackage | null;
  modelLabel: string;
  regexRules: RegexRule[];
  cardUiHtml: string | null;
  memoryCount: number;
  memories: MemoryRecord[];
  openChat: (chatId: string) => Promise<void>;
  newChat: () => Promise<void>;
  renameChat: (chatId: string, title: string) => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  removeMemory: (id: string) => Promise<void>;
  chatId: string | null;
  messages: MessageRecord[];
  draft: string;
  streaming: boolean;
  error: string | null;
  init: () => Promise<void>;
  openCard: (cardId: string) => Promise<void>;
  reloadCard: () => Promise<void>;
  /** 換庫 / 同步之後把畫面上的資料重讀一次（沒有它就會「同步完 UI 沒更新」） */
  reload: () => Promise<void>;
  refreshModelLabel: () => Promise<void>;
  startFromUi: (cardId: string, prompt: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  /** 停止生成：保住已經吐出來的部分，不當成錯誤 */
  stop: () => void;
  branchTo: (messageId: string) => Promise<void>;
  regenerate: () => Promise<void>;
}

async function pathToLeaf(chatId: string, leafId: string | null): Promise<MessageRecord[]> {
  if (!leafId) return [];
  const all = await db.messages.where('chatId').equals(chatId).toArray();
  const byId = new Map(all.map((m) => [m.id, m]));
  const path: MessageRecord[] = [];
  let cur: MessageRecord | null = byId.get(leafId) ?? null;
  while (cur) {
    path.unshift(cur);
    const parentId: string | null = cur.parentId;
    cur = parentId ? byId.get(parentId) ?? null : null;
  }
  return path;
}

function macroContext(cardName: string, persona: string) {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    user: '我',
    char: cardName,
    persona,
    date: now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()),
    time: pad(now.getHours()) + ':' + pad(now.getMinutes()),
    weekday: '周' + '日一二三四五六'[now.getDay()],
  };
}

/** 記憶托管是否開啟（關掉就只當普通文字顯示，不解析、不回注） */
export async function memoryEnabled(): Promise<boolean> {
  const row = await db.settings.get(MEMORY_ENABLED_KEY).catch(() => undefined);
  return row?.value !== '0';
}

export const useSession = create<SessionState>((set, get) => {
  /**
   * 真的去串流並把 assistant 訊息落地。
   * send 與 regenerate 共用它：差別只在「掛在誰下面」與「這一輪的使用者輸入是什麼」，
   * 串流以前是寫在 send 裡，導致「重新生成」只能再叫一次 send——那會多插一條使用者訊息。
   */
  const streamReply = async (input: {
    chatId: string;
    parentId: string;
    userText: string;
    historyPath: MessageRecord[];
    card: CardPackage;
    setup: string;
    configRow: ConfigRecord | undefined;
    /**
     * 由呼叫端**同步**建立並交進來。
     * 不能在這裡才 new：從 `set({streaming:true})` 到真正開始串流之間還有一串 await
     * （讀正則、讀記憶、組提示詞）。那段時間按「停止」如果沒有 controller 可 abort，
     * 就會被默默忽略、生成照跑——使用者看到的就是「按了沒反應、停不下來」。
     */
    controller: AbortController;
  }): Promise<void> => {
    const { chatId, parentId, userText, historyPath, card, setup, configRow, controller } = input;
    const toPromptRules = promptRules(await loadRulesForChat(chatId, card));
    const memoryRecords = await listMemories(chatId);
    const stripMemories = card.json.memory?.stripFromHistory !== false;
    const historyItems = historyPath.map((m) => {
      let content = stripMemories ? stripMemoryAndThink(m.raw) : m.raw;
      if (toPromptRules.length > 0) content = applyRegexRules(content, toPromptRules);
      return { id: m.id, role: m.role, content };
    });
    const active = await getActive();
    const assembled = assemble({
      card: {
        pre: card.json.prompts.pre,
        prompt: card.json.prompts.prompt,
        post: card.json.prompts.post,
        description: card.json.description,
        persona: card.json.persona.intro,
        scenario: card.json.scenario,
      },
      config: {
        prompt: configRow?.prompt ?? '',
        prePrompt: configRow?.prePrompt ?? '',
        postPrompt: configRow?.postPrompt ?? '',
      },
      worldbook: worldbookOf(card),
      summaries: toSummaryItems(memoryRecords),
      history: historyItems,
      userInput: userText,
      setup,
      macros: macroContext(card.json.name, card.json.persona.intro),
      limits: {
        contextLength: active?.preset.params.contextLength ?? DEFAULT_PARAMS.contextLength,
        maxTokens: active?.preset.params.maxTokens ?? DEFAULT_PARAMS.maxTokens,
        reserve: 512,
        worldbookTokenBudget: 2000,
      },
    });

    const streamer = active
      ? adapterFor(active.provider.protocol)
      // mock 也給一點延遲：一次全部蹦出來看不出「正在吐字」，等待提示也無從驗證
      : adapter ?? createMockAdapter(mockReplyFor(userText, card.json.name), { delayMs: 24 });
    const cfg = active
      ? {
          id: active.provider.id,
          baseUrl: active.provider.baseUrl,
          apiKey: active.provider.apiKey,
          extraHeaders: active.provider.extraHeaders,
        }
      : MOCK_CFG;
    const modelName = active ? active.preset.model : 'mock';
    const params = active ? active.preset.params : DEFAULT_PARAMS;
    const capabilities = active ? active.preset.capabilities : DEFAULT_CAPABILITY;

    let acc = '';
    let failure: string | null = null;

    try {
      // 準備階段就被按了停止（組提示詞那些 await 很花時間）：直接收工，不必再打模型
      if (controller.signal.aborted) {
        set({ messages: await pathToLeaf(chatId, parentId), draft: '', streaming: false, error: null });
        return;
      }
      for await (const ev of streamer.streamChat(cfg, {
        model: modelName,
        messages: assembled.entries.map((e) => ({ role: e.role, content: e.content, position: e.position })),
        params,
        capabilities,
        signal: controller.signal,
      })) {
        if (ev.type === 'text') {
          acc += ev.delta;
          set({ draft: acc });
        } else if (ev.type === 'error') {
          failure = ev.message;
        }
      }
    } catch (err) {
      if (!isAbortError(err) && !controller.signal.aborted) {
        failure = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (currentAbort === controller) currentAbort = null;
    }

    const stopped = controller.signal.aborted;
    // 一個字都還沒吐就被停掉：不要留一條空的 assistant 訊息，直接把畫面還原成使用者訊息
    if (stopped && !acc.trim()) {
      set({
        messages: await pathToLeaf(chatId, parentId),
        draft: '',
        streaming: false,
        error: null,
      });
      return;
    }

    const status = failure ? 'error' : stopped ? 'incomplete' : 'complete';
    const assistantMsg: MessageRecord = {
      id: newId('m_'), chatId, parentId, role: 'assistant', raw: acc,
      status, tokensIn: 0, tokensOut: 0, model: modelName, createdAt: Date.now(),
    };
    await db.messages.add(assistantMsg);
    await db.chats.update(chatId, { currentLeafId: assistantMsg.id, updatedAt: Date.now() });

    if (!failure && (await memoryEnabled()) && card.json.memory?.parser !== 'none' && acc.trim()) {
      const extracted = extractAll(acc).memories;
      const limit = configRow?.memoryLimit ?? card.json.memory?.recentLimit ?? 6;
      await ingestMemories(chatId, assistantMsg.id, extracted, limit);
    }
    const freshRules = await loadRulesForChat(chatId, card);
    const memories = await listMemories(chatId);
    set({
      messages: await pathToLeaf(chatId, assistantMsg.id),
      regexRules: displayRules(freshRules),
      memories,
      memoryCount: memories.length,
      draft: '',
      streaming: false,
      error: failure,
    });
  };

  return {
    ready: false,
    cardId: null,
    cardName: '',
    card: null,
    modelLabel: 'mock 模拟模型',
    regexRules: [],
    cardUiHtml: null,
    memoryCount: 0,
    memories: [],
    chatId: null,
    messages: [],
    draft: '',
    streaming: false,
    error: null,

    init: async () => {
      await db.open();
      const cards = await listCards();
      for (const c of cards) {
        if (await loadCardPackage(c.id)) {
          await get().openCard(c.id);
          return;
        }
      }
      const cardId = await ensureSeedCard();
      await get().openCard(cardId);
    },

    openCard: async (cardId: string) => {
      const card = await loadCardPackage(cardId);
      if (!card) {
        set({ ready: true, error: '这张卡片的数据不完整（多半来自旧版本）。请到「卡片」里删掉它，再重新导入或新建一张。' });
        return;
      }
      const chats = await db.chats.where('cardId').equals(cardId).toArray();
      let chat = chats.sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (!chat) {
        const id = newId('chat_');
        chat = {
          id, cardId, title: card.json.name, vars: {}, promptSnapshot: '',
          providerId: null, modelPresetId: null, currentLeafId: null,
          createdAt: Date.now(), updatedAt: Date.now(), archived: 0,
        };
        await db.chats.add(chat);
        if (card.json.firstMessage) {
          const first: MessageRecord = {
            id: newId('m_'), chatId: id, parentId: null, role: 'assistant',
            raw: card.json.firstMessage, status: 'complete', tokensIn: 0, tokensOut: 0,
            model: 'seed', createdAt: Date.now(),
          };
          await db.messages.add(first);
          await db.chats.update(id, { currentLeafId: first.id });
          chat.currentLeafId = first.id;
        }
      }
      const activePreset = await getActive();
      const rules = await loadRulesForChat(chat.id, card);
      const memories = await listMemories(chat.id);
      set({
        ready: true,
        cardId,
        card,
        modelLabel: activePreset ? activePreset.provider.label + ' · ' + activePreset.preset.model : 'mock 模拟模型',
        cardName: card.json.name,
        chatId: chat.id,
        messages: await pathToLeaf(chat.id, chat.currentLeafId),
        regexRules: displayRules(rules),
        cardUiHtml: card.json.ui?.entry ? findText(card, card.json.ui.entry) ?? null : null,
        memoryCount: memories.length,
        memories,
        error: null,
        draft: '',
        streaming: false,
      });
    },

    reloadCard: async () => {
      const { cardId } = get();
      if (!cardId) return;
      const card = await loadCardPackage(cardId);
      if (card) set({ card, cardName: card.json.name });
    },

    /**
     * 換庫（登入 / 登出 / 恢復碼救援）或同步之後，把畫面上的資料重讀一次。
     * 目前的會話在新庫裡不存在時退回 init()：帳號分庫之後本來就沒有那筆對話。
     */
    reload: async () => {
      if (get().streaming) return;
      const { chatId, cardId } = get();
      if (chatId && (await db.chats.get(chatId).catch(() => undefined))) {
        await get().openChat(chatId);
        return;
      }
      if (cardId && (await db.cards.get(cardId).catch(() => undefined))) {
        await get().openCard(cardId);
        return;
      }
      set({
        ready: false, cardId: null, card: null, cardName: '', chatId: null,
        messages: [], memories: [], memoryCount: 0, draft: '', streaming: false, error: null,
      });
      await get().init();
    },

    refreshModelLabel: async () => {
      const active = await getActive();
      set({ modelLabel: active ? active.provider.label + ' · ' + active.preset.model : 'mock 模拟模型' });
    },

    startFromUi: async (cardId: string, prompt: string) => {
      const card = await loadCardPackage(cardId);
      if (!card) return;
      const chatId = newId('chat_');
      await db.chats.add({
        id: chatId, cardId, title: card.json.name, vars: {}, promptSnapshot: prompt,
        providerId: null, modelPresetId: null, currentLeafId: null,
        createdAt: Date.now(), updatedAt: Date.now(), archived: 0,
      });
      set({
        ready: true, cardId, card, cardName: card.json.name, chatId,
        messages: [], draft: '', streaming: false, error: null,
      });
      await get().send(prompt);
    },

    send: async (text: string) => {
      const { chatId, card } = get();
      const clean = text.trim();
      if (!chatId || !clean || get().streaming || !card) return;
      // 同步建立取消把手（見 streamReply 的說明）：這之後到真正串流之間還有一串 await
      const controller = new AbortController();
      currentAbort = controller;

      const chat = await db.chats.get(chatId);
      const parentId = chat?.currentLeafId ?? null;
      const setupPrompt = chat?.promptSnapshot ?? '';

      const userMsg: MessageRecord = {
        id: newId('m_'), chatId, parentId, role: 'user', raw: clean,
        status: 'complete', tokensIn: 0, tokensOut: 0, model: '', createdAt: Date.now(),
      };
      await db.messages.add(userMsg);
      await db.chats.update(chatId, { currentLeafId: userMsg.id, updatedAt: Date.now() });

      const historyPath = await pathToLeaf(chatId, userMsg.id);
      // 畫面上要立刻看到剛送出的使用者訊息；提示詞的歷史則不含這一則（它在 userInput 裡）
      set({ messages: historyPath, draft: '', streaming: true, error: null });

      const configRow = await db.configs.where('scope').equals('global').first();
      await streamReply({
        chatId,
        parentId: userMsg.id,
        userText: clean,
        historyPath: historyPath.slice(0, -1),
        card,
        setup: setupPrompt,
        configRow,
        controller,
      });
    },

    stop: () => {
      // 可能還在「組提示詞」階段：abort 之後 streamReply 會在最前面就收工
      currentAbort?.abort();
    },

    openChat: async (chatId: string) => {
      const chat = await db.chats.get(chatId);
      if (!chat) return;
      const card = await loadCardPackage(chat.cardId);
      if (!card) return;
      const rules = await loadRulesForChat(chatId, card);
      const memories = await listMemories(chatId);
      set({
        ready: true, cardId: chat.cardId, card, cardName: card.json.name, chatId,
        messages: await pathToLeaf(chatId, chat.currentLeafId),
        regexRules: displayRules(rules),
        cardUiHtml: card.json.ui?.entry ? findText(card, card.json.ui.entry) ?? null : null,
        memories,
        memoryCount: memories.length,
        draft: '', streaming: false, error: null,
      });
    },

    newChat: async () => {
      const { cardId, card } = get();
      if (!cardId || !card) return;
      const chatId = newId('chat_');
      await db.chats.add({
        id: chatId, cardId, title: card.json.name + ' ' + new Date().toLocaleDateString('zh-CN'),
        vars: {}, promptSnapshot: '', providerId: null, modelPresetId: null, currentLeafId: null,
        createdAt: Date.now(), updatedAt: Date.now(), archived: 0,
      });
      if (card.json.firstMessage) {
        const first: MessageRecord = {
          id: newId('m_'), chatId, parentId: null, role: 'assistant',
          raw: card.json.firstMessage, status: 'complete', tokensIn: 0, tokensOut: 0,
          model: 'seed', createdAt: Date.now(),
        };
        await db.messages.add(first);
        await db.chats.update(chatId, { currentLeafId: first.id });
      }
      await get().openChat(chatId);
    },

    renameChat: async (chatId: string, title: string) => {
      const clean = title.trim();
      if (!clean) return;
      await db.chats.update(chatId, { title: clean, updatedAt: Date.now() });
    },

    deleteChat: async (chatId: string) => {
      await db.messages.where('chatId').equals(chatId).delete();
      await db.memories.where('chatId').equals(chatId).delete();
      await db.chats.delete(chatId);
      const { chatId: current, cardId: cid } = get();
      if (current !== chatId || !cid) return;
      const rest = (await db.chats.where('cardId').equals(cid).toArray())
        .sort((a, b) => b.updatedAt - a.updatedAt);
      if (rest.length > 0) {
        await get().openChat(rest[0].id);
        return;
      }
      const card = await loadCardPackage(cid);
      const id = newId('chat_');
      await db.chats.add({
        id, cardId: cid, title: card?.json.name ?? '对话', vars: {}, promptSnapshot: '',
        providerId: null, modelPresetId: null, currentLeafId: null,
        createdAt: Date.now(), updatedAt: Date.now(), archived: 0,
      });
      await get().openChat(id);
    },

    deleteMessage: async (messageId: string) => {
      const { chatId } = get();
      if (!chatId) return;
      const all = await db.messages.where('chatId').equals(chatId).toArray();
      const doomed = new Set<string>([messageId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const m of all) {
          if (m.parentId && doomed.has(m.parentId) && !doomed.has(m.id)) {
            doomed.add(m.id);
            grew = true;
          }
        }
      }
      const target = all.find((m) => m.id === messageId);
      for (const id of doomed) await db.messages.delete(id);
      const newLeaf = target?.parentId ?? null;
      await db.chats.update(chatId, { currentLeafId: newLeaf, updatedAt: Date.now() });
      set({ messages: await pathToLeaf(chatId, newLeaf) });
    },

    removeMemory: async (id: string) => {
      await deleteMemory(id);
      const { chatId } = get();
      if (!chatId) return;
      const memories = await listMemories(chatId);
      set({ memories, memoryCount: memories.length });
    },

    branchTo: async (messageId: string) => {
      const { chatId } = get();
      if (!chatId || get().streaming) return;
      await db.chats.update(chatId, { currentLeafId: messageId, updatedAt: Date.now() });
      set({ messages: await pathToLeaf(chatId, messageId), error: null });
    },

    regenerate: async () => {
      const { chatId, messages, streaming, card } = get();
      if (!chatId || streaming || messages.length < 2 || !card) return;
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      if (!lastUser) return;
      const controller = new AbortController();
      currentAbort = controller;
      await db.chats.update(chatId, { currentLeafId: lastUser.id, updatedAt: Date.now() });
      // 重新生成＝替同一則使用者訊息再掛一個 assistant 分支；
      // 以前是「把 leaf 指回去再呼叫 send」，那會**多插一條一模一樣的使用者訊息**。
      const historyPath = await pathToLeaf(chatId, lastUser.parentId);
      set({ messages: [...historyPath, lastUser], draft: '', streaming: true, error: null });
      const configRow = await db.configs.where('scope').equals('global').first();
      const chat = await db.chats.get(chatId);
      await streamReply({
        chatId,
        parentId: lastUser.id,
        userText: lastUser.raw,
        historyPath,
        card,
        setup: chat?.promptSnapshot ?? '',
        configRow,
        controller,
      });
    },
  };
});
