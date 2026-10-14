import { describe, it, expect } from 'vitest';
import { renderTemplate, type TemplateContext } from './template';
import { buildSrcdoc, collectFields } from './sandbox';

const FIXTURE_UI = [
  '<h2>XP 偏好选择</h2>',
  '<label><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-value="A01" data-dsh-label="校园日常">校园日常</label>',
  '<label><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-value="B02" data-dsh-label="读心能力">读心能力</label>',
  '<label>姓名<input type="text" data-dsh-field="userName" data-dsh-type="text"></label>',
  '<label>性别<input type="text" data-dsh-field="gender" data-dsh-type="text" value="女"></label>',
  '<label>其他<textarea data-dsh-field="extra" data-dsh-type="textarea">特殊能力</textarea></label>',
].join('\n');

const FIXTURE_TEMPLATE = [
  '【初始信息设定】',
  '{{?xp}}用户选择的偏好：{{f:xp}}{{/xp}}',
  '{{?userName}}姓名：{{f:userName}}{{/userName}}',
  '{{?gender}}性别：{{f:gender}}{{/gender}}',
  '{{?extra}}其他：{{f:extra}}{{/extra}}',
].join('\n');
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
  it('收集勾选项与文本输入，并渲染进模板', () => {
    const doc = new DOMParser().parseFromString(FIXTURE_UI, 'text/html');
    (doc.querySelector('input[data-dsh-value=A01]') as HTMLInputElement).checked = true;
    (doc.querySelector('input[data-dsh-field=userName]') as HTMLInputElement).value = '阿离';
    const fields = collectFields(doc);
    expect(fields.xp.labels).toEqual(['校园日常']);
    expect(fields.xp.values).toEqual(['A01']);
    expect(fields.userName.values).toEqual(['阿离']);
    const out = renderTemplate(FIXTURE_TEMPLATE, { fields, scenario: '', persona: '', cardName: '卡', user: '我', date: '2026-10-13', time: '10:00' });
    expect(out).toContain('用户选择的偏好：校园日常');
    expect(out).toContain('姓名：阿离');
  });

  it('文本框的显示名就是用户输入的值，而不是外层 label 文案', () => {
    const doc = new DOMParser().parseFromString(FIXTURE_UI, 'text/html');
    const gender = doc.querySelector('input[data-dsh-field=gender]') as HTMLInputElement;
    const extra = doc.querySelector('textarea[data-dsh-field=extra]') as HTMLTextAreaElement;
    const fields = collectFields(doc);
    expect(fields.gender.labels).toEqual([gender.value]);
    expect(fields.extra.labels[0]).toBe(extra.value);
    const out = renderTemplate(FIXTURE_TEMPLATE, { fields, scenario: '', persona: '', cardName: '卡', user: '我', date: '2026-10-13', time: '10:00' });
    expect(out).toContain('性别：女');
    expect(out).not.toContain('性别：性别');
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