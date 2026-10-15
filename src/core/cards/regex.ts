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

/**
 * 只剥掉模型的思考噪音（`<!-- -->` 注释）。
 *
 * **不再剥「记忆」区块**：以前会把历史消息里的 `<details>近期记忆/永久记忆</details>` 整个删掉，
 * 一旦解析失败（模型格式写歪）那段摘要就再也不会进提示词 —— 信息凭空消失。
 * 新版窗口内的原文一律保留（记忆块本身就是上下文的一部分），窗口外的内容由摘要库接管。
 */
export function stripThink(raw: string): string {
  return raw.replace(/<!--([\s\S]*?)-->/g, '').trim();
}

/** @deprecated 旧名。只剥注释，不再剥记忆块；新代码请用 stripThink */
export function stripMemoryAndThink(raw: string): string {
  return stripThink(raw);
}

