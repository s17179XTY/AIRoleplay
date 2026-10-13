import { describe, it, expect } from 'vitest';
import { buildOpenAIBody, describeFetchError } from './openai';

const cfg = { id: 'p', baseUrl: 'https://api.example.com', apiKey: 'sk-x', extraHeaders: {} };
const base = {
  model: 'deepseek-chat',
  messages: [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'hi' },
  ],
  params: {
    temperature: 0.8, topP: 0.9, presencePenalty: 0.1, frequencyPenalty: 0.2,
    maxTokens: 2048, contextLength: 64000, thinkingBudget: 0,
  },
};

describe('OpenAI 兼容适配器', () => {
  it('能力全开时发送全部参数', () => {
    const body = buildOpenAIBody(cfg, {
      ...base,
      capabilities: {
        temperature: true, topP: true, presencePenalty: true, frequencyPenalty: true,
        maxTokens: true, contextLength: 64000, thinkingBudget: false, prefill: false, systemRole: false,
      },
    });
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.8);
    expect(body.max_tokens).toBe(2048);
    expect(body.presence_penalty).toBe(0.1);
  });

  it('模型不支持某参数时不发送该字段', () => {
    const body = buildOpenAIBody(cfg, {
      ...base,
      capabilities: {
        temperature: true, topP: false, presencePenalty: false, frequencyPenalty: false,
        maxTokens: false, contextLength: 64000, thinkingBudget: false, prefill: false, systemRole: false,
      },
    });
    expect(body.temperature).toBe(0.8);
    expect('top_p' in body).toBe(false);
    expect('max_tokens' in body).toBe(false);
    expect('presence_penalty' in body).toBe(false);
  });

  it('请求失败时给出 CORS 三因提示', () => {
    const msg = describeFetchError(new TypeError('Failed to fetch'));
    expect(msg).toContain('CORS');
    expect(msg).toContain('Failed to fetch');
  });
});
