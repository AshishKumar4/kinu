/**
 * Cancellation over the real openai-compat request path: the provider is
 * built with an injected fetch whose received AbortSignal is recorded, the
 * turn's stream is aborted mid-flight, and the test asserts the abort
 * reached the in-flight provider request and the call settled cancelled.
 *
 * What this does NOT cover, and why: a product turn settling cancelled with
 * nothing owed needs Think plus the terminal ledger, which need the DO
 * runtime — there is no bun seam for that half. The workerd suite owns the
 * owed-proof for completed drives (failures [] + owed [] on every settle
 * verdict); this test owns the abort-delivery half, which the miniflare pool
 * cannot observe (subrequest abort never reaches a Node-side outboundService
 * handler — see the two-turn suite header).
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
          start(controller) {
            controller.enqueue(encoder.encode(
              sseData('{"choices":[{"index":0,"delta":{"content":"hello"}}]}'),
            ));

            // A real server stops producing when the client goes away: close
            // on abort so the in-flight call settles instead of parking
            // behind a silent producer.
            if (signal instanceof AbortSignal) {
              if (signal.aborted) {
                entry.fired = true;
                controller.close();
              } else {
                signal.addEventListener('abort', () => {
                  entry.fired = true;
                  controller.close();
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

    // Awaited joins only: the abort fires after the first chunk is processed,
    // in the test body — never synchronously inside the SDK's chunk callback,
    // where it would throw back through the transform.
    await firstChunk.promise;
    controller.abort();

    let failureMessage = '';

    try {
      await text;
    } catch (cause) {
      failureMessage = cause instanceof Error ? cause.message : String(cause);
    }

    // The abort reached the provider request itself, not just the SDK loop:
    // the fetch saw a live signal, the identical object the turn was given
    // (no copy or wrap in between), and that received signal fired.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.live).toBe(true);
    expect(seen[0]?.same).toBe(true);
    expect(seen[0]?.fired).toBe(true);

    // And the call settled cancelled: an abort rejection naming the abort,
    // never a retry and never a silent resolve — exactly one provider call
    // went out and nothing is outstanding behind it.
    expect(failureMessage.length).toBeGreaterThan(0);
    expect(failureMessage).toContain('abort');
    expect(seen).toHaveLength(1);
  });
});
