/**
 * Abort delivery to the in-flight openai-compat request. The miniflare pool cannot observe this (subrequest abort
 * never reaches a Node-side outboundService); the workerd suite owns the owed-proof half.
 */
import { describe, test, expect } from 'bun:test';
import { streamText } from 'ai';
import { asFetchFunction } from '../src/providers/fetch-shim';
import {
  createOpenAICompatProvider,
  type ProviderDeps, type AuthResolution,
} from '../src/index';

function sseData(payload: string): string {
  return `data: ${payload}\n\n`;
}

describe('openai-compat cancellation', () => {
  test('aborting the turn aborts the in-flight provider request', async () => {
    const seen: Array<{ live: boolean; fired: boolean; same: boolean }> = [];
    const controller = new AbortController();

    const fetchImpl = asFetchFunction(async (_input, init) => {
      const signal = init?.signal ?? null;

      const entry = {
        live: signal instanceof AbortSignal,
        fired: false,
        same: signal === controller.signal,
      };

      seen.push(entry);

      const encoder = new TextEncoder();

      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(encoder.encode(
              sseData('{"choices":[{"index":0,"delta":{"content":"hello"}}]}'),
            ));

            // Close on abort so the in-flight call settles instead of parking behind a silent producer.
            if (signal instanceof AbortSignal) {
              if (signal.aborted) {
                entry.fired = true;
                stream.close();
              } else {
                signal.addEventListener('abort', () => {
                  entry.fired = true;
                  stream.close();
                }, { once: true });
              }
            }
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });

    const auth: AuthResolution = {
      headers: { Authorization: 'Bearer probe-fixture-key' },
      baseURL: 'http://fake.invalid',
    };

    const deps: ProviderDeps = {
      env: {},
      fetch: fetchImpl,
      getAuth: async () => auth,
      hasCredential: async () => true,
    };

    const model = createOpenAICompatProvider().createModel('probe', deps);
    const firstChunk = Promise.withResolvers<void>();

    const result = streamText({
      model,
      prompt: 'hello',
      abortSignal: controller.signal,
      onChunk: () => {
        firstChunk.resolve();
      },
    });

    const text = result.text;

    // Abort after the first chunk, never inside the SDK's chunk callback, where it would throw through the transform.
    await firstChunk.promise;
    controller.abort();

    let failureMessage = '';

    try {
      await text;
    } catch (cause) {
      failureMessage = cause instanceof Error ? cause.message : String(cause);
    }

    // The fetch saw the identical signal the turn was given, and it fired.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.live).toBe(true);
    expect(seen[0]?.same).toBe(true);
    expect(seen[0]?.fired).toBe(true);

    expect(failureMessage.length).toBeGreaterThan(0);
    expect(failureMessage).toContain('abort');
    expect(seen).toHaveLength(1);
  });
});
