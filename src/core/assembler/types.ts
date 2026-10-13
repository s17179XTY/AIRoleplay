export type EntryPosition = 'pre' | 'system' | 'before-history' | 'history' | 'after-history' | 'post';
export type EntrySource =
  | 'card-pre' | 'card-system' | 'card-post'
  | 'config-prompt' | 'config-pre' | 'config-post'
  | 'worldbook' | 'memory' | 'history' | 'user';

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
export interface MemoryItem { id: string; tier: 'recent' | 'permanent'; text: string; dateLabel: string; }
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
  memories: MemoryItem[];
  history: HistoryMessage[];
  userInput: string;
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
