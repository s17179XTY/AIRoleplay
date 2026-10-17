import { create } from 'zustand';
import { db, newId } from '../core/storage/db';
import type { ConfigRecord, MemoryOrigin, MemoryRecord, MessageRecord } from '../core/storage/types';
import {
  DEFAULT_CAPABILITY, DEFAULT_CONTEXT_LIMIT, DEFAULT_CONTEXT_MODE, DEFAULT_PARAMS,
  DEFAULT_SUMMARY_BATCH, DEFAULT_SUMMARY_TRIGGER, SETTING_CONTEXT_LIMIT, SETTING_CONTEXT_MODE,
  SETTING_SUMMARY_BATCH, SETTING_SUMMARY_ENABLED, SETTING_SUMMARY_TRIGGER,
  SUMMARY_FAIL_LIMIT, SUMMARY_MAX_CHARS, SUMMARY_MAX_PAIRS_PER_RUN, SUMMARY_TARGET_PERCENT,
  SUMMARY_TRIGGER_MAX, SUMMARY_TRIGGER_MIN,
  type ContextMode,
} from '../core/storage/types';
import { assemble } from '../core/assembler/assemble';
import { estimateTokens } from '../core/assembler/budget';
import { buildExchanges, computeWindow, coveredEndIndex, type Exchange } from '../core/assembler/window';
import { planSummaryGroups } from '../core/assembler/summaryPlan';
import { skeletonSummary, summarizePairs, type SummaryPart } from '../core/assembler/summarize';
import { createMockAdapter, mockReplyFor } from '../core/providers/mock';
import { isAbortError, type ProviderAdapter } from '../core/providers/types';
import { ensureSeedCard, listCards, loadCardPackage, worldbookOf } from '../core/storage/cardRepo';
import { findText } from '../core/cards/package';
import { getActive } from '../core/storage/providerRepo';
import { displayRules, loadRulesForChat, promptRules } from '../core/storage/regexRepo';
import { applyRegexRules, stripThink, type RegexRule } from '../core/cards/regex';
import { addSummary, deleteSummary, listSummaries, toSummaryItems, trimSummaries } from '../core/storage/memoryStore';
import { listEnabledMods } from '../core/storage/modRepo';
import { migrateMemorySchema } from '../core/storage/migrate';
import { adapterFor } from '../core/providers/registry';
import type { CardPackage } from '../core/cards/package';
import type { AssembledRequest, EntrySource, ModItem, SummaryItem } from '../core/assembler/types';

const MOCK_CFG = { id: 'mock', baseUrl: '', apiKey: '', extraHeaders: {} };

let adapter: ProviderAdapter | null = null;
export function setAdapter(a: ProviderAdapter | null): void {
  adapter = a;
}

/** 目前這輪生成的取消把手。使用者按「停止」就是 abort 它。 */
let currentAbort: AbortController | null = null;

/** 摘要壓縮的取消把手（與主生成分開，但一樣可以被「停止」打斷） */
let summarizeAbort: AbortController | null = null;

/** 同一段連續失敗幾次（key = chatId|第一批的訊息 id）。連續失敗 SUMMARY_FAIL_LIMIT 次就退化成本地骨架 */
const summaryFailures = new Map<string, number>();

export interface ContextSettings {
  mode: ContextMode;
  limit: number;
  summaryEnabled: boolean;
  batch: number;
  /** 上下文占用达到这个百分比就主动压缩旧对话（默认 90，上限 92） */
  triggerPercent: number;
}

