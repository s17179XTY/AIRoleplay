import { estimateTokens } from './budget';
import { applyMacros } from './macros';
import { scanWorldbook } from './worldbook';
import type { AssembledRequest, AssembleInput, PromptEntry } from './types';

const POSITION_RANK: Record<PromptEntry['position'], number> = {
  pre: 0, system: 1, 'before-history': 2, history: 3, 'after-history': 4, post: 5,
};

let seq = 0;

export function assemble(input: AssembleInput): AssembledRequest {
  const { card, config, limits } = input;
  const entries: PromptEntry[] = [];

  const push = (
    source: PromptEntry['source'],
    position: PromptEntry['position'],
    content: string,
    role: PromptEntry['role'] = 'system',
    priority = 0,
    mutable = false,
  ) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    seq += 1;
    entries.push({
      id: 'e' + seq, source, position, content: trimmed, role, priority, mutable,
      tokens: estimateTokens(trimmed),
    });
  };

  /*
   * 注入顺序（使用者 2026-10-15 定稿）：
   *   1 卡片提示词 → 2 MOD → 3 卡片前缀词 → 4 全局前缀词 → 5 全局提示词
   *   → 6 互动页【初始信息设定】→ 7 世界书 → 8 更早的对话摘要 → 9 历史消息
   *   → 10 全局后置词 → 11 卡片后置词 → 12 本轮输入
   *
   * 不再注入：卡片**简介**（只是列表上的介绍）、**主人公设定**、**前情提要**
   * （后两者由互动页产出的【初始信息设定】取代；JSON 字段保留，导入的卡不会坏）。
   */
  push('card-system', 'system', applyMacros(card.prompt, input.macros), 'system', 10);
  // MOD：紧接卡片提示词，套用后立即生效（每轮都重新组装，天然热插拔）
  for (const m of input.mods ?? []) {
    push('mod', 'system', applyMacros(m.content, input.macros), 'system', 20);
  }
  push('card-pre', 'system', applyMacros(card.pre, input.macros), 'system', 30);
  push('config-pre', 'system', applyMacros(config.prePrompt, input.macros), 'system', 40);
  push('config-prompt', 'system', applyMacros(config.prompt, input.macros), 'system', 50);
  push('chat-setup', 'system', input.setup ?? '', 'system', 60);

  const wb = scanWorldbook(
    input.worldbook,
    [...input.history.map((h) => ({ role: h.role, content: h.content })), { role: 'user', content: input.userInput }],
    input.worldbookMatch,
  );
  for (const w of wb) {
    push('worldbook', 'before-history', applyMacros(w.content, input.macros), 'system',
      w.position === 'after-char' ? 100 + w.order : 50 + w.order, true);
  }

  // 掉出窗口的历史压成的摘要：紧贴历史之前，并且明确标注「不是最新消息」，
  // 否则 AI 会把摘要当成最新资讯（使用者特别交代过这一点）
  const summaries = input.summaries ?? [];
  if (summaries.length > 0) {
    const body = summaries
      .map((s) => '— ' + s.dateLabel + (s.rangeLabel ? '（' + s.rangeLabel + '）' : '') + ' —\n' + s.text)
      .join('\n\n');
    push(
      'memory', 'before-history',
      '【更早的对话摘要 · 以下内容发生在当前对话之前，不是最新消息】\n' + body +
        '\n\n【以上是更早的摘要，以下是最近的原文对话】',
      'system', 200,
    );
  }

  input.history.forEach((m, i) => {
    push('history', 'history', applyMacros(m.content, input.macros), m.role, i, true);
  });

  // 后置词：全局在前、卡片在后（使用者指定）
  push('config-post', 'post', applyMacros(config.postPrompt, input.macros), 'system', 10);
  push('card-post', 'post', applyMacros(card.post, input.macros), 'system', 20);
  push('user', 'post', input.userInput, 'user', 30);

  entries.sort((a, b) =>
    POSITION_RANK[a.position] - POSITION_RANK[b.position] || a.priority - b.priority);

  const budgetTotal = limits.contextLength - limits.maxTokens - limits.reserve;
  let total = entries.reduce((s, e) => s + e.tokens, 0);
  const dropped: PromptEntry[] = [];

  if (total > budgetTotal) {
    const historyOldestFirst = entries
      .filter((e) => e.source === 'history')
      .sort((a, b) => a.priority - b.priority);
    const wbLowFirst = entries
      .filter((e) => e.source === 'worldbook')
      .sort((a, b) => a.priority - b.priority);
    for (const cand of [...historyOldestFirst, ...wbLowFirst]) {
      if (total <= budgetTotal) break;
      total -= cand.tokens;
      dropped.push(cand);
    }
  }

  const kept = entries.filter((e) => !dropped.includes(e));
  return {
    entries: kept,
    dropped,
    totalTokens: kept.reduce((s, e) => s + e.tokens, 0),
    activatedWorldbook: wb.map((w) => w.id),
  };
}
