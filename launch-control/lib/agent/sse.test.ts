import { describe, expect, it } from 'vitest';
import { readSse } from './sse';

const streamOf = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      chunks.forEach((x) => c.enqueue(enc.encode(x)));
      c.close();
    },
  });

describe('readSse', () => {
  it('parses events split across chunks', async () => {
    const out = [];
    for await (const e of readSse(streamOf('event: tool\ndata: {"label":"a"}\n\nevent: te', 'xt\ndata: {"text":"hi"}\n\n')))
      out.push(e);
    expect(out).toEqual([
      { event: 'tool', data: { label: 'a' } },
      { event: 'text', data: { text: 'hi' } },
    ]);
  });
  it('skips malformed data', async () => {
    const out = [];
    for await (const e of readSse(streamOf('event: x\ndata: {nope\n\nevent: done\ndata: {"text":"t"}\n\n'))) out.push(e);
    expect(out).toEqual([{ event: 'done', data: { text: 't' } }]);
  });
});
