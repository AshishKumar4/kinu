// A model stream that stops sending is a provider failure the fallback chain takes over; a slow stream that keeps
// sending is never cut, however long it runs. Driven through the real transport and turn, on the catalog's bound.
import { afterEach, describe, expect, jest, test } from 'bun:test';
import * as v from 'valibot';
import {
  createChatModel, createFallbackCooldowns, PLATFORM_CATALOG, runChat, silenceBoundMs, type ChatEvent, type ChatFallback,
  type PlatformFactId, type SilenceBoundId,
} from '../src/index';
import { APICallError } from 'ai';
import { asFetchFunction } from '../src/providers/fetch-shim';
import { PROVIDER_RETRIES_HEADER, PROVIDER_STREAM_HEADER, withRateLimitRetry } from '../src/providers/rate-limit-retry';
import type { ProviderWaitInfo } from '../src/providers/types';
import { fmtSpan } from '../src/utils/format';

const IDLE_MS = silenceBoundMs('provider.stream.idle_ms');

const RequestSchema = v.looseObject({ model: v.string() });

const encoder = new TextEncoder();

const frame = (event: string): Uint8Array => encoder.encode(`data: ${event}\n\n`);

const delta = (content: string): Uint8Array => frame(JSON.stringify({ choices: [{ delta: { content } }] }));

const roleOnly = frame(JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] }));

const finish = [
  frame(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })),
  frame('[DONE]'),
];

/** A provider whose body the test feeds: `next` settles each time the transport asks for the next chunk. */
interface ScriptedStream {
  readonly body: ReadableStream<Uint8Array>;
  next(): Promise<ReadableStreamDefaultController<Uint8Array>>;
}

function scriptedStream(): ScriptedStream {
  let pulls = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls.resolve(controller);
    },
  }, { highWaterMark: 0 });

  return {
    body,
    async next(): Promise<ReadableStreamDefaultController<Uint8Array>> {
      const controller = await pulls.promise;
      pulls = Promise.withResolvers();

      return controller;
    },
  };
}

function turnOver(primary: ScriptedStream) {
  const asked: string[] = [];

  const fetch = asFetchFunction(async (_input, init) => {
    const { model } = v.parse(RequestSchema, JSON.parse(v.parse(v.string(), init?.body)));
    asked.push(model);
    const sse = { headers: { 'content-type': 'text/event-stream' } };

    if (model === 'primary') return new Response(primary.body, sse);

    return new Response(new Blob([delta('from the fallback'), ...finish].map((chunk) => new Uint8Array(chunk))), sse);
  });

  const model = (modelId: string) => createChatModel({ kind: 'openai-compat', name: 'stub', baseURL: 'https://stub.invalid/v1', headers: {}, modelId, fetch });
  const fallback: ChatFallback = { spec: 'stub/fallback', accepts: new Set(), window: { contextWindow: null, modelOutputLimit: null }, bind: () => ({ model: model('fallback'), provider: 'stub' }) };
  const events: ChatEvent[] = [];

  const done = (async () => {
    for await (const event of runChat({
      model: model('primary'), modelContext: { id: 'stub/primary' }, modelSpec: 'stub/primary', fallbacks: [fallback],
      cooldowns: createFallbackCooldowns(), system: 'sys', history: [{ role: 'user', content: 'go' }], tools: {},
    })) events.push(event);
  })();

  return { asked, events, done };
}

const streamedRequest = (wrapped: typeof globalThis.fetch, retries: number) => wrapped('https://stub.invalid/v1/chat/completions', {
  method: 'POST', body: JSON.stringify({ model: 'm', stream: true }), headers: { [PROVIDER_RETRIES_HEADER]: String(retries), [PROVIDER_STREAM_HEADER]: '1' },
});

afterEach(() => { jest.useRealTimers(); });

/** Compiles only while `silenceBoundMs` admits the silence bound and refuses a duration, a total. */
type Admits<Id extends PlatformFactId> = Id extends SilenceBoundId ? 'admitted' : 'refused';

test('only a fact the catalog declares a silence bound may bound a silence', () => {
  const verdicts: [Admits<'provider.stream.idle_ms'>, Admits<'browser.session.keep_alive_ms'>] = ['admitted', 'refused'];

  expect(verdicts).toEqual(['admitted', 'refused']);
  expect(IDLE_MS).toBe(PLATFORM_CATALOG['provider.stream.idle_ms'].limit.value);
});

