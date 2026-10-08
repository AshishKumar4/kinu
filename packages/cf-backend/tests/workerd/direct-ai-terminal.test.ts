/**
 * The Workers AI binding model ends a stream at `data: [DONE]` because the binding's producer may never close after
 * it. The binding hands back a native workerd body, and a native body answers a read still pending when it is
 * cancelled with a rejection ("Stream was cancelled."), where a spec stream in Bun resolves that read as done.
 */
import { describe, expect, it } from 'vitest';
import { streamText } from 'ai';
import { createWorkersAIProvider, type WorkersAIRunBinding } from '@kinu.run/core';

const encoder = new TextEncoder();

/** The binding's answer, as the platform hands it back: a native body the test writes into and never closes. */
function heldOpenBinding() {
  const pipe = new IdentityTransformStream();
  const writer = pipe.writable.getWriter();

  const fake: WorkersAIRunBinding = {
    run: () => Promise.resolve(new Response(pipe.readable, { headers: { 'content-type': 'text/event-stream' } })),
  };

  // `Ai` is the binding's whole surface; the provider calls `run` alone.
  const binding: Ai = Object.create(fake);

  return { writer, binding };
}

describe('Workers AI binding terminal on a native body', () => {
  it('a [DONE] that arrives while the answer is being read ends the stream cleanly, with every part', async () => {
    const { writer, binding } = heldOpenBinding();
    const text = writer.write(encoder.encode(`data: ${JSON.stringify({ response: 'CHARLIE' })}\n\n`));

    const model = createWorkersAIProvider(binding).createModel('@cf/probe/model', {
      env: {}, sessionAffinity: 'kinu-probe', workspaceAffinity: 'kinu-probe', getAuth: async () => null, hasCredential: async () => false,
    });

    const result = streamText({ model, prompt: 'hi', maxRetries: 0 });
    const reader = result.stream.getReader();
    let received = '';

    // Read as a turn does, as parts arrive: the answer is out before the producer sends its terminal.
    while (!received.includes('CHARLIE')) {
      const next = await reader.read();

      if (next.done) break;

      if (next.value.type === 'text-delta') received += next.value.text;
    }

    await text;

    const terminal = writer.write(encoder.encode(
      `data: ${JSON.stringify({ response: '', usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\ndata: [DONE]\n\n`,
    ));

    const rest: string[] = [];

    for (;;) {
      const next = await reader.read();

      if (next.done) break;
      rest.push(next.value.type);
    }

    await terminal;
    expect(received).toBe('CHARLIE');
    expect(rest).not.toContain('error');
    expect(rest.at(-1)).toBe('finish');
    expect(await result.finishReason).toBe('stop');
    expect(await result.usage).toMatchObject({ inputTokens: 5, outputTokens: 1 });
  });
});
