import { SUMMARY_MAX_CHARS } from '../storage/types';
import type { ProviderAdapter, ProviderConfig, StreamEvent } from '../providers/types';

/**
 * 把「掉出上下文窗口的交换」压成摘要。
 *
 * 这个模块**不碰数据库**：只负责组提示词、调一次模型、把输出解析成
 * 每对一段的「用户 / 叙事」两段式结果。
 *
 * 使用者的要求（2026-10-15）：**一对一项摘要**；但一次请求可以压多对
 * （否则一次要压 6 对就要连发 6 次请求，又慢又容易失败），
 * 所以提示词要求模型按 `### 1` `### 2` … 编号输出，回来再拆成多项存储。
 */

export interface SummaryPart {
  userText: string;
  assistantText: string;
}

export interface SummaryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** 一个「交换」= 一组消息（通常是一条用户消息 + 它的 AI 回复） */
export type SummaryPair = SummaryMessage[];

const PREVIOUS_TAIL = 200;

export function buildSummaryPrompt(
  pairs: SummaryPair[],
  previousTail?: string,
  /** 每一部分允许的最大字数：攒够 N 对合成一条摘要时要按 N 放大，否则多条对话会被压成 200 字丢信息 */
  maxChars: number = SUMMARY_MAX_CHARS,
): string {
  const lines: string[] = [];
  lines.push(`你在帮一个角色扮演应用整理长期记忆。下面有 ${pairs.length} 段对话，请**各自**压成一段摘要。`);
  lines.push('');
  lines.push('每段都要遵守：');
  lines.push('1. 用叙事性的文学笔法写，保留细节与氛围，不要写成干巴巴的条目列表。');
  lines.push('2. 必须保留：出现的人物与其关系变化、已发生的关键事件、当前时间/地点/身体与情绪状态、');
  lines.push('   任何已经确立的约定或规则。');
  lines.push('3. 分两部分写，各自以固定标记开头：');
  lines.push('   用户：<玩家这一方说过、做过、选择过的事>');
  lines.push('   叙事：<AI 这一方写过的事>');
  lines.push(`4. 每部分不超过 ${maxChars} 字。`);
  lines.push('5. 不要添加原文没有的内容，不要评论。');
  lines.push('6. **摘要必须比原文更短**：原文很短时也要更短，不要扩写、不要补背景。');
  lines.push('');
  lines.push('输出格式（**必须**照这个编号，一段都不要合并、顺序不要变）：');
  lines.push('### 1');
  lines.push('用户：…');
  lines.push('叙事：…');
  lines.push('### 2');
  lines.push('用户：…');
  lines.push('叙事：…');
  if (previousTail) {
    lines.push('');
    lines.push('（下面是上一段时期已经写好的摘要结尾，仅供衔接语气与时间线，不要重复它）');
    lines.push(previousTail.slice(-PREVIOUS_TAIL));
  }
  lines.push('');
  lines.push('===== 要压缩的对话 =====');
  pairs.forEach((pair, i) => {
    lines.push(`----- 第 ${i + 1} 段 -----`);
    for (const m of pair) lines.push((m.role === 'user' ? '[用户] ' : '[AI] ') + m.content);
  });
  return lines.join('\n');
}

function clip(text: string, maxChars: number = SUMMARY_MAX_CHARS): string {
  const t = text.trim();
  return t.length > maxChars ? t.slice(0, maxChars) : t;
}

function parseOne(text: string, maxChars: number = SUMMARY_MAX_CHARS): SummaryPart {
  const body = text.trim();
  const userMatch = body.match(/用户\s*[:：]\s*([\s\S]*?)(?=\n\s*叙事\s*[:：]|$)/);
  const narrativeMatch = body.match(/叙事\s*[:：]\s*([\s\S]*)$/);
  if (narrativeMatch) {
    return { userText: clip(userMatch?.[1] ?? '', maxChars), assistantText: clip(narrativeMatch[1], maxChars) };
  }
  // 模型没按标记输出：整段当叙事，userText 留空（上层会标记「格式未识别」）
  return { userText: '', assistantText: clip(body, maxChars) };
}

