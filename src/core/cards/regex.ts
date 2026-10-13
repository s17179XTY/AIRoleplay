import type { RegexScriptRecord } from '../storage/types';
import type { RegexScriptJson } from './spec';

export interface RegexRule {
  pattern: string;
  flags: string;
  replacement: string;
  enabled: boolean;
  order: number;
  name: string;
  target: 'display' | 'prompt';
}

export function fromRecord(r: RegexScriptRecord): RegexRule {
  return { pattern: r.pattern, flags: r.flags, replacement: r.replacement, enabled: r.enabled, order: r.order, name: r.name, target: r.target };
}

export function fromCardJson(r: RegexScriptJson): RegexRule {
  return { pattern: r.pattern, flags: r.flags, replacement: r.replacement, enabled: r.enabled, order: r.order, name: r.name, target: r.target };
}

export function applyRegexRules(text: string, rules: RegexRule[]): string {
  const ordered = rules.filter((r) => r.enabled && r.pattern).sort((a, b) => a.order - b.order);
  let out = text;
  for (const rule of ordered) {
    try {
      const flags = rule.flags.replace(/[^gimsuy]/g, '') || 'g';
      const re = new RegExp(rule.pattern, flags.includes('g') ? flags : flags + 'g');
      out = out.replace(re, rule.replacement);
    } catch {
      // 非法正则：跳过这条规则，不影响其它规则
    }
  }
  return out;
}

export function stripMemoryAndThink(raw: string): string {
  let out = raw.replace(/<!--([\s\S]*?)-->/g, '');
  const doc = new DOMParser().parseFromString('<div id="root">' + out + '</div>', 'text/html');
  const root = doc.getElementById('root');
  if (root) {
    for (const details of Array.from(root.querySelectorAll('details'))) {
      const summary = details.querySelector('summary')?.textContent ?? '';
      if (summary.includes('记忆')) details.remove();
    }
    out = root.innerHTML;
  }
  return out.trim();
}
