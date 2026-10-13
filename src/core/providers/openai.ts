import { parseSSE } from './sse';
import type { ChatRequest, ProviderAdapter, ProviderConfig, StreamEvent } from './types';

export function buildOpenAIBody(cfg: ProviderConfig, req: ChatRequest): Record<string, unknown> {
  void cfg;
  const { params, capabilities } = req;
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: true,
  };
  if (capabilities.temperature) body.temperature = params.temperature;
  if (capabilities.topP) body.top_p = params.topP;
  if (capabilities.presencePenalty) body.presence_penalty = params.presencePenalty;
  if (capabilities.frequencyPenalty) body.frequency_penalty = params.frequencyPenalty;
  if (capabilities.maxTokens) body.max_tokens = params.maxTokens;
  if (capabilities.thinkingBudget && params.thinkingBudget > 0) {
    body.thinking = { type: 'enabled', budget_tokens: params.thinkingBudget };
  }
  return body;
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/v1') ? base + path : base + '/v1' + path;
}

export function describeFetchError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return [
    '请求失败：' + raw,
    '常见原因：1) 该服务商不允许浏览器直连（CORS）；2) 网络或代理不通；3) Base URL 写错。',
    '可在设置页点「测试连接」进一步确认。',
  ].join('\n');
}

export const openAIAdapter: ProviderAdapter = {
  id: 'openai',
  async listModels(cfg) {
    const res = await fetch(joinUrl(cfg.baseUrl, '/models'), {
      headers: {
        ...(cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {}),
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
      res = await fetch(joinUrl(cfg.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {}),
          ...cfg.extraHeaders,
        },
        body: JSON.stringify(buildOpenAIBody(cfg, req)),
      });
    } catch (err) {
      yield { type: 'error', message: describeFetchError(err) };
      return;
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      yield { type: 'error', message: 'HTTP ' + res.status + ' ' + text.slice(0, 300), status: res.status };
      return;
    }
    for await (const ev of parseSSE(res.body)) {
      if (ev.data === '[DONE]') break;
      if (!ev.data) continue;
      try {
        const json = JSON.parse(ev.data) as {
          choices?: { delta?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const delta = json.choices?.[0]?.delta;
        if (delta?.reasoning_content) yield { type: 'reasoning', delta: delta.reasoning_content };
        if (delta?.content) yield { type: 'text', delta: delta.content };
        if (json.usage) {
          yield {
            type: 'usage',
            inputTokens: json.usage.prompt_tokens ?? 0,
            outputTokens: json.usage.completion_tokens ?? 0,
          };
        }
        const finish = json.choices?.[0]?.finish_reason;
        if (finish) yield { type: 'done', finishReason: finish };
      } catch {
        // 忽略无法解析的分片
      }
    }
  },
};
