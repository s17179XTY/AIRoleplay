import type { ModelCapability, ModelParams } from '../storage/types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  position?: 'pre' | 'system' | 'before-history' | 'history' | 'after-history' | 'post';
}
export interface ProviderConfig {
  id: string; baseUrl: string; apiKey: string; extraHeaders: Record<string, string>;
}
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  params: ModelParams;
  capabilities: ModelCapability;
  /** 使用者按「停止」時會被 abort：串流要立刻收手，而且**不能**把它當成錯誤回報 */
  signal?: AbortSignal;
}

/** 使用者主動停止（AbortController）與真正的連線失敗要分得開，否則「停止」會變成紅色錯誤訊息 */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}
export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; finishReason: string }
  | { type: 'error'; message: string; status?: number };
export interface ProviderAdapter {
  id: 'openai' | 'anthropic' | 'mock';
  listModels(cfg: ProviderConfig): Promise<string[]>;
  streamChat(cfg: ProviderConfig, req: ChatRequest): AsyncGenerator<StreamEvent>;
}
export const MOCK_CAPABILITY: ModelCapability = {
  temperature: true, topP: true, presencePenalty: true, frequencyPenalty: true,
  // 默认给一个真实模型量级的窗口（以前是 100 万，导致 HUD 的占用百分比永远是 0%）
  maxTokens: true, contextLength: 128000, thinkingBudget: false, prefill: false, systemRole: false,
};
