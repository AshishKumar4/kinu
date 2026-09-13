/**
 * Terminal lifecycle on the direct Workers AI path: when the translated
 * stream carries `data: [DONE]`, the adapter cancels the upstream binding
 * reader instead of waiting for the producer to close — the same rule as
 * the compat path's terminal watcher, pinned here for this transport.
 *
 * Each case drives `createDirectWorkersAIFetch` with a stub binding whose
 * body the test owns: a producer that stays open behind [DONE] must still
 * end the translated stream with the upstream cancel called, and a
 * rejecting cancel must reach the consumer with the lock released either
 * way (a second reader on the upstream acquires cleanly).
 */
import { describe, test, expect } from 'bun:test';
import { createDirectWorkersAIFetch } from '../src/providers/direct-workers-ai-fetch';
import type { JsonObject } from '@kinu.run/core';

interface RunOptions {
  signal?: AbortSignal;
  extraHeaders?: Record<string, string>;
  returnRawResponse?: boolean;
}

type BindingAnswer = Response | ReadableStream<Uint8Array> | JsonObject;

const encoder = new TextEncoder();

function nativeFrame(response: string): string {
  return `data: ${JSON.stringify({ response })}\n\n`;
}

const DONE = 'data: [DONE]\n\n';

/** A binding body the test owns: scripted frames, then whatever lifecycle
 *  the case leaves it in, with cancel calls counted. Shaped exactly like the
 *  sibling stream test's stub so the single `as Ai` below resolves the same
 *  way: the adapter under test calls no other member of the binding. */
function scriptedBinding(frames: string[], hangOpen: boolean, onCancel?: () => Promise<void> | void) {
  const cancels: string[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancels.push('cancelled');

      if (onCancel !== undefined) return onCancel();
    },
  });

  const ai = {
    run(_model: string, _inputs: JsonObject, _options?: RunOptions): Promise<BindingAnswer> {
      for (const frame of frames) controller?.enqueue(encoder.encode(frame));

      if (!hangOpen) controller?.close();

      return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
    },
  };

  return { ai, stream, cancels };
}

function turnBody(): string {
  return JSON.stringify({
    model: '@cf/probe/model',
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';

  for (;;) {
    const next = await reader.read();

    if (next.done) break;

    text += decoder.decode(next.value, { stream: true });
  }

  text += decoder.decode();
  reader.releaseLock();

  return text;
}

describe('direct Workers AI terminal cancel', () => {
  test('a producer-open stream ends at [DONE] with the upstream cancelled', async () => {
    const binding = scriptedBinding([nativeFrame('hi'), DONE], true);

    // SAFETY: this constructed fixture provides `Ai.run`, and the adapter
    // under test calls no other member of the binding.
    const fetch = createDirectWorkersAIFetch(binding.ai as Ai);

    const response = await fetch('https://fake.invalid/ai/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: turnBody(),
    });

    const text = await drain(response.body ?? new ReadableStream<Uint8Array>());

    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
    expect(text).toContain('hi');
    expect(binding.cancels).toHaveLength(1);

    const reader = binding.stream.getReader();

    reader.releaseLock();
  });

  test('a rejecting upstream cancel reaches the caller with the lock released', async () => {
    const binding = scriptedBinding([nativeFrame('hi'), DONE], true, () => Promise.reject(new Error('boom')));

    // SAFETY: same constructed `Ai.run` fixture as above.
    const fetch = createDirectWorkersAIFetch(binding.ai as Ai);

    const response = await fetch('https://fake.invalid/ai/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: turnBody(),
    });

    let outcome: string;

    try {
      await drain(response.body ?? new ReadableStream<Uint8Array>());
      outcome = 'resolved';
    } catch (cause) {
      outcome = cause instanceof Error ? cause.message : String(cause);
    }

    expect(outcome).toBe('boom');
    expect(binding.cancels).toHaveLength(1);

    const reader = binding.stream.getReader();

    reader.releaseLock();
  });
});
