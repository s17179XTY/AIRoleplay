export interface ExtractedMemory { tier: 'recent' | 'permanent'; text: string; dateLabel: string; }
export interface ExtractedOption { key: string; text: string; }
export interface ExtractResult {
  think: string[];
  body: string;
  memories: ExtractedMemory[];
  options: ExtractedOption[];
}

const OPTION_RE = /^\s*([A-F])\s*[.、．:：]\s*(.+)$/;
const MEMORY_ENTRY_RE = /\[(\d+)\]\s*[（(]?([^）)]*)[）)]?\s*([\s\S]*?)(?=\[\d+\]|$)/g;

export function extractThink(raw: string): { think: string[]; body: string } {
  const think: string[] = [];
  const body = raw.replace(/<!--([\s\S]*?)-->/g, (_matched, inner: string) => {
    const text = inner.replace(/<\/?think>/g, '').trim();
    if (text) think.push(text);
    return '';
  });
  return { think, body };
}

function parse(html: string): Document {
  return new DOMParser().parseFromString('<div id="root">' + html + '</div>', 'text/html');
}

export function extractOptions(html: string): { body: string; options: ExtractedOption[] } {
  const doc = parse(html);
  const root = doc.getElementById('root');
  if (!root) return { body: html, options: [] };
  const paragraphs = Array.from(root.querySelectorAll('p'));
  const matched: { el: Element; key: string; text: string }[] = [];
  for (const p of paragraphs) {
    const m = OPTION_RE.exec(p.textContent ?? '');
    if (m) matched.push({ el: p, key: m[1], text: m[2].trim() });
  }
  let options: ExtractedOption[] = [];
  if (matched.length >= 2 && matched[0].key === 'A') {
    const expected = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const consecutive: typeof matched = [];
    for (const item of matched) {
      if (item.key === expected[consecutive.length]) consecutive.push(item);
      else break;
    }
    options = consecutive.map((item) => ({ key: item.key, text: item.text }));
    const last = consecutive[consecutive.length - 1].el;
    let node: Element | null = consecutive[0].el;
    while (node) {
      const next: Element | null = node.nextElementSibling;
      const isLast = node === last;
      node.remove();
      if (isLast) break;
      node = next;
    }
    const hr = root.querySelector('hr.separator');
    if (hr) hr.remove();
    const intro = Array.from(root.querySelectorAll('p')).find((p) => (p.textContent ?? '').includes('选项'));
    if (intro) intro.remove();
  }
  return { body: root.innerHTML, options };
}

export function extractMemories(html: string): { body: string; memories: ExtractedMemory[] } {
  const doc = parse(html);
  const root = doc.getElementById('root');
  if (!root) return { body: html, memories: [] };
  const memories: ExtractedMemory[] = [];
  for (const details of Array.from(root.querySelectorAll('details'))) {
    const summary = details.querySelector('summary')?.textContent ?? '';
    const tier: ExtractedMemory['tier'] | null = summary.includes('永久记忆')
      ? 'permanent'
      : summary.includes('近期记忆')
        ? 'recent'
        : null;
    if (!tier) continue;
    const text = details.textContent ?? '';
    MEMORY_ENTRY_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let found = false;
    while ((m = MEMORY_ENTRY_RE.exec(text)) !== null) {
      const entryText = (m[3] ?? '').trim();
      if (!entryText) continue;
      found = true;
      memories.push({ tier, dateLabel: (m[2] ?? '').trim(), text: entryText });
    }
    if (found) details.remove();
  }
  return { body: root.innerHTML, memories };
}

export function extractAll(raw: string): ExtractResult {
  const t = extractThink(raw);
  const m = extractMemories(t.body);
  const o = extractOptions(m.body);
  return { think: t.think, body: o.body, memories: m.memories, options: o.options };
}
