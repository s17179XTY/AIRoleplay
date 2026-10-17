import { estimateTokens } from './budget';
import { buildExchanges, coveredEndIndex, type Exchange } from './window';

/**
 * 摘要压缩的「压哪几对、怎么分组」纯逻辑（不碰数据库、不调模型）。
 *
 * 使用者 2026-10-15 回饋後定稿：
 * - **已压成摘要的消息不再作为候选**（前缀 coverage），否则会重复压、而且原文 + 摘要双份注入；
 * - 触发条件取先到者：① 上下文占用 >= triggerPercent；② 有交换掉出窗口；
 * - 「攒够几对再压缩」= batchPairs 对**合成一条摘要**；没攒够就等下一轮；
 * - 没到阈值时只压窗口外的交换；达到阈值时从最老的开始压，压到约 targetPercent 停手。
 */
export interface PlanMessage {
  id: string;
  role: 'user' | 'assistant';
  raw: string;
}

export interface PlanSummary {
  toMessageId?: string;
}

export interface SummaryPlanInput {
  path: PlanMessage[];
  /** 这一次装配后真正进提示词的历史 id */
  windowIds: string[];
  summaries: PlanSummary[];
  /** 当前装配出来的上下文占用（token）与预算 */
  totalTokens: number;
  budget: number;
  triggerPercent: number;
  /** 攒够几对，合成一条摘要 */
  batchPairs: number;
  maxPairsPerRun: number;
  targetPercent: number;
  estimate?: (text: string) => number;
}

export interface SummaryPlan {
  /** 每组 = 要合成的一条摘要里的若干对（按时间从旧到新） */
  groups: Exchange[][];
  picked: Exchange[];
}

const EMPTY: SummaryPlan = { groups: [], picked: [] };

export function planSummaryGroups(input: SummaryPlanInput): SummaryPlan {
  const estimate = input.estimate ?? estimateTokens;
  const { path } = input;
  if (path.length === 0) return EMPTY;

  const coveredEnd = coveredEndIndex(path, input.summaries);
  const idxOf = new Map(path.map((m, i) => [m.id, i]));
  const windowSet = new Set(input.windowIds);
  const candidates = buildExchanges(path.map((m) => ({ id: m.id, role: m.role })))
    .filter((ex) => (idxOf.get(ex.ids[0]) ?? -1) > coveredEnd);
  if (candidates.length === 0) return EMPTY;

  const pairTokens = (ex: Exchange): number => ex.ids.reduce((sum, id) => {
    const row = path[idxOf.get(id)!];
    return sum + estimate(row.raw);
  }, 0);

  const budget = input.budget;
  const triggerTokens = budget > 0 ? budget * (input.triggerPercent / 100) : Number.POSITIVE_INFINITY;
  const targetTokens = budget > 0 ? budget * (input.targetPercent / 100) : 0;
  const batch = Math.max(1, input.batchPairs);

  const picked: Exchange[] = [];
  const triggerMet = input.totalTokens >= triggerTokens;

  if (triggerMet) {
    let projected = input.totalTokens;
    for (const ex of candidates) {
      if (picked.length >= input.maxPairsPerRun) break;
      if (picked.length > 0 && projected <= targetTokens) break;
      picked.push(ex);
      projected -= Math.max(0, pairTokens(ex) - 200);
    }
    if (picked.length === 0) return EMPTY;
  } else {
    const outside = candidates.filter((ex) => !windowSet.has(ex.ids[0]));
    if (outside.length < batch) return EMPTY;
    for (const ex of outside) {
      if (picked.length >= input.maxPairsPerRun) break;
      picked.push(ex);
    }
    // 没攒够一整组的余数留到下一轮（「攒够几对再压」的语义）
    const whole = Math.floor(picked.length / batch) * batch;
    if (whole === 0) return EMPTY;
    picked.length = Math.min(picked.length, whole);
  }

  const groups: Exchange[][] = [];
  for (let i = 0; i < picked.length; i += batch) groups.push(picked.slice(i, i + batch));
  return { groups, picked };
}