describe('a provider stream that stops sending', () => {
  test('fails at the bound and hands the turn to the fallback', async () => {
    jest.useFakeTimers();
    const primary = scriptedStream();
    const turn = turnOver(primary);

    (await primary.next()).enqueue(roleOnly);
    await primary.next();
    jest.advanceTimersByTime(IDLE_MS);
    await turn.done;

    expect(turn.asked).toEqual(['primary', 'fallback']);
    expect(turn.events).toContainEqual(expect.objectContaining({ type: 'model-fallback', from: 'stub/primary', to: 'stub/fallback' }));
    expect(turn.events).toContainEqual(expect.objectContaining({ type: 'done', text: 'from the fallback' }));
  });

  test('a provider that thinks without a byte past the bound hands over the same way', async () => {
    jest.useFakeTimers();
    const primary = scriptedStream();
    const turn = turnOver(primary);

    await primary.next();
    jest.advanceTimersByTime(IDLE_MS);
    await turn.done;

    expect(turn.asked).toEqual(['primary', 'fallback']);
    expect(turn.events).toContainEqual(expect.objectContaining({ type: 'done', text: 'from the fallback' }));
  });

  test('a slow stream that keeps sending is never cut, however long it runs', async () => {
    jest.useFakeTimers();
    const primary = scriptedStream();
    const turn = turnOver(primary);

    // Ten gaps each just under the bound: the stream runs ten bounds long, and no silence reaches one.
    for (const word of ['one ', 'two ', 'three ', 'four ', 'five ', 'six ', 'seven ', 'eight ', 'nine ', 'ten']) {
      const controller = await primary.next();
      jest.advanceTimersByTime(IDLE_MS - 1);
      controller.enqueue(delta(word));
    }

    for (const chunk of finish) (await primary.next()).enqueue(chunk);
    (await primary.next()).close();
    await turn.done;

    expect(turn.asked).toEqual(['primary']);
    expect(turn.events).toContainEqual(expect.objectContaining({ type: 'done', text: 'one two three four five six seven eight nine ten' }));
  });
});

describe('a provider that sends nothing before its first byte', () => {
  /** A provider silent `silent` times, each request hanging until the transport cuts it, then answering. */
  function silentThenAnswering(silent: number) {
    let calls = 0;
    const arrivals = Array.from({ length: silent + 1 }, () => Promise.withResolvers<void>());
    const waits: ProviderWaitInfo[] = [];

    const fetch = asFetchFunction(async (_input, init) => {
      calls += 1;
      arrivals[calls - 1]?.resolve();

      if (calls > silent) return new Response(new Blob([delta('at last'), ...finish].map((chunk) => new Uint8Array(chunk))));

      return await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(init.signal?.reason); }, { once: true });
      });
    });

    const wrapped = withRateLimitRetry(fetch, { provider: 'stub', sleep: async () => {}, onWait: (info) => { waits.push(info); } });
    const call = (retries: number) => streamedRequest(wrapped, retries);

    /** Settles once request `n` (1-based) reached the provider. */
    const reached = (n: number) => arrivals[n - 1]?.promise;

    return { call, waits, calls: () => calls, reached };
  }

  test('each silent attempt spends a retry and declares a wait before the transport asks again', async () => {
    jest.useFakeTimers();
    const provider = silentThenAnswering(2);
    const answered = provider.call(2);

    for (const request of [1, 2]) {
      await provider.reached(request);
      jest.advanceTimersByTime(IDLE_MS);
    }

    expect((await answered).status).toBe(200);
    expect(provider.calls()).toBe(3);
    expect(provider.waits.map(({ source, attempt, provider: who }) => ({ source, attempt, who })))
      .toEqual([{ source: 'stall', attempt: 1, who: 'stub' }, { source: 'stall', attempt: 2, who: 'stub' }]);
  });

  test('past its retries the call fails for the chain, which the SDK must not retry again', async () => {
    jest.useFakeTimers();
    const provider = silentThenAnswering(5);
    const answered = Promise.allSettled([provider.call(1)]);

    for (const request of [1, 2]) {
      await provider.reached(request);
      jest.advanceTimersByTime(IDLE_MS);
    }

    const [settled] = await answered;
    const failure = settled.status === 'rejected' ? settled.reason : null;
    expect(APICallError.isInstance(failure) && { message: failure.message, retryable: failure.isRetryable })
      .toEqual({ message: `stub sent nothing for ${fmtSpan(IDLE_MS)}`, retryable: false });
    expect(provider.calls()).toBe(2);
    expect(provider.waits.map(({ source }) => source)).toEqual(['stall']);
  });
});

describe('a provider whose stream opens with its error', () => {
  /** OpenRouter's upstream failure: HTTP 200, a keep-alive, then the error as the first event. */
  const erring = () => new Response(new Blob([
    encoder.encode(': OPENROUTER PROCESSING\n\n'),
    frame(JSON.stringify({ error: { code: 500, message: 'Upstream error from Inception: The server had an error while processing your request.' } })),
  ].map((chunk) => new Uint8Array(chunk))), { headers: { 'content-type': 'text/event-stream' } });

  const answering = () => new Response(new Blob([delta('at last'), ...finish].map((chunk) => new Uint8Array(chunk))), {
    headers: { 'content-type': 'text/event-stream' },
  });

  function erringThenAnswering(errors: number) {
    let calls = 0;
    const waits: ProviderWaitInfo[] = [];
    const fetch = asFetchFunction(async () => (++calls <= errors ? erring() : answering()));
    const wrapped = withRateLimitRetry(fetch, { provider: 'stub', sleep: async () => {}, onWait: (info) => { waits.push(info); } });

    return { wrapped, waits, calls: () => calls };
  }

  test('the error spends a retry and the transport asks again, as it does for an HTTP refusal', async () => {
    const provider = erringThenAnswering(1);
    const answered = await streamedRequest(provider.wrapped, 3);

    expect(await answered.text()).toContain('at last');
    expect(provider.calls()).toBe(2);
    expect(provider.waits.map(({ source, attempt }) => ({ source, attempt }))).toEqual([{ source: 'backoff', attempt: 1 }]);
  });

  test('past its retries the provider\'s own error reaches the caller', async () => {
    const provider = erringThenAnswering(5);
    const answered = await streamedRequest(provider.wrapped, 1);

    expect(await answered.text()).toContain('Upstream error from Inception');
    expect(provider.calls()).toBe(2);
  });
});
