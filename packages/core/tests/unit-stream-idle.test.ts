// A model stream that stops sending is a provider failure the fallback chain takes over; a slow stream that keeps
// sending is never cut, however long it runs. Driven through the real transport and turn, on the catalog's bound.
import { afterEach, describe, expect, jest, test } from 'bun:test';
import * as v from 'valibot';
import {
  createChatModel, createFallbackCooldowns, PLATFORM_CATALOG, runChat, silenceBoundMs, type ChatEvent, type ChatFallback,
  type PlatformFactId, type SilenceBoundId,
} from '../src/index';
import { asFetchFunction } from '../src/providers/fetch-shim';

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
  const fallback: ChatFallback = { spec: 'stub/fallback', accepts: new Set(), bind: () => ({ model: model('fallback'), provider: 'stub' }) };
  const events: ChatEvent[] = [];

  const done = (async () => {
    for await (const event of runChat({
      model: model('primary'), modelContext: { id: 'stub/primary' }, modelSpec: 'stub/primary', fallbacks: [fallback],
      cooldowns: createFallbackCooldowns(), system: 'sys', history: [{ role: 'user', content: 'go' }], tools: {},
    })) events.push(event);
  })();

  return { asked, events, done };
}

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
