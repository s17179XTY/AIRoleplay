export type CardSource = 'local' | 'imported-st' | 'imported-fy';
export type MessageStatus = 'complete' | 'streaming' | 'incomplete' | 'error';
/** 'summary' 是新的记忆库（摘要库）唯一会写入的层级；另两个只用于识别迁移前的旧数据 */
export type MemoryTier = 'summary' | 'recent' | 'permanent';
/** 这一条摘要怎么来的：模型压缩 / 老条目本地合并 / 连续失败后的本地骨架 */
/**
 * 'verbatim' = 压缩结果并不比原文短时的保底：直接保留原文（格式化成摘要条目）。
 * 绝不为了「压成一句」而把 1 个字膨胀成一整句话——那样反而更占上下文。
 */
export type MemoryOrigin = 'model' | 'merged' | 'local-skeleton' | 'verbatim';
export type ContextMode = 'recent' | 'all';
export type RegexScope = 'global' | 'chat';
export type RegexTarget = 'display' | 'prompt';
export type ConfigScope = 'global' | 'card' | 'chat';
export type WbPosition = 'before-char' | 'after-char';

export interface CardRecord {
  id: string; name: string; author: string; version: string; description: string;
  tags: string[]; coverAssetId?: string;
  /** 聊天时气泡左边显示的头像（非索引栏位） */
  avatarAssetId?: string;
  source: CardSource; spec: string;
  createdAt: number; updatedAt: number;
}
export type CardFileKind = 'json' | 'html' | 'css' | 'template' | 'worldbook' | 'regex' | 'asset';
export interface CardFileRecord { cardId: string; path: string; kind: CardFileKind; text?: string; assetId?: string; }
export interface AssetRecord { id: string; mime: string; size: number; bytes: ArrayBuffer; }
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
  // ↓ 摘要库新增，全部是非索引栏位（Dexie 不用升版）
  /** 「用户」那一部分的压缩结果 */
  userText?: string;
  /** 「叙事（AI）」那一部分的压缩结果 */
  assistantText?: string;
  fromMessageId?: string;
  toMessageId?: string;
  messageCount?: number;
  /** 显示用，例如「第 3–8 条」 */
  rangeLabel?: string;
  origin?: MemoryOrigin;
  tokenCount?: number;
  createdAt?: number;
}

export interface ModRecord {
  id: string; name: string; content: string; enabled: boolean; order: number;
  createdAt: number; updatedAt: number;
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

/** 未設定時的記憶保留條數（使用者明確要求預設 6 條） */
export const DEFAULT_MEMORY_LIMIT = 6;
export interface CardUiStateRecord { cardId: string; key: string; value: string; }
export interface SettingRecord { key: string; value: string; }

/* ------------------------------------------------------------------ *
 * 上下文窗口与摘要库的设置键与预设值（spec §1.1）
 * 全部存在 `settings` 表（字串值），会随账号同步。
 * ------------------------------------------------------------------ */

/** 'recent' = 只带最近 N 条消息；'all' = 全部带（靠上下文大小裁剪） */
export const SETTING_CONTEXT_MODE = 'contextMode';
/** 只在 'recent' 模式下生效；「条」= user 与 assistant 各算一条，且不含本轮输入 */
export const SETTING_CONTEXT_LIMIT = 'contextMessageLimit';
/** 「记忆托管」开关的新语义：要不要自动生成摘要 */
export const SETTING_SUMMARY_ENABLED = 'summaryEnabled';
/** 攒够几对掉出窗口才压缩（默认 1） */
export const SETTING_SUMMARY_BATCH = 'summaryBatchPairs';
/** 上下文占用达到这个百分比就主动压缩旧对话（默认 90，上限 92） */
export const SETTING_SUMMARY_TRIGGER = 'summaryTriggerPercent';
/** 迁移标记：旧记忆条目只清一次 */
export const SETTING_MEMORY_SCHEMA = 'memorySchema';

export const DEFAULT_CONTEXT_MODE: ContextMode = 'recent';
export const DEFAULT_CONTEXT_LIMIT = 6;
export const DEFAULT_SUMMARY_BATCH = 1;
/** 触发压缩的占用百分比：默认 90，可设 50–92（太贴近 100% 会来不及压） */
export const DEFAULT_SUMMARY_TRIGGER = 90;
export const SUMMARY_TRIGGER_MIN = 50;
export const SUMMARY_TRIGGER_MAX = 92;
/** 压到大约这个占用就停手（落在 70–80% 区间） */
export const SUMMARY_TARGET_PERCENT = 75;
/** 一次最多压几对：太多会让这一轮等很久，压不够下一轮继续 */
export const SUMMARY_MAX_PAIRS_PER_RUN = 6;
export const MEMORY_SCHEMA_VERSION = 'summary-v1';

/** 每段摘要的字数上限 */
export const SUMMARY_MAX_CHARS = 200;
/** 摘要库最多留几条（一对一项 → 上限要放宽，否则很快满库又不停合并） */
export const SUMMARY_KEEP = 100;
/** 超出上限时，把最老的几条本地拼接成一条 */
export const SUMMARY_MERGE_BATCH = 10;
/** 压缩连续失败几次后退化成本地骨架摘要（宁可粗糙也不能丢） */
export const SUMMARY_FAIL_LIMIT = 3;

export const DEFAULT_PARAMS: ModelParams = {
  temperature: 1, topP: 0.95, presencePenalty: 0, frequencyPenalty: 0,
  maxTokens: 16000, contextLength: 128000, thinkingBudget: 0,
};

export const DEFAULT_CAPABILITY: ModelCapability = {
  temperature: true, topP: true, presencePenalty: true, frequencyPenalty: true,
  maxTokens: true, contextLength: 128000, thinkingBudget: false, prefill: false, systemRole: false,
};
