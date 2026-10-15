import { describe, it, expect } from 'vitest';
import { buildExchanges, computeWindow } from './window';

const M = (id: string, role: 'user' | 'assistant') => ({ id, role });

describe('上下文窗口与成对规则', () => {
  it('user + 紧跟的 assistant 是一个交换', () => {
    expect(buildExchanges([M('u1', 'user'), M('a1', 'assistant')]))
      .toEqual([{ ids: ['u1', 'a1'], complete: true }]);
  });

  it('开场白（没有对应用户输入）自成完整单位', () => {
    expect(buildExchanges([M('a0', 'assistant'), M('u1', 'user'), M('a1', 'assistant')]))
      .toEqual([{ ids: ['a0'], complete: true }, { ids: ['u1', 'a1'], complete: true }]);
  });

  it('未完成的交换（用户发了但 AI 没回）标记 incomplete', () => {
    expect(buildExchanges([M('u1', 'user'), M('u2', 'user')]))
      .toEqual([{ ids: ['u1', 'u2'], complete: false }]);
  });

  it('recent：切点落在交换中间时，整个交换都算窗口外（向外扩）', () => {
    const msgs = [M('u1', 'user'), M('a1', 'assistant'), M('u2', 'user'), M('a2', 'assistant')];
    // limit=3 → 朴素切点是 a2，切开了 (u2,a2) → 整对推到窗口外 → 窗口只剩 a2 的前一条？不会：整对都出去后窗口为空？
    // 规则：先把 (u2,a2) 推出去 → 窗口候选为空 → 但 recent 至少保留最后一个完整交换 → window = (u2,a2)
    const r3 = computeWindow({ messages: msgs, mode: 'recent', limit: 3 });
    expect(r3.windowIds).toEqual(['u2', 'a2']);
    expect(r3.outsideIds).toEqual(['u1', 'a1']);
  });

  it('recent：limit 很小也不会把最新一轮压掉（至少留最后一个交换）', () => {
    const msgs = [M('u1', 'user'), M('a1', 'assistant'), M('u2', 'user'), M('a2', 'assistant')];
    const r = computeWindow({ messages: msgs, mode: 'recent', limit: 1 });
    expect(r.windowIds).toEqual(['u2', 'a2']);
  });

  it('recent：窗口外的部分按原顺序回传', () => {
    const msgs: { id: string; role: 'user' | 'assistant' }[] = [];
    for (let i = 1; i <= 10; i += 1) msgs.push(M(`u${i}`, 'user'), M(`a${i}`, 'assistant'));
    const r = computeWindow({ messages: msgs, mode: 'recent', limit: 4 });
    expect(r.windowIds).toEqual(['u9', 'a9', 'u10', 'a10']);
    expect(r.outsideIds).toHaveLength(16);
    expect(r.outsideIds[0]).toBe('u1');
  });

  it('未完成的尾部交换不会被挤出窗口（不压半对）', () => {
    const msgs = [
      M('u1', 'user'), M('a1', 'assistant'), M('u2', 'user'), M('a2', 'assistant'),
      M('u3', 'user'), M('a3', 'assistant'), M('u4', 'user'),
    ];
    const r = computeWindow({ messages: msgs, mode: 'recent', limit: 4 });
    expect(r.windowIds).toContain('u4');
    expect(r.outsideIds).not.toContain('u4');
  });

  it('all 模式：用 assemble 保留的 id 判定窗口内外，边界同样对齐到交换', () => {
    const msgs = [M('u1', 'user'), M('a1', 'assistant'), M('u2', 'user'), M('a2', 'assistant')];
    // 只保留了 a2（等于把 (u2,a2) 切开了）→ 整个交换都算窗口外
    const r = computeWindow({ messages: msgs, mode: 'all', limit: 0, keptIds: new Set(['a2']) });
    expect(r.windowIds).toEqual([]);
    expect(r.outsideIds).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('all 模式：保留的是最后两对时，前两对算窗口外', () => {
    const msgs = [M('u1', 'user'), M('a1', 'assistant'), M('u2', 'user'), M('a2', 'assistant')];
    const r = computeWindow({ messages: msgs, mode: 'all', limit: 0, keptIds: new Set(['u2', 'a2']) });
    expect(r.windowIds).toEqual(['u2', 'a2']);
    expect(r.outsideIds).toEqual(['u1', 'a1']);
  });

  it('空输入回两个空数组', () => {
    expect(computeWindow({ messages: [], mode: 'recent', limit: 6 })).toEqual({ windowIds: [], outsideIds: [] });
  });
});
