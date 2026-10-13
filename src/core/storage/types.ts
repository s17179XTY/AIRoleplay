export type CardSource = 'local' | 'imported-st' | 'imported-fy';
export type MessageStatus = 'complete' | 'streaming' | 'incomplete' | 'error';
export type MemoryTier = 'recent' | 'permanent';
export type RegexScope = 'global' | 'chat';
export type RegexTarget = 'display' | 'prompt';
export type ConfigScope = 'global' | 'card' | 'chat';
export type WbPosition = 'before-char' | 'after-char';

export interface CardRecord {
  id: string; name: string; author: string; version: string; description: string;
  tags: string[]; coverAssetId?: string; source: CardSource; spec: string;
  createdAt: number; updatedAt: number;
}
export type CardFileKind = 'json' | 'html' | 'css' | 'template' | 'worldbook' | 'regex' | 'asset';
export interface CardFileRecord { cardId: string; path: string; kind: CardFileKind; text?: string; assetId?: string; }
export interface AssetRecord { id: string; mime: string; size: number; blob: Blob; }
export interface ChatRecord {
  id: string; cardId: string; title: string; vars: Record<string, string>;
  promptSnapshot: string; providerId: string | null; modelPresetId: string | null;
  currentLeafId: string | null; createdAt: number; updatedAt: number; archived: 0 | 1;
}
export interface MessageRecord {
  id: string; chatId: string; parentId: string | null; role: 'user' | 'assistant';
  raw: string; status: MessageStatus; tokensIn: number; tokensOut: number;
  model: string; createdAt: number;
}
export interface MemoryRecord {
  id: string; chatId: string; tier: MemoryTier; text: string; dateLabel: string;
  sourceMessageId: string | null; archivedAt: number | null; order: number;
}
export interface WorldbookRecord { id: string; name: string; description: string; }
export interface WorldbookEntryRecord {
  id: string; worldbookId: string; keys: string[]; secondaryKeys: string[]; content: string;
  constant: boolean; selective: boolean; position: WbPosition; order: number; depth: number;
  recursive: boolean; enabled: boolean;
}
export interface RegexScriptRecord {
  id: string; scope: RegexScope; chatId: string | null; name: string; pattern: string;
  flags: string; replacement: string; enabled: boolean; order: number; target: RegexTarget;
}
export interface ProviderRecord {
  id: string; label: string; protocol: 'openai' | 'anthropic'; baseUrl: string;
  apiKey: string; extraHeaders: Record<string, string>; createdAt: number;
}
export interface ModelCapability {
  temperature: boolean; topP: boolean; presencePenalty: boolean; frequencyPenalty: boolean;
  maxTokens: boolean; contextLength: number; thinkingBudget: boolean; prefill: boolean; systemRole: boolean;
}
export interface ModelParams {
  temperature: number; topP: number; presencePenalty: number; frequencyPenalty: number;
  maxTokens: number; contextLength: number; thinkingBudget: number;
}
export interface ModelPresetRecord {
  id: string; providerId: string; model: string; params: ModelParams; capabilities: ModelCapability;
}
export interface ConfigRecord {
  id: string; scope: ConfigScope; refId: string | null; memoryLimit: number;
  prePrompt: string; postPrompt: string; prompt: string;
}
export interface CardUiStateRecord { cardId: string; key: string; value: string; }
export interface SettingRecord { key: string; value: string; }

export const DEFAULT_PARAMS: ModelParams = {
  temperature: 1, topP: 0.95, presencePenalty: 0, frequencyPenalty: 0,
  maxTokens: 16000, contextLength: 1000000, thinkingBudget: 0,
};

export const DEFAULT_CAPABILITY: ModelCapability = {
  temperature: true, topP: true, presencePenalty: true, frequencyPenalty: true,
  maxTokens: true, contextLength: 1000000, thinkingBudget: false, prefill: false, systemRole: false,
};
