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
  maxTokens: true, contextLength: 1000000, thinkingBudget: false, prefill: false, systemRole: false,
};
