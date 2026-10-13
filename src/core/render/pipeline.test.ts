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
});
