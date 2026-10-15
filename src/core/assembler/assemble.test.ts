import { describe, it, expect } from 'vitest';
import { assemble } from './assemble';
import { estimateTokens } from './budget';
import { applyMacros } from './macros';
import type { AssembleInput } from './types';

const base: AssembleInput = {
  card: {
    pre: '前置词内容', prompt: '系统提示词', post: '后置词内容',
    description: '角色简介', persona: '主人公设定', scenario: '前情提要',
  },
  config: { prompt: '全局提示词', prePrompt: '全局前置词', postPrompt: '全局后置词' },
  worldbook: [],
  summaries: [],
  history: [
    { id: 'h1', role: 'assistant', content: '第一轮' },
    { id: 'h2', role: 'user', content: '第二轮' },
  ],
  userInput: '玩家输入',
  macros: { user: '我', char: '苏小染', persona: '设定', date: '2026-10-13', time: '14:00', weekday: '周二' },
  limits: { contextLength: 100000, maxTokens: 1000, reserve: 512, worldbookTokenBudget: 2000 },
};

describe('装配内核', () => {
  it('顺序：前置词 → 全局提示词 → 卡片提示词 → 设定 → 历史 → 后置词 → 用户输入', () => {
    const r = assemble(base);
    const texts = r.entries.map((e) => e.content);
    expect(texts.indexOf('前置词内容')).toBeLessThan(texts.indexOf('全局提示词'));
    expect(texts.indexOf('全局提示词')).toBeLessThan(texts.indexOf('系统提示词'));
    expect(texts.indexOf('系统提示词')).toBeLessThan(texts.indexOf('角色简介'));
    expect(texts.indexOf('角色简介')).toBeLessThan(texts.indexOf('第一轮'));
    expect(texts.indexOf('第一轮')).toBeLessThan(texts.indexOf('全局后置词'));
    expect(texts.indexOf('全局后置词')).toBeLessThan(texts.indexOf('玩家输入'));
  });

  it('宏替换生效，未定义宏原样保留', () => {
    expect(applyMacros('{{char}} 看着 {{user}}，{{unknown}}', base.macros))
      .toBe('苏小染 看着 我，{{unknown}}');
  });

  it('预算不足时先裁最老的历史，不裁系统提示词', () => {
    const big = '字'.repeat(4000);
    const r = assemble({
      ...base,
      history: [
        { id: 'h1', role: 'assistant', content: '老' + big },
        { id: 'h2', role: 'user', content: '新' + big },
      ],
      limits: { contextLength: 3000, maxTokens: 100, reserve: 0, worldbookTokenBudget: 100000 },
    });
    const contents = r.entries.map((e) => e.content);
    expect(contents).toContain('系统提示词');
    expect(contents).toContain('玩家输入');
    expect(r.dropped.length).toBeGreaterThan(0);
    expect(contents.find((c) => c.startsWith('老'))).toBeUndefined();
  });

  it('世界书命中后被插入到历史之前', () => {
    const r = assemble({
      ...base,
      worldbook: [{
        id: 'w1', keys: ['第二轮'], secondaryKeys: [], content: '世界书内容', constant: false,
        selective: false, position: 'before-char', order: 1, depth: 4, recursive: false, enabled: true,
      }],
    });
    const texts = r.entries.map((e) => e.content);
    expect(texts.indexOf('世界书内容')).toBeGreaterThan(texts.indexOf('角色简介'));
    expect(texts.indexOf('世界书内容')).toBeLessThan(texts.indexOf('第一轮'));
  });
});

describe('token 估算', () => {
  it('汉字按 0.6 估算', () => {
    expect(estimateTokens('你好世界')).toBe(3);
  });
});
