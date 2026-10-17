import { describe, it, expect } from 'vitest';
import { planSummaryGroups } from './summaryPlan';

/** n 条消息 = n/2 个交换：u1,a1,u2,a2... */
function msgs(n: number) {
  const out: { id: string; role: 'user' | 'assistant'; raw: string }[] = [];
  for (let i = 0; i < n; i += 1) {
    const pair = Math.floor(i / 2) + 1;
    out.push(i % 2 === 0
      ? { id: 'u' + pair, role: 'user', raw: '第' + pair + '句' }
      : { id: 'a' + pair, role: 'assistant', raw: '回复' + pair });
  }
  return out;
}

const base = {
  summaries: [] as { toMessageId?: string }[],
  totalTokens: 100,
  budget: 1000,
  triggerPercent: 90,
  batchPairs: 1,
  maxPairsPerRun: 6,
  targetPercent: 75,
  estimate: () => 10,
};

describe('摘要计划：压哪几对、怎么分组', () => {
  it('没到阈值：只压掉出窗口的交换', () => {
    const plan = planSummaryGroups({ ...base, path: msgs(6), windowIds: ['u3', 'a3'] });
    expect(plan.picked.map((e) => e.ids[0])).toEqual(['u1', 'u2']);
  });

  it('没攒够 batch 对：这一轮不动手（留到下一轮）', () => {
    const plan = planSummaryGroups({ ...base, path: msgs(4), windowIds: ['u2', 'a2'], batchPairs: 2 });
    expect(plan.groups).toHaveLength(0);
  });

  it('攒够 batch 对：N 对合成 1 条摘要（一组）', () => {
    const plan = planSummaryGroups({ ...base, path: msgs(8), windowIds: ['u4', 'a4'], batchPairs: 2 });
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].flatMap((e) => e.ids)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('没攒够一整组的余数不压', () => {
    // 4 对里掉出 3 对，batch = 2 → 只压前 2 对，剩 1 对留到下一轮
    const plan = planSummaryGroups({ ...base, path: msgs(8), windowIds: ['u4', 'a4'], batchPairs: 2 });
    expect(plan.picked).toHaveLength(2);
  });

  it('已压成摘要的交换不再压（从 coverage 之后开始）', () => {
    const plan = planSummaryGroups({
      ...base, path: msgs(6), windowIds: ['u3', 'a3'], summaries: [{ toMessageId: 'a1' }],
    });
    expect(plan.picked.map((e) => e.ids[0])).toEqual(['u2']);
  });

  it('达到阈值：即使没掉出窗口也压，而且压到目标占用就停手', () => {
    // 每条消息估算 300：一对 600，压掉一对省 400 → 950 → 550（< 750 目标）
    const plan = planSummaryGroups({
      ...base,
      path: msgs(6),
      windowIds: msgs(6).map((m) => m.id),   // 全部带模式：没有掉出窗口的
      totalTokens: 950,
      estimate: () => 300,
      batchPairs: 1,
    });
    expect(plan.picked).toHaveLength(1);
    expect(plan.picked[0].ids[0]).toBe('u1');
  });

  it('达到阈值时一次最多压 maxPairsPerRun 对', () => {
    const plan = planSummaryGroups({
      ...base,
      path: msgs(20),
      windowIds: msgs(20).map((m) => m.id),
      totalTokens: 990,
      estimate: () => 300,
      batchPairs: 1,
      maxPairsPerRun: 6,
    });
    expect(plan.picked.length).toBeLessThanOrEqual(6);
  });

  it('全部被压过 / 没有候选 → 空计划', () => {
    const plan = planSummaryGroups({
      ...base, path: msgs(4), windowIds: [], summaries: [{ toMessageId: 'a2' }],
    });
    expect(plan.groups).toHaveLength(0);
  });
});
