import type { WbEntryInput } from './types';

export interface ScanOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  maxRecursionDepth?: number;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^$({})|[\]\\]/g, (m) => '\\' + m);
}

function hit(text: string, keys: string[], opts: ScanOptions): boolean {
  return keys.some((k) => {
    if (!k) return false;
    if (opts.wholeWord) {
      const pattern = '(^|[^\\p{L}\\p{N}])' + escapeRe(k) + '([^\\p{L}\\p{N}]|$)';
      return new RegExp(pattern, opts.caseSensitive ? 'u' : 'iu').test(text);
    }
    return opts.caseSensitive ? text.includes(k) : text.toLowerCase().includes(k.toLowerCase());
  });
}

export function scanWorldbook(
  entries: WbEntryInput[],
  messages: { role: string; content: string }[],
  opts: ScanOptions = {},
): WbEntryInput[] {
  const maxDepth = opts.maxRecursionDepth ?? 3;
  const active = new Set<string>();
  const result: WbEntryInput[] = [];

  const activate = (e: WbEntryInput) => {
    if (active.has(e.id)) return;
    active.add(e.id);
    result.push(e);
  };

  for (const e of entries) {
    if (e.enabled && e.constant) activate(e);
  }

  const textFor = (e: WbEntryInput) =>
    messages.slice(-Math.max(1, e.depth)).map((m) => m.content).join('\n');

  const firstLayer: WbEntryInput[] = [];
  for (const e of entries) {
    if (!e.enabled || e.constant) continue;
    const text = textFor(e);
    if (!text) continue;
    const direct = hit(text, e.keys, opts);
    const ok = e.selective
      ? direct && e.secondaryKeys.length > 0 && hit(text, e.secondaryKeys, opts)
      : direct;
    if (ok) firstLayer.push(e);
  }
  firstLayer.forEach(activate);

  let frontier = firstLayer.filter((e) => e.recursive);
  for (let layer = 2; layer <= maxDepth && frontier.length > 0; layer += 1) {
    const next: WbEntryInput[] = [];
    for (const src of frontier) {
      for (const e of entries) {
        if (!e.enabled || !e.recursive || active.has(e.id)) continue;
        if (hit(src.content, e.keys, opts)) next.push(e);
      }
    }
    next.forEach(activate);
    frontier = next;
  }

  return result.sort((a, b) => a.order - b.order);
}
