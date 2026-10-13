import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { ingestMemories, listMemories, toMemoryItems } from './memoryStore';

beforeEach(async () => {
  await db.memories.clear();
});

const mk = (text: string, dateLabel = '2026-10-13') => ({ tier: 'recent' as const, text, dateLabel });

describe('记忆托管', () => {
  it('写入近期记忆并可回注', async () => {
    await ingestMemories('c1', 'm1', [mk('第一件事')], 4);
    const list = await listMemories('c1');
    expect(list).toHaveLength(1);
    expect(list[0].tier).toBe('recent');
    expect(toMemoryItems(list)[0].text).toBe('第一件事');
  });

  it('一次溢出多条时合并区间并标注日期范围', async () => {
    await ingestMemories('c2', 'm1', [mk('A事', '2026-10-01'), mk('B事', '2026-10-02'), mk('C事', '2026-10-03')], 1);
    const list = await listMemories('c2');
    const permanent = list.filter((r) => r.tier === 'permanent');
    expect(permanent).toHaveLength(1);
    expect(permanent[0].text).toContain('A事');
    expect(permanent[0].text).toContain('B事');
    expect(permanent[0].dateLabel).toBe('2026-10-01 至 2026-10-02');
    expect(list.filter((r) => r.tier === 'recent')).toHaveLength(1);
  });

  it('超过上限时把最旧的合并成永久记忆', async () => {
    for (let i = 1; i <= 4; i += 1) {
      await ingestMemories('c1', 'm' + i, [mk('第' + i + '件事', '2026-10-0' + i)], 4);
    }
    await ingestMemories('c1', 'm5', [mk('第五件事', '2026-10-05')], 4);
    const list = await listMemories('c1');
    const permanent = list.filter((r) => r.tier === 'permanent');
    const recent = list.filter((r) => r.tier === 'recent');
    expect(permanent).toHaveLength(1);
    expect(permanent[0].text).toContain('第1件事');
    expect(permanent[0].dateLabel).toBe('2026-10-01');
    expect(recent).toHaveLength(4);
    const items = toMemoryItems(list);
    expect(items[0].tier).toBe('permanent');
    expect(items[items.length - 1].text).toBe('第五件事');
  });
});
