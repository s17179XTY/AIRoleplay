import { describe, it, expect } from 'vitest';
import { applyRegexRules, stripMemoryAndThink } from './regex';

describe('正则规则', () => {
  it('按 order 依次替换并支持分组', () => {
    const out = applyRegexRules('你好【世界】', [
      { pattern: '【(.+?)】', flags: 'g', replacement: '<b>$1</b>', enabled: true, order: 1, name: 'a', target: 'display' },
      { pattern: '你好', flags: 'g', replacement: '嗨', enabled: true, order: 0, name: 'b', target: 'display' },
    ]);
    expect(out).toBe('嗨<b>世界</b>');
  });

  it('非法正则被跳过而不抛错', () => {
    const out = applyRegexRules('abc', [
      { pattern: '(', flags: 'g', replacement: 'x', enabled: true, order: 0, name: 'bad', target: 'display' },
      { pattern: 'b', flags: 'g', replacement: 'B', enabled: true, order: 1, name: 'ok', target: 'display' },
    ]);
    expect(out).toBe('aBc');
  });

  it('禁用规则不生效', () => {
    expect(applyRegexRules('abc', [{ pattern: 'a', flags: 'g', replacement: 'X', enabled: false, order: 0, name: 'x', target: 'display' }])).toBe('abc');
  });

  it('剥离思维链与记忆区块', () => {
    const raw = '<!--<think>内部</think>--><plot>正文</plot><details><summary>近期记忆</summary>[1]（今）内容</details>';
    const out = stripMemoryAndThink(raw);
    expect(out).not.toContain('内部');
    expect(out).not.toContain('近期记忆');
    expect(out).toContain('正文');
  });
});
