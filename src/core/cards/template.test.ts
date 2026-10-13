import { describe, it, expect } from 'vitest';
import { renderTemplate, type TemplateContext } from './template';
import { buildSrcdoc, collectFields } from './sandbox';
import { seedPackage } from '../storage/seedPackage';

const ctx: TemplateContext = {
  fields: {
    xp: { values: ['A01', 'B02'], labels: ['校园日常', '读心能力'] },
    userName: { values: ['小明'], labels: ['小明'] },
    empty: { values: [], labels: [] },
  },
  scenario: '雨夜便利店',
  persona: '主人公设定文本',
  cardName: '测试卡',
  user: '我',
  date: '2026-10-13',
  time: '20:00',
};

describe('提示词模板引擎', () => {
  it('字段取显示名并以顿号连接', () => {
    expect(renderTemplate('偏好：{{f:xp}}', ctx)).toBe('偏好：校园日常、读心能力');
  });

  it('支持自定义分隔符与 raw 取值', () => {
    expect(renderTemplate('{{f:xp|sep=,}}', ctx)).toBe('校园日常,读心能力');
    expect(renderTemplate('{{f:xp|raw}}', ctx)).toBe('A01、B02');
  });

  it('条件段在字段为空时整体消失', () => {
    expect(renderTemplate('{{?userName}}姓名：{{f:userName}}{{/userName}}', ctx)).toBe('姓名：小明');
    expect(renderTemplate('{{?empty}}不该出现{{/empty}}', ctx)).toBe('');
  });

  it('卡片宏被替换', () => {
    expect(renderTemplate('{{char}} 在 {{scenario}}', ctx)).toBe('测试卡 在 雨夜便利店');
  });

  it('未知字段渲染为空而不是留下花括号', () => {
    expect(renderTemplate('A{{f:none}}B', ctx)).toBe('AB');
  });
});

describe('沙箱与字段收集', () => {
  it('从演示卡界面里收集勾选项与文本输入', () => {
    const pkg = seedPackage();
    const html = pkg.texts.find((t) => t.path === 'ui/index.html')!.text;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const checks = doc.querySelectorAll('input[type=checkbox]');
    (checks[0] as HTMLInputElement).checked = true;
    const text = doc.querySelector('input[data-dsh-field=userName]') as HTMLInputElement;
    text.value = '阿离';
    const fields = collectFields(doc);
    expect(fields.xp.labels).toEqual(['校园日常']);
    expect(fields.xp.values).toEqual(['A01']);
    expect(fields.userName.values).toEqual(['阿离']);
  });

  it('srcdoc 注入 CSP 与桥脚本', () => {
    const out = buildSrcdoc('<html><head></head><body><input data-dsh-field="a"></body></html>', 'BRIDGE');
    expect(out).toContain('Content-Security-Policy');
    expect(out).toContain("connect-src 'none'");
    expect(out).toContain('BRIDGE');
  });

  it('没有 head 的片段也能注入', () => {
    const out = buildSrcdoc('<div>hi</div>', 'BRIDGE');
    expect(out).toContain('Content-Security-Policy');
    expect(out).toContain('<div>hi</div>');
  });
});
