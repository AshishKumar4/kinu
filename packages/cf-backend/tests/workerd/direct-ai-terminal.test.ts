/**
 * The direct Workers AI lane ends a stream at `data: [DONE]` because the binding's producer may never close after
 * it. The binding hands back a native workerd body, and a native body answers a read still pending when it is
 * cancelled with a rejection ("Stream was cancelled."), where a spec stream in Bun resolves that read as done.
 */
import { describe, expect, it } from 'vitest';
import { createDirectWorkersAIFetch, type JsonObject } from '@kinu.run/core';

const encoder = new TextEncoder();

/** The binding's answer, as the platform hands it back: a native body the test writes into and never closes. */
function heldOpenBinding() {
  const pipe = new IdentityTransformStream();
  const writer = pipe.writable.getWriter();

  return {
    writer,
    run: (_model: string, _inputs: JsonObject, _options?: { signal?: AbortSignal; extraHeaders?: Record<string, string>; returnRawResponse?: boolean }) =>
      Promise.resolve(new Response(pipe.readable, { headers: { 'content-type': 'text/event-stream' } })),
  };
}

describe('direct Workers AI terminal on a native body', () => {
  it('a [DONE] that arrives while the answer is being read ends the stream cleanly, with every frame', async () => {
    const binding = heldOpenBinding();
    const text = binding.writer.write(encoder.encode(`data: ${JSON.stringify({ response: 'CHARLIE' })}\n\n`));

    const response = await createDirectWorkersAIFetch(binding)('https://fake.invalid/ai/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: '@cf/probe/model', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });

    await text;
    const reader = (response.body ?? new ReadableStream<Uint8Array>()).getReader();
    const decoder = new TextDecoder();
    let received = '';

    // Read as the SDK does, as frames arrive: the answer is on the wire before the producer sends its terminal.
    while (!received.includes('CHARLIE')) {
      const next = await reader.read();

      if (next.done) break;
      received += decoder.decode(next.value, { stream: true });
    }

    const terminal = binding.writer.write(encoder.encode(
      `data: ${JSON.stringify({ response: '', usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\ndata: [DONE]\n\n`,
    ));

    for (;;) {
      const next = await reader.read();

      if (next.done) break;
      received += decoder.decode(next.value, { stream: true });
    }

    await terminal;
    expect(received).toContain('"finish_reason":"stop"');
    expect(received.endsWith('data: [DONE]\n\n')).toBe(true);
  });
});