/** 解析单段（旧接口，保留给测试与兜底路径） */
export function parseSummaryParts(raw: string): SummaryPart {
  return parseOne(raw);
}

/**
 * 解析成「每对一段」。按 `### n` 切；切不出来时退化成「整段当第一段」，
 * 剩下的段落用兜底文案补齐（宁可粗糙也不能丢）。
 */
export function parseSummarySections(raw: string, count: number, maxChars: number = SUMMARY_MAX_CHARS): SummaryPart[] {
  const text = raw.trim();
  const marked = text.split(/^\s*#{2,4}\s*\d+\s*$/m).map((s) => s.trim()).filter(Boolean);
  const sections = marked.length >= 1 && /用户\s*[:：]|叙事\s*[:：]/.test(text) ? marked : [text];
  const out: SummaryPart[] = [];
  for (let i = 0; i < count; i += 1) {
    if (i < sections.length && sections[i]) out.push(parseOne(sections[i], maxChars));
    else out.push({ userText: '', assistantText: '（这一段没有生成摘要，原文已按窗口规则出栈）' });
  }
  return out;
}

/** 连续失败多次后的兜底：不调模型，至少把「哪一段、用户当时说了什么」记下来 */
export function skeletonSummary(batch: SummaryMessage[], fromIndex: number, toIndex: number): SummaryPart {
  const firstUser = batch.find((m) => m.role === 'user')?.content ?? '';
  const head = firstUser.replace(/\s+/g, ' ').trim().slice(0, 40);
  const span = `第 ${fromIndex}–${toIndex} 条`;
  return {
    userText: '',
    assistantText: `${span}的对话（模型压缩失败，暂存骨架）：用户当时输入「${head}…」`,
  };
}

/** 调一次模型压一批（每对一段），回传与传入顺序一一对应的结果 */
export async function summarizePairs(input: {
  adapter: ProviderAdapter;
  cfg: ProviderConfig;
  model: string;
  pairs: SummaryPair[];
  previousTail?: string;
  /** 每部分允许的最大字数（多对合成一条摘要时按对数放大） */
  maxChars?: number;
  signal?: AbortSignal;
}): Promise<SummaryPart[]> {
  const { adapter, cfg, model, pairs, previousTail, maxChars, signal } = input;
  const prompt = buildSummaryPrompt(pairs, previousTail, maxChars);

  let acc = '';
  let failure: string | null = null;
  for await (const ev of adapter.streamChat(cfg, {
    model,
    messages: [{ role: 'user', content: prompt, position: 'post' }],
    params: { temperature: 0.3, topP: 0.95, presencePenalty: 0, frequencyPenalty: 0, maxTokens: 1200, contextLength: 32000, thinkingBudget: 0 },
    capabilities: {
      temperature: true, topP: true, presencePenalty: false, frequencyPenalty: false,
      maxTokens: true, contextLength: 32000, thinkingBudget: false, prefill: false, systemRole: false,
    },
    signal,
  }) as AsyncGenerator<StreamEvent>) {
    if (ev.type === 'text') acc += ev.delta;
    else if (ev.type === 'error') failure = ev.message;
  }

  if (failure) throw new Error(failure);
  if (!acc.trim()) throw new Error('摘要模型没有返回内容');
  return parseSummarySections(acc, pairs.length, maxChars);
}

/** @deprecated 旧的一次压一批（不分段）接口，测试仍在用 */
export async function summarizeBatch(input: {
  adapter: ProviderAdapter;
  cfg: ProviderConfig;
  model: string;
  batch: SummaryMessage[];
  previousTail?: string;
  signal?: AbortSignal;
}): Promise<SummaryPart> {
  const [first] = await summarizePairs({ ...input, pairs: [input.batch] });
  return first;
}