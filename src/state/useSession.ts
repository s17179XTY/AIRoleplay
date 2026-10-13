import { create } from 'zustand';
import { db, newId } from '../core/storage/db';
import type { MessageRecord } from '../core/storage/types';
import { DEFAULT_CAPABILITY, DEFAULT_PARAMS } from '../core/storage/types';
import { assemble } from '../core/assembler/assemble';
import { createMockAdapter, mockReplyFor } from '../core/providers/mock';
import type { ProviderAdapter } from '../core/providers/types';
import { ensureSeedCard, listCards, loadCardPackage, worldbookOf } from '../core/storage/cardRepo';
import type { CardPackage } from '../core/cards/package';

const MOCK_CFG = { id: 'mock', baseUrl: '', apiKey: '', extraHeaders: {} };

let adapter: ProviderAdapter | null = null;
export function setAdapter(a: ProviderAdapter | null): void {
  adapter = a;
}

export interface SessionState {
  ready: boolean;
  cardId: string | null;
  cardName: string;
  card: CardPackage | null;
  chatId: string | null;
  messages: MessageRecord[];
  draft: string;
  streaming: boolean;
  error: string | null;
  init: () => Promise<void>;
  openCard: (cardId: string) => Promise<void>;
  reloadCard: () => Promise<void>;
  send: (text: string) => Promise<void>;
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

export const useSession = create<SessionState>((set, get) => ({
  ready: false,
  cardId: null,
  cardName: '',
  card: null,
  chatId: null,
  messages: [],
  draft: '',
  streaming: false,
  error: null,

  init: async () => {
    await db.open();
    const cards = await listCards();
    const cardId = cards.length > 0 ? cards[0].id : await ensureSeedCard();
    await get().openCard(cardId);
  },

  openCard: async (cardId: string) => {
    const card = await loadCardPackage(cardId);
    if (!card) {
      set({ ready: true, error: '卡片不存在或已损坏' });
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
    set({
      ready: true,
      cardId,
      card,
      cardName: card.json.name,
      chatId: chat.id,
      messages: await pathToLeaf(chat.id, chat.currentLeafId),
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

  send: async (text: string) => {
    const { chatId, card } = get();
    const clean = text.trim();
    if (!chatId || !clean || get().streaming || !card) return;
    const chat = await db.chats.get(chatId);
    const parentId = chat?.currentLeafId ?? null;

    const userMsg: MessageRecord = {
      id: newId('m_'), chatId, parentId, role: 'user', raw: clean,
      status: 'complete', tokensIn: 0, tokensOut: 0, model: '', createdAt: Date.now(),
    };
    await db.messages.add(userMsg);
    await db.chats.update(chatId, { currentLeafId: userMsg.id, updatedAt: Date.now() });

    const path = await pathToLeaf(chatId, userMsg.id);
    set({ messages: path, streaming: true, error: null, draft: '' });

    const configRow = await db.configs.where('scope').equals('global').first();
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
      memories: [],
      history: path.slice(0, -1).map((m) => ({ id: m.id, role: m.role, content: m.raw })),
      userInput: clean,
      macros: macroContext(card.json.name, card.json.persona.intro),
      limits: {
        contextLength: DEFAULT_PARAMS.contextLength,
        maxTokens: DEFAULT_PARAMS.maxTokens,
        reserve: 512,
        worldbookTokenBudget: 2000,
      },
    });

    const active = adapter ?? createMockAdapter(mockReplyFor(clean, card.json.name), { delayMs: 0 });
    let acc = '';
    let failure: string | null = null;

    try {
      for await (const ev of active.streamChat(MOCK_CFG, {
        model: 'mock',
        messages: assembled.entries.map((e) => ({ role: e.role, content: e.content })),
        params: DEFAULT_PARAMS,
        capabilities: DEFAULT_CAPABILITY,
      })) {
        if (ev.type === 'text') {
          acc += ev.delta;
          set({ draft: acc });
        } else if (ev.type === 'error') {
          failure = ev.message;
        }
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    const assistantMsg: MessageRecord = {
      id: newId('m_'), chatId, parentId: userMsg.id, role: 'assistant', raw: acc,
      status: failure ? 'error' : 'complete', tokensIn: 0, tokensOut: 0,
      model: 'mock', createdAt: Date.now(),
    };
    await db.messages.add(assistantMsg);
    await db.chats.update(chatId, { currentLeafId: assistantMsg.id, updatedAt: Date.now() });
    set({
      messages: await pathToLeaf(chatId, assistantMsg.id),
      draft: '',
      streaming: false,
      error: failure,
    });
  },

  branchTo: async (messageId: string) => {
    const { chatId } = get();
    if (!chatId || get().streaming) return;
    await db.chats.update(chatId, { currentLeafId: messageId, updatedAt: Date.now() });
    set({ messages: await pathToLeaf(chatId, messageId), error: null });
  },

  regenerate: async () => {
    const { chatId, messages, streaming } = get();
    if (!chatId || streaming || messages.length < 2) return;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    await db.chats.update(chatId, { currentLeafId: lastUser.id, updatedAt: Date.now() });
    set({ messages: await pathToLeaf(chatId, lastUser.id) });
    await get().send(lastUser.raw);
  },
}));
