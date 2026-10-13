import { describe, it, expect } from 'vitest';
import { sanitizeHtml } from './sanitize';

describe('渲染内核 · 清洗', () => {
  it('脚本与事件处理器被清除', () => {
    const out = sanitizeHtml('<p onclick="alert(1)">hi</p><script>alert(2)</script>');
    expect(out).not.toContain('script');
    expect(out).not.toContain('onclick');
    expect(out).toContain('hi');
  });

  it('iframe 与 javascript: 协议被清除', () => {
    const out = sanitizeHtml('<iframe src="https://evil.com"></iframe><a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain('iframe');
    expect(out).not.toContain('javascript:');
  });

  it('安全的行内样式保留，危险样式剔除', () => {
    const out = sanitizeHtml('<span style="color: #0072E3; font-weight: bold; position: fixed; z-index: 9999">蓝</span>');
    expect(out).toContain('color');
    expect(out).not.toContain('position');
    expect(out).not.toContain('9999');
  });

  it('details / summary / plot 等叙事标签保留', () => {
    const out = sanitizeHtml('<details><summary>状态</summary><plot>正文</plot></details>');
    expect(out).toContain('<details>');
    expect(out).toContain('<summary>');
    expect(out).toContain('<plot>');
  });
});