export async function readContextSettings(): Promise<ContextSettings> {
  const [mode, limit, enabled, batch, trigger] = await Promise.all([
    db.settings.get(SETTING_CONTEXT_MODE).catch(() => undefined),
    db.settings.get(SETTING_CONTEXT_LIMIT).catch(() => undefined),
    db.settings.get(SETTING_SUMMARY_ENABLED).catch(() => undefined),
    db.settings.get(SETTING_SUMMARY_BATCH).catch(() => undefined),
    db.settings.get(SETTING_SUMMARY_TRIGGER).catch(() => undefined),
  ]);
  const n = Number(limit?.value ?? DEFAULT_CONTEXT_LIMIT);
  const b = Number(batch?.value ?? DEFAULT_SUMMARY_BATCH);
  const t = Number(trigger?.value ?? DEFAULT_SUMMARY_TRIGGER);
  return {
    mode: mode?.value === 'all' ? 'all' : DEFAULT_CONTEXT_MODE,
    limit: Number.isInteger(n) && n >= 1 ? n : DEFAULT_CONTEXT_LIMIT,
    summaryEnabled: enabled?.value !== '0',
    batch: Number.isInteger(b) && b >= 1 ? b : DEFAULT_SUMMARY_BATCH,
    triggerPercent: Number.isFinite(t) && t >= SUMMARY_TRIGGER_MIN && t <= SUMMARY_TRIGGER_MAX
      ? t
      : DEFAULT_SUMMARY_TRIGGER,
  };
}

function formatDateLabel(messages: MessageRecord[]): string {
  const fmt = (ts: number) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
  };
  if (messages.length === 0) return '';
  const first = fmt(messages[0].createdAt);
  const last = fmt(messages[messages.length - 1].createdAt);
  return first === last ? first : `${first} ~ ${last}`;
}


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
  /** 正在把掉出窗口的交换压成摘要（期间禁止发送） */
  summarizing: boolean;
  /** 在第一个字之前按了停止：把使用者刚发的那句放回输入框，让他们改完再发 */
  restoreInput: string | null;
  consumeRestoreInput: () => void;
  error: string | null;
  init: () => Promise<void>;
  openCard: (cardId: string) => Promise<void>;
  reloadCard: () => Promise<void>;
  /** 換庫 / 同步之後把畫面上的資料重讀一次（沒有它就會「同步完 UI 沒更新」） */
  reload: () => Promise<void>;
  refreshModelLabel: () => Promise<void>;
  restartSummary: () => void;
  /** 上下文占用预览（HUD 用）：跑一次本地组装，不发请求 */
  preview: () => Promise<ContextPreview>;
  startFromUi: (cardId: string, prompt: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  /** 停止生成：保住已經吐出來的部分，不當成錯誤 */
  stop: () => void;
  branchTo: (messageId: string) => Promise<void>;
  regenerate: () => Promise<void>;
}

