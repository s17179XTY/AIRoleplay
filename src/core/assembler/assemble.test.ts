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
  setup: '初始设定',
  macros: { user: '我', char: '苏小染', persona: '设定', date: '2026-10-13', time: '14:00', weekday: '周二' },
  limits: { contextLength: 100000, maxTokens: 1000, reserve: 512, worldbookTokenBudget: 2000 },
};

describe('装配内核', () => {
  it('顺序：卡片提示词 → MOD → 卡片前缀词 → 全局前缀词 → 全局提示词 → 设定 → 历史 → 后置词 → 输入', () => {
    const r = assemble({ ...base, mods: [{ id: 'm1', name: 'a', content: 'MOD内容', order: 0 }] });
    const texts = r.entries.map((e) => e.content);
    expect(texts.indexOf('系统提示词')).toBeLessThan(texts.indexOf('MOD内容'));
    expect(texts.indexOf('MOD内容')).toBeLessThan(texts.indexOf('前置词内容'));
    expect(texts.indexOf('前置词内容')).toBeLessThan(texts.indexOf('全局前置词'));
    expect(texts.indexOf('全局前置词')).toBeLessThan(texts.indexOf('全局提示词'));
    expect(texts.indexOf('全局提示词')).toBeLessThan(texts.indexOf('初始设定'));
    expect(texts.indexOf('初始设定')).toBeLessThan(texts.indexOf('第一轮'));
    expect(texts.indexOf('第一轮')).toBeLessThan(texts.indexOf('全局后置词'));
    expect(texts.indexOf('全局后置词')).toBeLessThan(texts.indexOf('后置词内容'));
    expect(texts.indexOf('后置词内容')).toBeLessThan(texts.indexOf('玩家输入'));
  });

  it('简介 / 主人公设定 / 前情提要都不再注入提示词', () => {
    const r = assemble(base);
    const texts = r.entries.map((e) => e.content);
    expect(texts).not.toContain('角色简介');
    expect(texts).not.toContain('主人公设定');
    expect(texts).not.toContain('前情提要');
  });

  it('MOD 紧接卡片提示词（system 20）', () => {
    const r = assemble({ ...base, mods: [{ id: 'mod1', name: '破甲', content: 'MOD内容', order: 1 }] });
    const mod = r.entries.find((e) => e.source === 'mod');
    expect(mod).toBeTruthy();
    expect(mod?.content).toBe('MOD内容');
    expect(mod?.position).toBe('system');
    expect(mod?.priority).toBe(20);

    const texts = r.entries.map((e) => e.content);
    expect(texts.indexOf('系统提示词')).toBeLessThan(texts.indexOf('MOD内容'));
    expect(texts.indexOf('MOD内容')).toBeLessThan(texts.indexOf('前置词内容'));
  });

  it('MOD 支持宏，空内容不注入', () => {
    const r = assemble({
      ...base,
      mods: [
        { id: 'm1', name: 'a', content: '{{char}} 的模组', order: 0 },
        { id: 'm2', name: 'b', content: '   ', order: 1 },
      ],
    });
    const mods = r.entries.filter((e) => e.source === 'mod');
    expect(mods).toHaveLength(1);
    expect(mods[0].content).toBe('苏小染 的模组');
  });

  it('摘要注入在历史之前，且明确标注不是最新消息', () => {
    const r = assemble({
      ...base,
      summaries: [{ id: 's1', text: '[用户] 甲\n[叙事] 乙', dateLabel: '10-01 ~ 10-02', rangeLabel: '第 1–4 条' }],
    });
    const sum = r.entries.find((e) => e.source === 'memory');
    expect(sum).toBeTruthy();
    expect(sum?.position).toBe('before-history');
    expect(sum?.priority).toBeGreaterThanOrEqual(200);

    const texts = r.entries.map((e) => e.content);
    expect(texts.indexOf(sum!.content)).toBeLessThan(texts.indexOf('第一轮'));
    expect(sum!.content).toContain('不是最新消息');
    expect(sum!.content).toContain('以下是最近的原文对话');
    expect(sum!.content).toContain('10-01 ~ 10-02');
    expect(sum!.content).toContain('第 1–4 条');
  });

  it('没有摘要时不注入空的摘要条目', () => {
    expect(assemble(base).entries.some((e) => e.source === 'memory')).toBe(false);
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
