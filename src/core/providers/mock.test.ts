import { describe, it, expect } from 'vitest';
import { createMockAdapter } from './mock';
import { MOCK_CAPABILITY } from './types';

describe('mock 适配器', () => {
  it('把脚本按片流式吐出并给出 done', async () => {
    const adapter = createMockAdapter('你好世界', { chunkSize: 2, delayMs: 0 });
    const cfg = { id: 'm', baseUrl: '', apiKey: '', extraHeaders: {} };
    let text = '';
    let done = false;
    for await (const ev of adapter.streamChat(cfg, {
      model: 'mock',
      messages: [],
      params: {
        temperature: 1, topP: 1, presencePenalty: 0, frequencyPenalty: 0,
        maxTokens: 100, contextLength: 1000, thinkingBudget: 0,
      },
      capabilities: MOCK_CAPABILITY,
    })) {
      if (ev.type === 'text') text += ev.delta;
      if (ev.type === 'done') done = true;
    }
    expect(text).toBe('你好世界');
    expect(done).toBe(true);
  });
});
