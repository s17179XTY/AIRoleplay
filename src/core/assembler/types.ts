export type EntryPosition = 'pre' | 'system' | 'before-history' | 'history' | 'after-history' | 'post';
export type EntrySource =
  | 'card-pre' | 'card-system' | 'card-post'
  | 'config-prompt' | 'config-pre' | 'config-post'
  | 'mod' | 'worldbook' | 'memory' | 'history' | 'user' | 'chat-setup';

export interface PromptEntry {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  position: EntryPosition;
  priority: number;
  tokens: number;
  source: EntrySource;
  mutable: boolean;
}

export interface MacroContext {
  user: string; char: string; persona: string; date: string; time: string; weekday: string;
}
export interface CardPromptParts {
  pre: string; prompt: string; post: string;
  description: string; persona: string; scenario: string;
}
export interface ConfigParts { prompt: string; prePrompt: string; postPrompt: string; }
export interface HistoryMessage { id: string; role: 'user' | 'assistant'; content: string; }
/** @deprecated 旧版「近期/永久记忆」条目；新版改用 SummaryItem */
export interface MemoryItem { id: string; tier: 'recent' | 'permanent'; text: string; dateLabel: string; }
/** 一条「掉出上下文窗口的交换」的压缩结果 */
export interface SummaryItem {
  id: string;
  /** 完整摘要（含 [用户] / [叙事] 分段） */
  text: string;
  userText?: string;
  assistantText?: string;
  dateLabel: string;
  /** 例如「第 3–8 条」 */
  rangeLabel?: string;
}
/** 一段可热插拔的提示词 */
export interface ModItem { id: string; name: string; content: string; order: number }
export interface WbEntryInput {
  id: string; keys: string[]; secondaryKeys: string[]; content: string; constant: boolean;
  selective: boolean; position: 'before-char' | 'after-char'; order: number; depth: number;
  recursive: boolean; enabled: boolean;
}
export interface Limits {
  contextLength: number; maxTokens: number; reserve: number; worldbookTokenBudget: number;
}
export interface AssembleInput {
  card: CardPromptParts;
  config: ConfigParts;
  worldbook: WbEntryInput[];
  /** 掉出窗口的历史压成的摘要，注入在历史之前 */
  summaries?: SummaryItem[];
  /** 热插拔提示词，接在卡片提示词之后（system 35） */
  mods?: ModItem[];
  history: HistoryMessage[];
  userInput: string;
  setup?: string;
  macros: MacroContext;
  limits: Limits;
  worldbookMatch?: { caseSensitive?: boolean; wholeWord?: boolean };
}
export interface AssembledRequest {
  entries: PromptEntry[];
  dropped: PromptEntry[];
  totalTokens: number;
  activatedWorldbook: string[];
}
