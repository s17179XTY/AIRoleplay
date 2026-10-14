import { describe, it, expect } from 'vitest';
import { renderMessage } from './pipeline';

const RAW = [
  '<details><summary>📅状况</summary>世界：现代都市</details>',
  '<plot>正文段落</plot>',
  '<p>A. 选项一</p>',
  '<p>B. 选项二</p>',
].join('\n');

describe('渲染内核 · 管线', () => {
  it('折叠块 / 正文块 / 选项块被分别识别', () => {
    const r = renderMessage(RAW);
    const kinds = r.blocks.map((b) => b.kind);
    expect(kinds).toContain('collapse');
    expect(kinds).toContain('plot');
    expect(kinds).toContain('options');
    const opts = r.blocks.find((b) => b.kind === 'options');
    expect(opts && opts.kind === 'options' ? opts.items.length : 0).toBe(2);
  });

  it('折叠块保留 summary 与内容', () => {
    const r = renderMessage(RAW);
    const collapse = r.blocks.find((b) => b.kind === 'collapse');
    expect(collapse && collapse.kind === 'collapse' ? collapse.summary : '').toContain('状况');
    expect(collapse && collapse.kind === 'collapse' ? collapse.html : '').toContain('现代都市');
  });

  /**
   * 回歸：以前只走 root.children（元素），純文字回覆沒有任何標籤時 blocks 是空的，
   * 氣泡只剩內距 → 看起來就是一個空框。
   */
  it('完全沒有任何標籤的純文字也要渲染出來（不能是空氣泡）', () => {
    const r = renderMessage('她抬起头看了你一眼。\n然后什么也没说。');
    expect(r.blocks).toHaveLength(1);
    const block = r.blocks[0];
    expect(block.kind).toBe('text');
    expect(block.kind === 'text' ? block.text : '').toContain('她抬起头看了你一眼');
    expect(block.kind === 'text' ? block.text : '').toContain('\n'); // 換行靠 whitespace-pre-wrap 保留
  });

  it('純文字裡的 HTML 特殊字元走 text 区块，不会被当成标签', () => {
    const r = renderMessage('<script>alert(1)</script> 之后的正文');
    const text = r.blocks
      .map((b) => (b.kind === 'text' ? b.text : b.kind === 'html' ? b.html : ''))
      .join('');
    expect(text).not.toContain('<script');
    expect(text).toContain('之后的正文');
  });

  it('文字与标签混排时不会丢字，而且顺序不乱', () => {
    const r = renderMessage('开场白在这里\n<plot>正文</plot>\n结尾一句话');
    expect(r.blocks.map((b) => b.kind)).toEqual(['text', 'plot', 'text']);
    const first = r.blocks[0];
    const last = r.blocks[2];
    expect(first.kind === 'text' ? first.text : '').toContain('开场白在这里');
    expect(last.kind === 'text' ? last.text : '').toContain('结尾一句话');
  });

  it('标籤之间的空白文字节点不会变成多余的区块', () => {
    const r = renderMessage('<p>甲</p>\n\n<p>乙</p>');
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].kind).toBe('html');
  });
});
