import { describe, it, expect } from 'vitest';
import { buildSummaryPrompt, parseSummaryParts, skeletonSummary, summarizeBatch } from './summarize';
import type { ProviderAdapter, ProviderConfig, StreamEvent } from '../providers/types';

const cfg: ProviderConfig = { id: 'mock', baseUrl: '', apiKey: '', extraHeaders: {} };

function fakeAdapter(chunks: string[]): ProviderAdapter {
  return {
    id: 'mock',
    async listModels() {
      return [];
    },
    async *streamChat(): AsyncGenerator<StreamEvent> {
      for (const c of chunks) yield { type: 'text', delta: c };
      yield { type: 'done', finishReason: 'stop' };
    },
  };
}

describe('摘要压缩', () => {
  it('解析「用户：/叙事：」两段', () => {
    const raw = '用户：他选了 A\n叙事：走廊尽头的灯灭了。';
    expect(parseSummaryParts(raw)).toEqual({ userText: '他选了 A', assistantText: '走廊尽头的灯灭了。' });
  });

  it('容忍全角冒号与前后空白', () => {
    const raw = '  用户： 他选了 A \n\n 叙事 ： 灯灭了 ';
    const p = parseSummaryParts(raw);
    expect(p.userText).toBe('他选了 A');
    expect(p.assistantText).toBe('灯灭了');
  });

  it('拆不出标记时整段当叙事，userText 留空', () => {
    expect(parseSummaryParts('他们走进了房间。')).toEqual({ userText: '', assistantText: '他们走进了房间。' });
  });

  it('提示词带上一批消息、上一条摘要尾巴，并写死「文学描写但保留硬事实」', () => {
    const p = buildSummaryPrompt(
      [{ role: 'user', content: '我推开门' }, { role: 'assistant', content: '门后是一片黑' }],
      '上次他们还在楼下',
    );
    expect(p).toContain('我推开门');
    expect(p).toContain('门后是一片黑');
    expect(p).toContain('上次他们还在楼下');
    expect(p).toContain('用户：');
    expect(p).toContain('叙事：');
    expect(p).toContain('200 字');
    expect(p).toContain('文学');
    expect(p).toContain('人物');
    expect(p).toContain('关键事件');
  });

  it('骨架摘要包含条数范围与用户输入片段', () => {
    const p = skeletonSummary([{ role: 'user', content: '我推开门走进走廊' }], 3, 4);
    expect(p.assistantText).toContain('第 3–4 条');
    expect(p.assistantText).toContain('我推开门走进走廊');
    expect(p.userText).toBe('');
  });

  it('summarizeBatch 把 adapter 吐出的文本拼起来并解析', async () => {
    const adapter = fakeAdapter(['用户：选了 A', '\n叙事：灯灭了。']);
    const out = await summarizeBatch({
      adapter, cfg, model: 'm',
      batch: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }],
    });
    expect(out.userText).toBe('选了 A');
    expect(out.assistantText).toBe('灯灭了。');
  });

  it('每段超过 200 字会被截断', async () => {
    const long = '甲'.repeat(500);
    const out = await summarizeBatch({
      adapter: fakeAdapter([`用户：${long}\n叙事：${long}`]), cfg, model: 'm',
      batch: [{ role: 'user', content: 'x' }],
    });
    expect(out.userText.length).toBeLessThanOrEqual(201);
    expect(out.assistantText.length).toBeLessThanOrEqual(201);
  });

  it('adapter 报 error event 时抛错（交由上层重试）', async () => {
    const adapter: ProviderAdapter = {
      id: 'mock',
      async listModels() { return []; },
      async *streamChat(): AsyncGenerator<StreamEvent> {
        yield { type: 'error', message: '爆了' };
      },
    };
    await expect(summarizeBatch({ adapter, cfg, model: 'm', batch: [{ role: 'user', content: 'x' }] }))
      .rejects.toThrow('爆了');
  });
});
