/**
 * Direct Workers AI path: on `data: [DONE]` the adapter cancels the upstream reader rather than
 * waiting for the producer to close; a rejecting cancel still releases the lock.
 */
import { describe, test, expect } from 'bun:test';
import { createDirectWorkersAIFetch } from '@kinu.run/core';
import type { JsonObject } from '@kinu.run/core';

const encoder = new TextEncoder();

function nativeFrame(response: string): string {
  return `data: ${JSON.stringify({ response })}\n\n`;
}

const DONE = 'data: [DONE]\n\n';

/** Scripted frames with cancel calls counted; typed as the adapter's runner contract, no cast. */
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

  return {
    stream,
    cancels,
    run: (_model: string, _inputs: JsonObject, _options?: {
      signal?: AbortSignal;
      extraHeaders?: Record<string, string>;
      returnRawResponse?: boolean;
    }): Promise<Response | ReadableStream<Uint8Array> | JsonObject> => {
      for (const frame of frames) controller?.enqueue(encoder.encode(frame));

      if (!hangOpen) controller?.close();

      return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
    },
  };
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

    const fetch = createDirectWorkersAIFetch(binding);

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

    const fetch = createDirectWorkersAIFetch(binding);

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
