import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import {
  addSummary, deleteSummary, listSummaries, toSummaryItems, trimSummaries, updateSummaryText,
} from './memoryStore';
import { SUMMARY_KEEP, SUMMARY_MERGE_BATCH } from './types';

beforeEach(async () => {
  await db.memories.clear();
});

const add = (i: number) => addSummary({
  chatId: 'c1',
  userText: `用户${i}`,
  assistantText: `叙事${i}`,
  text: `[用户] 用户${i}\n[叙事] 叙事${i}`,
  dateLabel: `10-${String(i).padStart(2, '0')}`,
  origin: 'model',
});

describe('摘要库', () => {
  it('写入后按 order 升序读回，且能转成注入用的 SummaryItem', async () => {
    await add(1);
    await add(2);
    const list = await listSummaries('c1');
    expect(list).toHaveLength(2);
    expect(list[0].dateLabel).toBe('10-01');
    expect(list[0].tier).toBe('summary');

    const items = toSummaryItems(list);
    expect(items[0].userText).toBe('用户1');
    expect(items[0].assistantText).toBe('叙事1');
    expect(items[0].text).toContain('[叙事] 叙事1');
  });

  it('上限内不合并', async () => {
    for (let i = 1; i <= SUMMARY_KEEP; i += 1) await add(i);
    const r = await trimSummaries('c1');
    expect(r.merged).toBe(0);
    expect(await listSummaries('c1')).toHaveLength(SUMMARY_KEEP);
  });

  it('超过上限时，最老的一批本地拼接成一条（保留分段与时间范围）', async () => {
    for (let i = 1; i <= SUMMARY_KEEP + 1; i += 1) await add(i);

    const r = await trimSummaries('c1');

    expect(r.merged).toBe(1);
    const list = await listSummaries('c1');
    // 101 条 → 最老 SUMMARY_MERGE_BATCH 条併成 1 条 → 回到上限以内
    expect(list).toHaveLength(SUMMARY_KEEP + 1 - SUMMARY_MERGE_BATCH + 1);
    expect(list[0].origin).toBe('merged');
    expect(list[0].userText).toContain('用户1');
    expect(list[0].assistantText).toContain(`叙事${SUMMARY_MERGE_BATCH}`);
    expect(list[0].text).toContain('[叙事]');
    expect(list[0].dateLabel).toContain('10-01');
    expect(list[0].dateLabel).toContain(`10-${String(SUMMARY_MERGE_BATCH).padStart(2, '0')}`);
    // 上限放宽到 100 条（一对一项摘要，20 条会很快满库又不停合并）
    expect(SUMMARY_KEEP).toBe(100);
    // 被合并掉的旧条目真的删了
    expect(list.some((s) => s.userText === '用户1')).toBe(false);
  });

  it('可以手动改与删（AI 压歪了还能救）', async () => {
    const row = await add(1);
    await updateSummaryText(row.id, '[用户] 改过的用户段\n[叙事] 改过的叙事段', '改过的用户段', '改过的叙事段');
    const after = (await listSummaries('c1'))[0];
    expect(after.userText).toBe('改过的用户段');

    await deleteSummary(row.id);
    expect(await listSummaries('c1')).toHaveLength(0);
  });

  it('不同会话的摘要互不影响', async () => {
    await add(1);
    await addSummary({ chatId: 'c2', text: 'x', dateLabel: '10-01', origin: 'model' });
    expect(await listSummaries('c1')).toHaveLength(1);
    expect(await listSummaries('c2')).toHaveLength(1);
  });
});
