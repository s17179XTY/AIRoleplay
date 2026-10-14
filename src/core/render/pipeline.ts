import { extractAll, type ExtractedMemory } from './extract';
import { sanitizeHtml } from './sanitize';
import { applyRegexRules, type RegexRule } from '../cards/regex';

export type RenderBlock =
  | { kind: 'collapse'; summary: string; html: string }
  | { kind: 'plot'; html: string }
  | { kind: 'options'; items: { key: string; text: string }[] }
  | { kind: 'text'; text: string }
  | { kind: 'html'; html: string };

export interface RenderResult {
  blocks: RenderBlock[];
  think: string;
  memories: ExtractedMemory[];
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

export function renderMessage(raw: string, opts: { rules?: RegexRule[] } = {}): RenderResult {
  const { think, body, memories, options } = extractAll(raw);
  const ruled = opts.rules && opts.rules.length > 0 ? applyRegexRules(body, opts.rules) : body;
  const safe = sanitizeHtml(ruled);
  const doc = new DOMParser().parseFromString('<div id="root">' + safe + '</div>', 'text/html');
  const root = doc.getElementById('root');
  const blocks: RenderBlock[] = [];
  if (!root) return { blocks, think: think.join('\n'), memories };

  let buffer: string[] = [];
  const flush = () => {
    if (buffer.join('').trim()) blocks.push({ kind: 'html', html: buffer.join('') });
    buffer = [];
  };

  /*
   * 一定要走 childNodes 而不是 children。
   * 之前只走 children（元素），於是「整則回覆都是純文字、沒有任何標籤」時 blocks 是空的
   * ——氣泡只剩內距，看起來就是一個空框（AI 沒照格式輸出時最常見）。
   * 純文字走獨立的 text 區塊，交給 React 自己跳脫（不碰 innerHTML）；
   * 換行靠外層的 whitespace-pre-wrap 保留。
   */
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === TEXT_NODE) {
      const text = node.textContent ?? '';
      if (!text.trim()) continue; // 標籤之間的縮排與換行不算內容
      flush();                    // 先把前面累積的元素吐出去，順序才不會亂
      blocks.push({ kind: 'text', text: text.replace(/^\n+|\n+$/g, '') });
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE) continue;
    const child = node as Element;
    if (child.tagName === 'DETAILS') {
      flush();
      const summary = child.querySelector('summary')?.textContent?.trim() ?? '';
      const clone = child.cloneNode(true) as Element;
      clone.querySelector('summary')?.remove();
      blocks.push({ kind: 'collapse', summary, html: clone.innerHTML });
    } else if (child.tagName === 'PLOT') {
      flush();
      blocks.push({ kind: 'plot', html: child.innerHTML });
    } else {
      buffer.push(child.outerHTML);
    }
  }
  flush();

  if (options.length > 0) blocks.push({ kind: 'options', items: options });
  return { blocks, think: think.join('\n'), memories };
}
