export interface SseEvent { event?: string; data: string; }

export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        const ev = parseLine(line);
        if (ev) yield ev;
        idx = buffer.indexOf('\n');
      }
    }
    const tail = parseLine(buffer.replace(/\r$/, ''));
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseLine(line: string): SseEvent | null {
  if (!line || line.startsWith(':')) return null;
  if (line.startsWith('data:')) return { data: line.slice(5).trimStart() };
  if (line.startsWith('event:')) return { event: line.slice(6).trim(), data: '' };
  return null;
}
