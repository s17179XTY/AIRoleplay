import { describe, it, expect } from 'vitest';
import { parseSSE } from './sse';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
}

describe('SSE 解析', () => {
  it('跨分片拼接 data 行', async () => {
    const stream = streamOf(['data: {"a"', ':1}\n\n', 'data: [DONE]\n\n']);
    const out: string[] = [];
    for await (const ev of parseSSE(stream)) out.push(ev.data);
    expect(out).toEqual(['{"a":1}', '[DONE]']);
  });

  it('忽略注释行与空行', async () => {
    const stream = streamOf([': ping\n\n', 'data: x\n\n']);
    const out: string[] = [];
    for await (const ev of parseSSE(stream)) out.push(ev.data);
    expect(out).toEqual(['x']);
  });
});
