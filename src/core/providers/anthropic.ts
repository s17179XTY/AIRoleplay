import { parseSSE } from './sse';
import type { ChatRequest, ProviderAdapter, StreamEvent } from './types';
import type { ModelCapability } from '../storage/types';

export const ANTHROPIC_CAPABILITY: ModelCapability = {
  temperature: true, topP: true, presencePenalty: false, frequencyPenalty: false,
  maxTokens: true, contextLength: 200000, thinkingBudget: true, prefill: true, systemRole: true,
};

export interface AnthropicPayload {
  model: string;
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  max_tokens: number;
  stream: boolean;
  temperature?: number;
  top_p?: number;
  thinking?: { type: 'enabled'; budget_tokens: number };
}

const POSITION_RANK: Record<string, number> = {
  pre: 0, system: 1, 'before-history': 2, history: 3, 'after-history': 4, post: 5,
};

export function toAnthropicPayload(req: ChatRequest): AnthropicPayload {
  const { params, capabilities } = req;
  const sys: string[] = [];
  const tailInstructions: string[] = [];
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];

  const ordered = [...req.messages].sort(
    (a, b) => (POSITION_RANK[a.position ?? 'history'] ?? 3) - (POSITION_RANK[b.position ?? 'history'] ?? 3),
  );

  for (const m of ordered) {
    const pos = m.position ?? 'history';
    if (pos === 'history' && (m.role === 'user' || m.role === 'assistant')) {
      messages.push({ role: m.role, content: m.content });
    } else if (pos === 'post' && m.role === 'user') {
      messages.push({ role: 'user', content: m.content });
    } else if (pos === 'post') {
      tailInstructions.push(m.content);
    } else {
      sys.push(m.content);
    }
  }

  // 后置词紧贴生成位置：并入最后一条 user 消息之前
  if (tailInstructions.length > 0) {
    const block = tailInstructions.join('\n\n');
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') {
        lastUser = i;
        break;
      }
    }
    if (lastUser >= 0) {
      messages[lastUser] = { role: 'user', content: block + '\n\n' + messages[lastUser].content };
    } else {
      messages.push({ role: 'user', content: block });
    }
  }

  if (messages.length === 0) messages.push({ role: 'user', content: '（继续）' });

  const payload: AnthropicPayload = {
    model: req.model,
    system: sys.length > 0 ? sys.join('\n\n') : undefined,
    messages,
    max_tokens: capabilities.maxTokens ? params.maxTokens : 4096,
    stream: true,
  };
  if (capabilities.temperature) payload.temperature = params.temperature;
  if (capabilities.topP) payload.top_p = params.topP;
  if (capabilities.thinkingBudget && params.thinkingBudget > 0) {
    payload.thinking = { type: 'enabled', budget_tokens: params.thinkingBudget };
  }
  return payload;
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/v1') ? base + path : base + '/v1' + path;
}

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  async listModels(cfg) {
    const res = await fetch(joinUrl(cfg.baseUrl, '/models'), {
      headers: {
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        ...cfg.extraHeaders,
      },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = (await res.json()) as { data?: { id: string }[] };
    return (json.data ?? []).map((m) => m.id);
  },
  async *streamChat(cfg, req): AsyncGenerator<StreamEvent> {
    let res: Response;
    try {
      res = await fetch(joinUrl(cfg.baseUrl, '/messages'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          ...cfg.extraHeaders,
        },
        body: JSON.stringify(toAnthropicPayload(req)),
      });
    } catch (err) {
      yield { type: 'error', message: '请求失败：' + (err instanceof Error ? err.message : String(err)) };
      return;
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      yield { type: 'error', message: 'HTTP ' + res.status + ' ' + text.slice(0, 300), status: res.status };
      return;
    }
    for await (const ev of parseSSE(res.body)) {
      if (!ev.data) continue;
      try {
        const json = JSON.parse(ev.data) as {
          type?: string;
          delta?: { type?: string; text?: string; thinking?: string };
          usage?: { input_tokens?: number; output_tokens?: number };
          message?: { usage?: { input_tokens?: number; output_tokens?: number } };
        };
        if (json.type === 'content_block_delta' && json.delta) {
          if (json.delta.type === 'thinking_delta' && json.delta.thinking) {
            yield { type: 'reasoning', delta: json.delta.thinking };
          } else if (json.delta.text) {
            yield { type: 'text', delta: json.delta.text };
          }
        } else if (json.type === 'message_start' && json.message?.usage) {
          yield { type: 'usage', inputTokens: json.message.usage.input_tokens ?? 0, outputTokens: 0 };
        } else if (json.type === 'message_delta') {
          if (json.usage) {
            yield { type: 'usage', inputTokens: 0, outputTokens: json.usage.output_tokens ?? 0 };
          }
        } else if (json.type === 'message_stop') {
          yield { type: 'done', finishReason: 'stop' };
        }
      } catch {
        // 忽略无法解析的分片
      }
    }
  },
};
