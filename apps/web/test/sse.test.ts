import { describe, expect, it } from 'vitest';
import { readSse } from '../src/api/sse.js';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('SSE reader', () => {
  it('parses multiple events split across chunks', async () => {
    const stream = streamOf(
      'data: {"type":"assistant.delta","sessionId":"s","at":"t","text":"he',
      'llo"}\n\ndata: {"type":"session.done","sessionId":"s","at":"t"}\n\n',
    );

    const events = [];
    for await (const event of readSse(stream)) events.push(event);
    expect(events.map((event) => event.type)).toEqual(['assistant.delta', 'session.done']);
  });

  it('ignores non-data lines', async () => {
    const events = [];
    for await (const event of readSse(streamOf(': keepalive\n\ndata: {"type":"session.done","sessionId":"s","at":"t"}\n\n'))) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
  });
});
