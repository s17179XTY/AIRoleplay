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

  /**
   * 回歸：記憶區塊曾被 `details.remove()` 從正文移除，於是串流途中（條目還沒寫完、
   * 湊不出 `[1]…`）看得見，生成結束後反而消失——使用者看到的就是
   * 「近期記憶出現後又消失，生成完就沒了」。記憶必須留在 AI 訊息裡顯示。
   */
  it('记忆区块不会被从正文里移除（解析出来的同时仍然看得见）', () => {
    const withoutMemories = extractAll(SAMPLE.replace(/<details><summary>近期记忆[\s\S]*?<\/details>/, ''));
    const withMemories = extractAll(SAMPLE);
    expect(withoutMemories.memories).toHaveLength(0);
    expect(withMemories.memories).toHaveLength(1);
    // 有解析到记忆时，正文里那段还是要在
    expect(withMemories.body).toContain('近期记忆');
    expect(withMemories.body).toContain('拆穿了偷窥者');
  });

  it('永久记忆也一样留在正文里', () => {
    const raw = [
      '<plot>正文</plot>',
      '<details><summary>永久记忆</summary>🌟永久记忆<br>[1]（2026-10-01）很久以前发生的事。</details>',
    ].join('\n');
    const r = extractAll(raw);
    expect(r.memories[0].tier).toBe('permanent');
    expect(r.body).toContain('永久记忆');
    expect(r.body).toContain('很久以前发生的事');
  });

  it('摘要里没有「记忆」二字的 details 不会被当成记忆条目', () => {
    const r = extractAll('<details><summary>📅状况</summary>[1]（2026-10-13）这不是记忆。</details>');
    expect(r.memories).toHaveLength(0);
  });
});
