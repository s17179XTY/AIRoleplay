import { describe, it, expect } from 'vitest';
import { seedDemoCard } from './seed';
import { seedPackage } from './seedPackage';
import { assemble } from '../assembler/assemble';

describe('内置卡', () => {
  it('保留卡片自身的提示词与世界书，不再有静态的主公设/前情提要/开场白', () => {
    const c = seedDemoCard();
    expect(c.record.spec).toBe('dsh-card/1');
    expect(c.prompts.pre).toContain('医疗叙事研究协议');
    expect(c.prompts.prompt).toContain('回复正文约束');
    expect(c.prompts.prompt).toContain('XP书写指导');
    expect(c.memory.recentLimit).toBe(4);
    expect(c.worldbook.length).toBeGreaterThan(0);
    const pkg = seedPackage();
    expect(pkg.json.persona.intro).toBe('');
    expect(pkg.json.scenario).toBe('');
    expect(pkg.json.firstMessage).toBe('');
  });

  it('卡片包带原版互动页，且已剔除平台与作者内容', () => {
    const pkg = seedPackage();
    const ui = pkg.texts.find((t) => t.path === 'ui/index.html');
    expect(ui).toBeTruthy();
    expect(ui!.text).toContain('generated-content-preview');
    expect(ui!.text).toContain('id="copy-button"');
    expect(ui!.text).toContain('xp-search-input');
    expect(ui!.text).not.toContain('fonts.googleapis');
    expect(ui!.text).not.toContain('id="works-modal"');
    expect(ui!.text).not.toContain('推荐</button>');
    expect(ui!.text).not.toContain('t.me/');
    expect(ui!.text).not.toContain('author-reminder');
    expect(ui!.text).not.toContain('id="xp-detect-button"');
  });

  it('装配内核能吃掉卡片提示词，用户粘贴的初始化信息作为首条输入', () => {
    const c = seedDemoCard();
    const init = '【初始信息设定】\n\n【全局XP】\n用户选择的偏好：A12. 萝莉: ...\n';
    const r = assemble({
      card: {
        pre: c.prompts.pre, prompt: c.prompts.prompt, post: c.prompts.post,
        description: c.record.description, persona: '', scenario: '',
      },
      config: c.config,
      worldbook: c.worldbook,
      memories: [],
      history: [],
      userInput: init,
      macros: { user: '我', char: c.record.name, persona: '', date: '2026-10-13', time: '18:00', weekday: '周二' },
      limits: { contextLength: 1000000, maxTokens: 16000, reserve: 512, worldbookTokenBudget: 2000 },
    });
    expect(r.entries.length).toBeGreaterThan(3);
    expect(r.entries[r.entries.length - 1].content).toContain('【初始信息设定】');
    expect(r.entries[r.entries.length - 1].content).toContain('【全局XP】');
    expect(r.entries[r.entries.length - 1].role).toBe('user');
  });
});
