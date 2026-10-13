import { extractAll, type ExtractedMemory } from './extract';
import { sanitizeHtml } from './sanitize';

export type RenderBlock =
  | { kind: 'collapse'; summary: string; html: string }
  | { kind: 'plot'; html: string }
  | { kind: 'options'; items: { key: string; text: string }[] }
  | { kind: 'html'; html: string };

export interface RenderResult {
  blocks: RenderBlock[];
  think: string;
  memories: ExtractedMemory[];
}

export function renderMessage(raw: string): RenderResult {
  const { think, body, memories, options } = extractAll(raw);
  const safe = sanitizeHtml(body);
  const doc = new DOMParser().parseFromString('<div id="root">' + safe + '</div>', 'text/html');
  const root = doc.getElementById('root');
  const blocks: RenderBlock[] = [];
  if (!root) return { blocks, think: think.join('\n'), memories };

  let buffer: string[] = [];
  const flush = () => {
    if (buffer.join('').trim()) blocks.push({ kind: 'html', html: buffer.join('') });
    buffer = [];
  };

  for (const child of Array.from(root.children)) {
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
