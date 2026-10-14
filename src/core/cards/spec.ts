import type { ModelParams } from '../storage/types';
import type { WbEntryInput } from '../assembler/types';

export const CARD_SPEC = 'dsh-card/1';
export const CARD_VERSION_MARKER = 'dsh-card/1';

export interface MemoryRule {
  parser: 'details-v1' | 'none';
  recentLimit: number;
  stripFromHistory: boolean;
  archive: 'concat';
  inject: 'after-history';
}

export interface RegexScriptJson {
  id: string;
  name: string;
  pattern: string;
  flags: string;
  replacement: string;
  enabled: boolean;
  order: number;
  target: 'display' | 'prompt';
}

export interface DshCardJson {
  spec: string;
  id: string;
  name: string;
  author: string;
  version: string;
  description: string;
  tags: string[];
  cover?: string;
  prompts: { pre: string; prompt: string; post: string };
  persona: { name: string; gender: string; intro: string };
  scenario: string;
  firstMessage: string;
  mesExample: string;
  ui?: { entry: string; autoOpen: boolean };
  promptTemplate?: string;
  worldbook?: string;
  regex?: string;
  memory: MemoryRule;
  defaults?: { providerId?: string | null; model?: string | null; params?: Partial<ModelParams> };
}

export const DEFAULT_MEMORY: MemoryRule = {
  parser: 'details-v1',
  recentLimit: 6,
  stripFromHistory: true,
  archive: 'concat',
  inject: 'after-history',
};

export function emptyCardJson(name: string): DshCardJson {
  return {
    spec: CARD_SPEC,
    id: '',
    name,
    author: '',
    version: '1.0.0',
    description: '',
    tags: [],
    prompts: { pre: '', prompt: '', post: '' },
    persona: { name: '{{user}}', gender: '', intro: '' },
    scenario: '',
    firstMessage: '',
    mesExample: '',
    memory: { ...DEFAULT_MEMORY },
  };
}

export function parseCardJson(text: string): DshCardJson {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('card.json 不是合法 JSON');
  }
  if (!raw || typeof raw !== 'object') throw new Error('card.json 内容为空');
  const obj = raw as Partial<DshCardJson>;
  if (!obj.spec) throw new Error('card.json 缺少 spec 字段');
  if (obj.spec !== CARD_SPEC) throw new Error('不支持的卡片版本：' + String(obj.spec) + '（本应用支持 ' + CARD_SPEC + '）');
  const base = emptyCardJson(obj.name ?? '未命名卡片');
  return {
    ...base,
    ...obj,
    tags: Array.isArray(obj.tags) ? obj.tags : [],
    prompts: { ...base.prompts, ...(obj.prompts ?? {}) },
    persona: { ...base.persona, ...(obj.persona ?? {}) },
    memory: { ...DEFAULT_MEMORY, ...(obj.memory ?? {}) },
  };
}

export function serializeCardJson(json: DshCardJson): string {
  return JSON.stringify({ ...json, spec: CARD_SPEC }, null, 2) + '\n';
}

export interface WorldbookFile { version: 1; entries: WbEntryInput[]; }
export interface RegexFile { version: 1; scripts: RegexScriptJson[]; }

export function parseWorldbookFile(text: string): WbEntryInput[] {
  const raw = JSON.parse(text) as Partial<WorldbookFile>;
  if (!raw || !Array.isArray(raw.entries)) throw new Error('worldbook.json 缺少 entries');
  return raw.entries.map((e, i) => ({
    id: e.id ?? 'wb-' + i,
    keys: Array.isArray(e.keys) ? e.keys : [],
    secondaryKeys: Array.isArray(e.secondaryKeys) ? e.secondaryKeys : [],
    content: e.content ?? '',
    constant: Boolean(e.constant),
    selective: Boolean(e.selective),
    position: e.position === 'after-char' ? 'after-char' : 'before-char',
    order: typeof e.order === 'number' ? e.order : i,
    depth: typeof e.depth === 'number' ? e.depth : 4,
    recursive: Boolean(e.recursive),
    enabled: e.enabled === undefined ? true : Boolean(e.enabled),
  }));
}

export function parseRegexFile(text: string): RegexScriptJson[] {
  const raw = JSON.parse(text) as Partial<RegexFile>;
  if (!raw || !Array.isArray(raw.scripts)) throw new Error('regex.json 缺少 scripts');
  return raw.scripts.map((s, i) => ({
    id: s.id ?? 'rx-' + i,
    name: s.name ?? '规则 ' + (i + 1),
    pattern: s.pattern ?? '',
    flags: s.flags ?? 'g',
    replacement: s.replacement ?? '',
    enabled: s.enabled === undefined ? true : Boolean(s.enabled),
    order: typeof s.order === 'number' ? s.order : i,
    target: s.target === 'prompt' ? 'prompt' : 'display',
  }));
}