export interface ContextPreview {
  rows: { label: string; tokens: number }[];
  totalTokens: number;
  budget: number;
  droppedHistory: number;
  droppedWorldbook: number;
  windowCount: number;
  windowLimit: number | null;
  mode: ContextMode;
  summaryCount: number;
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

/** 記憶托管是否開啟（＝要不要自動生成摘要；關掉就完全不生成、不注入摘要） */
export async function memoryEnabled(): Promise<boolean> {
  return (await readContextSettings()).summaryEnabled;
}

/**
 * assemble 按预算裁剪历史时，裁剪边界必须对齐到「交换」。
 *
 * assemble 是一条一条消息裁的（最旧的先裁），可能只把一对里的 user 裁掉、assistant 还留着。
 * 这里以「最后一条被裁掉的消息」为界，把它所在的整个交换都算窗口外，
 * 这样窗口外的那段才能整段进摘要库，不会出现「既没进提示词、也没进摘要」的黑洞。
 */
function trimHistoryToExchanges(messages: MessageRecord[], droppedIds: Set<string>): MessageRecord[] {
  if (droppedIds.size === 0) return messages;
  const exchanges = buildExchanges(messages.map((m) => ({ id: m.id, role: m.role })));
  const indexOf = new Map(messages.map((m, i) => [m.id, i]));
  let lastDropped = -1;
  messages.forEach((m, i) => {
    if (droppedIds.has(m.id)) lastDropped = i;
  });
  if (lastDropped < 0) return messages;
  for (const ex of exchanges) {
    const first = indexOf.get(ex.ids[0]) ?? -1;
    const end = first + ex.ids.length - 1;
    if (lastDropped >= first && lastDropped <= end) return messages.slice(end + 1);
  }
  return messages;
}

/** 一次装配的完整结果：提示词内容 + 窗口内外 + 预算（send / preview / 摘要判断共用） */
interface AssemblyResult {
  assembled: AssembledRequest;
  budget: number;
  summaries: SummaryItem[];
  mods: ModItem[];
  window: {
    windowIds: string[];
    outsideIds: string[];
    mode: 'recent' | 'all';
    limit: number | null;
  };
}

export const useSession = create<SessionState>((set, get) => {
  /**
   * 把「攒够的交换」交给模型压成摘要。
   *
   * 使用者 2026-10-15 回饋後定稿：
   * - **已经压成摘要的消息绝不再进提示词**（否则原文 + 摘要双份注入，上下文只会越压越大）；
   *   压缩永远从「最后一条摘要覆盖的消息之后」开始，压过的不会重复压。
   * - 两种触发取先到者：① 掉出窗口的交换（必须压，否则直接丢失）；
   *   ② 上下文占用 ≥ summaryTriggerPercent（主动压到约 SUMMARY_TARGET_PERCENT）。
   * - `summaryBatchPairs` = **攒够几对，合成一条摘要**（不是每对一条）。
   * - 压缩结果**不比原文长**：模型摘要、本地骨架、原文保留三者取最短；都不更短就保留原文，
   *   避免「1 个字压成一整句」反而更占上下文。
   * - 失败不吞：连续失败 SUMMARY_FAIL_LIMIT 次 → 本地骨架兜底。
   */
  const ensureSummaries = async (input: {
    chatId: string;
    path: MessageRecord[];
    settings: ContextSettings;
    streamer: ProviderAdapter | null;
    cfg: { id: string; baseUrl: string; apiKey: string; extraHeaders: Record<string, string> };
    model: string;
    signal: AbortSignal;
    /** 本轮真正要发送的装配结果：窗口内外、占用与预算都以它为准（与 preview 同一套） */
    pre: AssemblyResult;
  }): Promise<number> => {
    const { chatId, path, settings, streamer, cfg, model, signal, pre } = input;
    if (!settings.summaryEnabled || path.length === 0) return 0;
    if (signal.aborted) return 0;

    const existing = await listSummaries(chatId);
    const plan = planSummaryGroups({
      path: path.map((m) => ({ id: m.id, role: m.role, raw: m.raw })),
      windowIds: pre.window.windowIds,
      summaries: existing,
      totalTokens: pre.assembled.totalTokens,
      budget: pre.budget,
      triggerPercent: settings.triggerPercent,
      batchPairs: settings.batch,
      maxPairsPerRun: SUMMARY_MAX_PAIRS_PER_RUN,
      targetPercent: SUMMARY_TARGET_PERCENT,
    });
    const { groups, picked } = plan;
    if (picked.length === 0) return 0;

    const idxOf = new Map(path.map((m, i) => [m.id, i]));
    const rowsOfGroup = (g: Exchange[]): MessageRecord[] =>
      g.flatMap((ex) => ex.ids.map((id) => path[idxOf.get(id)!]));
    const payloads = groups.map((g) => rowsOfGroup(g).map((r) => ({ role: r.role, content: r.raw })));

    // 攒够 N 对合成一条时，允许的字数也按 N 放大：200 字装不下多条对话，会把信息压丢
    const maxChars = SUMMARY_MAX_CHARS * Math.max(1, ...groups.map((g) => g.length));
    const failKey = `${chatId}|${picked[0].ids[0]}`;
    const previousTail = existing.length > 0
      ? (existing[existing.length - 1].assistantText ?? existing[existing.length - 1].text).slice(-200)
      : undefined;

    let modelParts: SummaryPart[] = [];
    let modelFailed = false;
    if (streamer) {
      const controller = new AbortController();
      summarizeAbort = controller;
      const relay = () => controller.abort();
      signal.addEventListener('abort', relay, { once: true });
      set({ summarizing: true });
      try {
        if (controller.signal.aborted) return 0;
        modelParts = await summarizePairs({
          adapter: streamer, cfg, model, pairs: payloads, previousTail, maxChars, signal: controller.signal,
        });
        summaryFailures.delete(failKey);
      } catch (err) {
        if (controller.signal.aborted || isAbortError(err)) return 0; // 使用者取消：不写入，下次再试
        const n = (summaryFailures.get(failKey) ?? 0) + 1;
        summaryFailures.set(failKey, n);
        if (n < SUMMARY_FAIL_LIMIT) return 0;                          // 还没到阈值：保留 pending，下次重试
        modelFailed = true;
      } finally {
        signal.removeEventListener('abort', relay);
        if (summarizeAbort === controller) summarizeAbort = null;
        set({ summarizing: false });
      }
    }

    for (let i = 0; i < groups.length; i += 1) {
      const rows = rowsOfGroup(groups[i]);
      const rawUser = rows.filter((r) => r.role === 'user').map((r) => r.raw).join('\n');
      const rawAssistant = rows.filter((r) => r.role === 'assistant').map((r) => r.raw).join('\n');
      // 「原文保留」：格式与摘要条目一致，长度就是原文本身，绝不会更大
      const verbatimText = `[用户] ${rawUser}\n[叙事] ${rawAssistant}`;
      const modelPart = modelFailed ? undefined : modelParts[i];
      const startNo = idxOf.get(rows[0].id)! + 1;
      const endNo = idxOf.get(rows[rows.length - 1].id)! + 1;
      const skeleton = skeletonSummary(payloads[i], startNo, endNo);

      const choices: Array<{ text: string; userText: string; assistantText: string; origin: MemoryOrigin }> = [];
      if (modelPart) {
        choices.push({
          text: modelPart.userText
            ? `[用户] ${modelPart.userText}\n[叙事] ${modelPart.assistantText}`
            : `[叙事] ${modelPart.assistantText}`,
          userText: modelPart.userText,
          assistantText: modelPart.assistantText,
          origin: 'model',
        });
      }
      choices.push({
        text: `[叙事] ${skeleton.assistantText}`,
        userText: skeleton.userText,
        assistantText: skeleton.assistantText,
        origin: 'local-skeleton',
      });
      choices.push({ text: verbatimText, userText: rawUser, assistantText: rawAssistant, origin: 'verbatim' });

      // 取最短的那一个；原始内容本身也在候选里 → 永远不会「压完比原来更大」
      let best = choices[0];
      let bestTokens = estimateTokens(best.text);
      for (const choice of choices.slice(1)) {
        const tokens = estimateTokens(choice.text);
        if (tokens < bestTokens) {
          best = choice;
          bestTokens = tokens;
        }
      }

      await addSummary({
        chatId,
        text: best.text,
        userText: best.userText || undefined,
        assistantText: best.assistantText || undefined,
        dateLabel: formatDateLabel(rows),
        rangeLabel: `第 ${startNo}–${endNo} 条`,
        fromMessageId: rows[0].id,
        toMessageId: rows[rows.length - 1].id,
        messageCount: rows.length,
        origin: best.origin,
        maxChars: SUMMARY_MAX_CHARS * groups[i].length,
      });
    }
    await trimSummaries(chatId);
    const list = await listSummaries(chatId);
    set({ memories: list, memoryCount: list.length });
    return picked.length;
  };

  /** 把「要送进提示词的东西」组一遍；streamReply / preview / 阈值判断共用，避免三处逻辑漂移 */
  const buildAssembly = async (
    chatId: string,
    card: CardPackage,
    path: MessageRecord[],
    userText: string,
    setup: string,
    configRow: ConfigRecord | undefined,
    settings: ContextSettings,
  ): Promise<AssemblyResult> => {
    const summaryRows = await listSummaries(chatId);
    const summaries = toSummaryItems(summaryRows);
    // 已经压成摘要的消息不再进提示词：窗口从「最后一条被覆盖的消息」之后算起
    const coveredEnd = coveredEndIndex(path, summaryRows);
    const uncovered = path.slice(coveredEnd + 1);
    const uncoveredWindow = uncovered.map((m) => ({ id: m.id, role: m.role }));

    let historyMsgs = uncovered;
    if (settings.mode === 'recent') {
      const windowed = computeWindow({ messages: uncoveredWindow, mode: 'recent', limit: settings.limit });
      const inWindow = new Set(windowed.windowIds);
      historyMsgs = uncovered.filter((m) => inWindow.has(m.id));
    }

    const active = await getActive();
    const mods = await listEnabledMods();
    const toPromptRules = promptRules(await loadRulesForChat(chatId, card));
    const limits = {
      contextLength: active?.preset.params.contextLength ?? DEFAULT_PARAMS.contextLength,
      maxTokens: active?.preset.params.maxTokens ?? DEFAULT_PARAMS.maxTokens,
      reserve: 512,
      worldbookTokenBudget: 2000,
    };
    const historyOf = (msgs: MessageRecord[]) => msgs.map((m) => {
      let content = stripThink(m.raw);
      if (toPromptRules.length > 0) content = applyRegexRules(content, toPromptRules);
      return { id: m.id, role: m.role, content };
    });
    const assembleWith = (msgs: MessageRecord[]) => assemble({
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
      summaries,
      mods,
      history: historyOf(msgs),
      userInput: userText,
      setup,
      macros: macroContext(card.json.name, card.json.persona.intro),
      limits,
    });

    // all 模式靠 assemble 的预算裁剪；裁剪后要按「整对」回退，避免半对被裁掉
    let assembled = assembleWith(historyMsgs);
    for (let pass = 0; pass < 3; pass += 1) {
      const droppedIds = new Set(
        assembled.dropped.filter((d) => d.source === 'history').map((d) => d.id),
      );
      if (droppedIds.size === 0) break;
      const kept = trimHistoryToExchanges(historyMsgs, droppedIds);
      if (kept.length === historyMsgs.length) break;
      historyMsgs = kept;
      assembled = assembleWith(historyMsgs);
    }

    const windowSet = new Set(historyMsgs.map((m) => m.id));
    const windowIds = path.filter((m) => windowSet.has(m.id)).map((m) => m.id);
    const outsideIds = path.filter((m) => !windowSet.has(m.id)).map((m) => m.id);
    const budget = limits.contextLength - limits.maxTokens - limits.reserve;
    return {
      assembled,
      budget,
      summaries,
      mods,
      window: {
        windowIds,
        outsideIds,
        mode: settings.mode,
        limit: settings.mode === 'recent' ? settings.limit : null,
      },
    };
  };

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
    /**
     * 在「第一个字都还没吐出来」时按停止 → 撤回这条使用者讯息并把文字放回输入框。
     * 为什么必须这样：否则会留下一条没人回复的使用者讯息，
     * 下一次发送就变成两条使用者讯息连着 —— 正好破掉「只能一对」的规则。
     */
    revertOnEmptyStop?: { id: string; parentId: string | null; text: string };
  }): Promise<void> => {
    const { chatId, parentId, userText, historyPath, card, setup, configRow, controller } = input;
    const settings = await readContextSettings();
    const active = await getActive();

    // 只把窗口内的消息送进提示词；窗口外的已经由 ensureSummaries 压成摘要（共用 buildAssembly，免得两处逻辑漂移）
    const { assembled } = await buildAssembly(chatId, card, historyPath, userText, setup, configRow, settings);

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
    // 一個字都還沒吐就被停掉：不要留一條空的 assistant 訊息
    if (stopped && !acc.trim()) {
      const revert = input.revertOnEmptyStop;
      if (revert) {
        // 撤回刚发的那条使用者讯息，世界线回到发送前，并把文字放回输入框
        await db.messages.delete(revert.id);
        await db.chats.update(chatId, { currentLeafId: revert.parentId, updatedAt: Date.now() });
        set({
          messages: await pathToLeaf(chatId, revert.parentId),
          draft: '',
          streaming: false,
          error: null,
          restoreInput: revert.text,
        });
      } else {
        set({
          messages: await pathToLeaf(chatId, parentId),
          draft: '',
          streaming: false,
          error: null,
        });
      }
      return;
    }

    const status = failure ? 'error' : stopped ? 'incomplete' : 'complete';
    const assistantMsg: MessageRecord = {
      id: newId('m_'), chatId, parentId, role: 'assistant', raw: acc,
      status, tokensIn: 0, tokensOut: 0, model: modelName, createdAt: Date.now(),
    };
    await db.messages.add(assistantMsg);
    await db.chats.update(chatId, { currentLeafId: assistantMsg.id, updatedAt: Date.now() });

    // 记忆托管不再把 AI 回复里的记忆块抓进表里 —— 窗口外的内容由摘要库接管（见 ensureSummaries）
    const freshRules = await loadRulesForChat(chatId, card);
    const memories = await listSummaries(chatId);
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

  /**
   * 一次完整的「生成一輪」：先压摘要（若需要）→ 再串流主回覆。
   * send 与 branchTo 共用它，顺序固定，两条流不会并发。
   */
  const runTurn = async (input: {
    chatId: string;
    card: CardPackage;
    parentId: string;
    userText: string;
    before: MessageRecord[];
    controller: AbortController;
    revertOnEmptyStop?: { id: string; parentId: string | null; text: string };
  }): Promise<void> => {
    const { chatId, card, parentId, userText, before, controller } = input;
    const settings = await readContextSettings();
    const active = await getActive();
    const chat = await db.chats.get(chatId);
    const configRow = await db.configs.where('scope').equals('global').first();
    const summaryStreamer = active ? adapterFor(active.provider.protocol) : adapter;
    const summaryCfg = active
      ? {
          id: active.provider.id, baseUrl: active.provider.baseUrl,
          apiKey: active.provider.apiKey, extraHeaders: active.provider.extraHeaders,
        }
      : MOCK_CFG;

    // 先量一次现在的占用：决定要不要按阈值主动压（① 掉出窗口 ② 达到 triggerPercent，两者取先到者）
    const pre = await buildAssembly(chatId, card, before, userText, chat?.promptSnapshot ?? '', configRow, settings);
    await ensureSummaries({
      chatId,
      path: before,
      settings,
      streamer: summaryStreamer,
      cfg: summaryCfg,
      model: active?.preset.model ?? 'mock',
      signal: controller.signal,
      pre,
    });
    if (controller.signal.aborted) {
      set({ messages: await pathToLeaf(chatId, parentId), draft: '', streaming: false, error: null });
      return;
    }

    await streamReply({
      chatId,
      parentId,
      userText,
      historyPath: before,
      card,
      setup: chat?.promptSnapshot ?? '',
      configRow,
      controller,
      revertOnEmptyStop: input.revertOnEmptyStop,
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
    summarizing: false,
    restoreInput: null,
    error: null,

    consumeRestoreInput: () => set({ restoreInput: null }),

    init: async () => {
      /**
       * 幂等守卫：切到别的 tab 时 PlayScreen 会被卸载，切回来会重新挂载并再叫一次 init()。
       * 没有这个守卫的话，openCard() 会把 streaming / draft 重置掉 ——
       * 生成其实还在后台跑，但停止按钮变回发送、吐到一半的草稿消失，
       * 使用者看到的就是「切页面 AI 回复被截停、回来没办法停」。
       */
      if (get().ready) return;
      await db.open();
      // 旧版的「近期/永久记忆」条目一律清掉（逐条删 → 产生墓碑 → 云端也会一起清）
      await migrateMemorySchema();
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
          // 默认名字也从「对话N」开始递增（跟 newChat 一致）
          id, cardId, title: `对话${chats.length + 1}`, vars: {}, promptSnapshot: '',
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
      const memories = await listSummaries(chat.id);
      const inFlight = get().streaming || get().summarizing;
      set({
        ready: true,
        cardId,
        card,
        modelLabel: activePreset ? activePreset.provider.label + ' · ' + activePreset.preset.model : 'mock 模拟模型',
        cardName: card.json.name,
        chatId: chat.id,
        // 正在生成时不要把画面重设：draft / streaming 必须原样留着
        messages: inFlight ? get().messages : await pathToLeaf(chat.id, chat.currentLeafId),
        regexRules: displayRules(rules),
        cardUiHtml: card.json.ui?.entry ? findText(card, card.json.ui.entry) ?? null : null,
        memoryCount: memories.length,
        memories,
        error: null,
        draft: inFlight ? get().draft : '',
        streaming: inFlight ? get().streaming : false,
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

    restartSummary: () => {
      // 取消当前压缩：不写入，下次发送前会重试
      summarizeAbort?.abort();
    },

    preview: async (): Promise<ContextPreview> => {
      const { chatId, card } = get();
      const settings = await readContextSettings();
      const empty: ContextPreview = {
        rows: [], totalTokens: 0, budget: 0, droppedHistory: 0, droppedWorldbook: 0,
        windowCount: 0, windowLimit: settings.mode === 'recent' ? settings.limit : null,
        mode: settings.mode, summaryCount: 0,
      };
      if (!chatId || !card) return empty;

      const chat = await db.chats.get(chatId);
      const configRow = await db.configs.where('scope').equals('global').first();
      const path = await pathToLeaf(chatId, chat?.currentLeafId ?? null);
      const built = await buildAssembly(
        chatId, card, path, get().draft, chat?.promptSnapshot ?? '', configRow, settings,
      );

      const LABELS: Record<EntrySource, string> = {
        'card-system': '系统提示词', mod: '系统提示词',
        'card-pre': '前置词', 'config-pre': '前置词',
        'config-prompt': '全局提示词',
        'chat-setup': '初始设定',
        worldbook: '世界书', memory: '更早的对话摘要', history: '历史',
        'config-post': '后置词', 'card-post': '后置词', user: '本轮输入',
      };
      const ORDER = ['系统提示词', '前置词', '全局提示词', '初始设定', '世界书', '更早的对话摘要', '历史', '后置词', '本轮输入', '其他'];
      const orderOf = (label: string) => {
        const base = label.replace(/（.*$/, '');
        const at = ORDER.indexOf(base);
        return at < 0 ? ORDER.length : at;
      };
      const totals = new Map<string, number>();
      for (const e of built.assembled.entries) {
        const label = LABELS[e.source] ?? '其他';
        totals.set(label, (totals.get(label) ?? 0) + e.tokens);
      }
      const rows = ORDER
        .filter((label) => (totals.get(label) ?? 0) > 0)
        .map((label) => ({
          label: label === '历史' ? `历史（${built.window.windowIds.length} 条）` : label,
          tokens: totals.get(label) ?? 0,
        }));
      if (built.summaries.length > 0 && !rows.some((r) => r.label.startsWith('更早的对话摘要'))) {
        rows.push({ label: `更早的对话摘要（${built.summaries.length} 条）`, tokens: 0 });
      }
      rows.sort((a, b) => orderOf(a.label) - orderOf(b.label));

      return {
        rows,
        totalTokens: built.assembled.totalTokens,
        budget: built.budget,
        droppedHistory: built.assembled.dropped.filter((d) => d.source === 'history').length,
        droppedWorldbook: built.assembled.dropped.filter((d) => d.source === 'worldbook').length,
        windowCount: built.window.windowIds.length,
        windowLimit: built.window.limit,
        mode: built.window.mode,
        summaryCount: built.summaries.length,
      };
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
      // 压缩期间禁止发送：它要读当前上下文，中途发消息会让摘要对不上
      if (!chatId || !clean || get().streaming || get().summarizing || !card) return;
      // 同步建立取消把手（見 streamReply 的說明）：這之後到真正串流之間還有一串 await
      const controller = new AbortController();
      currentAbort = controller;

      const chat = await db.chats.get(chatId);
      const parentId = chat?.currentLeafId ?? null;
      // 严格一对：上一句还是使用者讯息（例如 AI 回复被删掉）时不再插入第二条
      if (parentId) {
        const tail = await db.messages.get(parentId);
        if (tail?.role === 'user') {
          set({ error: '上一轮还没有回复。请先按「重新生成」，或删掉那条消息再发。' });
          return;
        }
      }

      const userMsg: MessageRecord = {
        id: newId('m_'), chatId, parentId, role: 'user', raw: clean,
        status: 'complete', tokensIn: 0, tokensOut: 0, model: '', createdAt: Date.now(),
      };
      await db.messages.add(userMsg);
      await db.chats.update(chatId, { currentLeafId: userMsg.id, updatedAt: Date.now() });

      const historyPath = await pathToLeaf(chatId, userMsg.id);
      const before = historyPath.slice(0, -1);
      // 畫面上要立刻看到剛送出的使用者訊息；提示詞的歷史則不含這一則（它在 userInput 裡）
      set({ messages: historyPath, draft: '', streaming: true, error: null });

      await runTurn({
        chatId, card, parentId: userMsg.id, userText: clean, before, controller,
        revertOnEmptyStop: { id: userMsg.id, parentId, text: clean },
      });
    },

    stop: () => {
      // 可能還在「組提示詞」階段：abort 之後 streamReply 會在最前面就收工
      currentAbort?.abort();
      summarizeAbort?.abort();
    },

    openChat: async (chatId: string) => {
      const chat = await db.chats.get(chatId);
      if (!chat) return;
      const card = await loadCardPackage(chat.cardId);
      if (!card) return;
      const rules = await loadRulesForChat(chatId, card);
      const memories = await listSummaries(chatId);
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
      // 默认名字从「对话1」开始递增（使用者要求：不要再叫「卡片名 + 日期」）
      const existing = await db.chats.where('cardId').equals(cardId).count();
      await db.chats.add({
        id: chatId, cardId, title: `对话${existing + 1}`,
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
      await deleteSummary(id);
      const { chatId } = get();
      if (!chatId) return;
      const memories = await listSummaries(chatId);
      set({ memories, memoryCount: memories.length });
    },

    /**
     * 「从这里重开」：把世界线指针移回这一条，并**立刻生成一条新的 AI 回复**。
     * 以前只移动指针、不生成，使用者还得自己复制一次再送 —— 那不算重开。
     */
    branchTo: async (messageId: string) => {
      const { chatId, card } = get();
      if (!chatId || !card || get().streaming || get().summarizing) return;
      await db.chats.update(chatId, { currentLeafId: messageId, updatedAt: Date.now() });
      const path = await pathToLeaf(chatId, messageId);
      set({ messages: path, error: null });
      const target = path[path.length - 1];
      if (!target || target.role !== 'user') return; // 落在 AI 消息上就只是回溯，不生成

      const controller = new AbortController();
      currentAbort = controller;
      set({ draft: '', streaming: true });
      await runTurn({
        chatId,
        card,
        parentId: target.id,
        userText: target.raw,
        before: path.slice(0, -1),
        controller,
      });
    },

    regenerate: async () => {
      const { chatId, messages, streaming, summarizing, card } = get();
      if (!chatId || streaming || summarizing || messages.length < 2 || !card) return;
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      if (!lastUser) return;
      const controller = new AbortController();
      currentAbort = controller;
      await db.chats.update(chatId, { currentLeafId: lastUser.id, updatedAt: Date.now() });
      // 重新生成＝替同一则使用者訊息再挂一个 assistant 分支；
      // 以前是「把 leaf 指回去再呼叫 send」，那会**多插一条一模一样的用户訊息**。
      const historyPath = await pathToLeaf(chatId, lastUser.parentId);
      set({ messages: [...historyPath, lastUser], draft: '', streaming: true, error: null });
      await runTurn({
        chatId,
        card,
        parentId: lastUser.id,
        userText: lastUser.raw,
        before: historyPath,
        controller,
      });
    },
  };
});