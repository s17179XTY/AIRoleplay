import { describe, it, expect } from 'vitest';
import { seedDemoCard } from './seed';
import { assemble } from '../assembler/assemble';

describe('演示卡', () => {
  it('包含多层提示词与记忆规则', () => {
    const c = seedDemoCard();
    expect(c.record.spec).toBe('dsh-card/1');
    expect(c.prompts.pre.length).toBeGreaterThan(0);
    expect(c.prompts.prompt).toContain('回复正文约束');
    expect(c.memory.recentLimit).toBe(4);
    expect(c.worldbook.length).toBeGreaterThan(0);
  });

  it('能被装配内核吃下并产出系统提示词', () => {
    const c = seedDemoCard();
    const r = assemble({
      card: {
        pre: c.prompts.pre, prompt: c.prompts.prompt, post: c.prompts.post,
        description: c.record.description, persona: c.persona, scenario: c.scenario,
      },
      config: c.config,
      worldbook: c.worldbook,
      memories: [],
      history: [],
      userInput: '开始',
      macros: { user: '我', char: c.record.name, persona: c.persona, date: '2026-10-13', time: '18:00', weekday: '周二' },
      limits: { contextLength: 1000000, maxTokens: 16000, reserve: 512, worldbookTokenBudget: 2000 },
    });
    expect(r.entries.length).toBeGreaterThan(3);
    expect(r.entries[r.entries.length - 1].content).toBe('开始');
    expect(r.activatedWorldbook).toContain('wb-school');
  });
});
