import { SUMMARY_MAX_CHARS } from '../storage/types';
import type { ProviderAdapter, ProviderConfig, StreamEvent } from '../providers/types';

/**
 * 把「掉出上下文窗口的交换」压成一段摘要。
 *
 * 这个模块**不碰数据库**：只负责组提示词、调一次模型、把输出解析成
 * 「用户」与「叙事」两段。存哪里、什么时候存由 `state/useSession.ts` 决定。
 *
 * 为什么一定要分两段：使用者明确交代过 —— 摘要注回上下文时要能分清
 * 「玩家说过什么」和「AI 写过什么」，否则 AI 会把玩家的选择当成自己写的。
 */

export interface SummaryPart {
  userText: string;
  assistantText: string;
}

export interface SummaryMessage {
  role: 'user' | 'assistant';
  content: string;
}

const PREVIOUS_TAIL = 200;

export function buildSummaryPrompt(batch: SummaryMessage[], previousTail?: string): string {
  const lines: string[] = [];
  lines.push('你在帮一个角色扮演应用整理长期记忆。把下面这一段对话压缩成一段摘要：');
  lines.push('');
  lines.push('1. 用叙事性的文学笔法写，保留细节与氛围，不要写成干巴巴的条目列表。');
  lines.push('2. 必须保留：出现的人物与其关系变化、已发生的关键事件、当前时间/地点/身体与情绪状态、');
  lines.push('   任何已经确立的约定或规则。');
  lines.push('3. 分两部分输出，各自以固定标记开头：');
  lines.push('   用户：<玩家这一方说过、做过、选择过的事>');
  lines.push('   叙事：<AI 这一方写过的事>');
  lines.push(`4. 每部分不超过 ${SUMMARY_MAX_CHARS} 字。`);
  lines.push('5. 不要添加原文没有的内容，不要评论，不要输出其它内容。');
  if (previousTail) {
    lines.push('');
    lines.push('（下面是上一段时期已经写好的摘要结尾，仅供衔接语气与时间线，不要重复它）');
    lines.push(previousTail.slice(-PREVIOUS_TAIL));
  }
  lines.push('');
  lines.push('===== 要压缩的对话 =====');
  for (const m of batch) {
    lines.push((m.role === 'user' ? '[用户] ' : '[AI] ') + m.content);
  }
  return lines.join('\n');
}

function clip(text: string): string {
  const t = text.trim();
  return t.length > SUMMARY_MAX_CHARS ? t.slice(0, SUMMARY_MAX_CHARS) : t;
}

export function parseSummaryParts(raw: string): SummaryPart {
  const text = raw.trim();
  const userMatch = text.match(/用户\s*[:：]\s*([\s\S]*?)(?=\n\s*叙事\s*[:：]|$)/);
  const narrativeMatch = text.match(/叙事\s*[:：]\s*([\s\S]*)$/);
  if (narrativeMatch) {
    return {
      userText: clip(userMatch?.[1] ?? ''),
      assistantText: clip(narrativeMatch[1]),
    };
  }
  // 模型没按标记输出：整段当叙事，userText 留空（上层会标记「格式未识别」）
  return { userText: '', assistantText: clip(text) };
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

export async function summarizeBatch(input: {
  adapter: ProviderAdapter;
  cfg: ProviderConfig;
  model: string;
  batch: SummaryMessage[];
  previousTail?: string;
  signal?: AbortSignal;
}): Promise<SummaryPart> {
  const { adapter, cfg, model, batch, previousTail, signal } = input;
  const prompt = buildSummaryPrompt(batch, previousTail);

  let acc = '';
  let failure: string | null = null;
  for await (const ev of adapter.streamChat(cfg, {
    model,
    messages: [{ role: 'user', content: prompt, position: 'post' }],
    params: { temperature: 0.3, topP: 0.95, presencePenalty: 0, frequencyPenalty: 0, maxTokens: 800, contextLength: 32000, thinkingBudget: 0 },
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
  return parseSummaryParts(acc);
}
