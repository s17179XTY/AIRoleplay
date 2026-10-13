import { describe, it, expect } from 'vitest';
import { extractAll, extractOptions, extractThink } from './extract';

const SAMPLE = [
  '<!-- 医疗研究-数据流 -->',
  '<!--<think>这里不该出现</think>-->',
  '<details><summary>📅状况</summary>🌍世界：现代都市<br>⏰时间：傍晚</details>',
  '<plot>她站在洗手台前，看着镜子里的自己。</plot>',
  '<details><summary>近期记忆</summary>',
  '当前记忆数目：1/4',
  '[1]（2026-10-13 午后）苏小染拆穿了偷窥者。',
  '</details>',
  '<hr class="separator">',
  '<p>👉选项：</p>',
  '<p>A. 继续调侃他</p>',
  '<p>B. 转身离开</p>',
  '<p>C. 威胁告诉校长</p>',
].join('\n');

describe('渲染内核 · 提取', () => {
  it('思维链与 HTML 注释被剥离', () => {
    const r = extractThink(SAMPLE);
    expect(r.think.join('')).toContain('这里不该出现');
    expect(r.body).not.toContain('think');
    expect(r.body).not.toContain('医疗研究-数据流');
  });

  it('提取 A–F 选项并保留正文', () => {
    const r = extractOptions(SAMPLE);
    expect(r.options.map((o) => o.key)).toEqual(['A', 'B', 'C']);
    expect(r.options[0].text).toBe('继续调侃他');
    expect(r.body).toContain('她站在洗手台前');
    expect(r.body).not.toContain('A. 继续调侃他');
  });

  it('extractAll 同时拿到记忆与选项', () => {
    const r = extractAll(SAMPLE);
    expect(r.memories).toHaveLength(1);
    expect(r.memories[0].tier).toBe('recent');
    expect(r.memories[0].dateLabel).toContain('2026-10-13');
    expect(r.memories[0].text).toContain('拆穿了偷窥者');
    expect(r.options).toHaveLength(3);
  });
});
