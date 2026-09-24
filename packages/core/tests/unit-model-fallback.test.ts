// A tier's fallback chain, driven over a real OpenAI-compatible endpoint: a failed call hands the turn to the next
// model, from what the turn kept, and says so; nothing retries silently.
import { describe, expect, test } from 'bun:test';
import { tool, type ToolSet } from 'ai';
import * as v from 'valibot';
import { z } from 'zod';
import {
  createChatModel, createOpenAICompatProvider, createProviderRegistry, runChat,
  type AuthResolution, type ChatEvent, type ChatFallback, type ProviderDeps,
} from '../src/index';

const SSE_HEADERS = { 'content-type': 'text/event-stream' };

const sse = (events: readonly string[]): string => events.map((event) => `data: ${event}\n\n`).join('');

const answer = (text: string): Response => new Response(sse([
  JSON.stringify({ choices: [{ delta: { content: text } }] }),
  JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } }),
  '[DONE]',
]), { headers: SSE_HEADERS });

const toolStep = (): Response => new Response(sse([
  JSON.stringify({ choices: [{ delta: { tool_calls: [
    { index: 0, id: 'tc1', type: 'function', function: { name: 'run', arguments: '{"command":"wc -l"}' } },
  ] } }] }),
  JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } }),
  '[DONE]',
]), { headers: SSE_HEADERS });

const refused = (status: number): Response => Response.json({ error: { message: `refused with ${String(status)}` } }, { status });

/** Part of an answer, then the provider's stream fails. */
const partThenFail = (text: string): Response => new Response(sse([
  JSON.stringify({ choices: [{ delta: { content: text } }] }),
  JSON.stringify({ error: { message: 'upstream overloaded', code: 503 } }),
]), { headers: SSE_HEADERS });

const RequestSchema = v.looseObject({ model: v.string(), messages: v.array(v.unknown()) });

interface Served {
  readonly model: string;
  readonly body: string;
}

const ServedSchema = v.looseObject({ model: v.string(), reasoning_effort: v.optional(v.string()) });

/** One endpoint for every model; `answerFor` decides each request from the model it names and how often it asked. */
async function turn(answerFor: (model: string, seen: number) => Response, fallbacks: readonly string[]) {
  const served: Served[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.text();
      const { model } = v.parse(RequestSchema, JSON.parse(body));
      served.push({ model, body });

      return answerFor(model, served.filter((entry) => entry.model === model).length);
    },
  });

  const modelFor = (modelId: string) => createChatModel({
    kind: 'openai-compat', name: 'openrouter', baseURL: `http://localhost:${String(server.port)}/v1`,
    headers: { Authorization: 'Bearer test' }, modelId,
  });

  const tools: ToolSet = {
    run: tool({
      description: 'shell',
      inputSchema: z.object({ command: z.string() }),
      execute: async ({ command }: { command: string }) => `ran: ${command}`,
    }),
  };

  // Each model carries its own reasoning options: the turn's are 'low', a fallback's 'high'.
  const chain: ChatFallback[] = fallbacks.map((modelId) => ({
    spec: `openrouter/${modelId}`,
    bind: () => ({ model: modelFor(modelId), provider: 'openrouter', providerOptions: { openrouter: { reasoningEffort: 'high' } } }),
  }));

  const events: ChatEvent[] = [];
  let threw: Error | null = null;

  try {
    for await (const event of runChat({
      model: modelFor('primary'), modelContext: { id: 'openrouter/primary' }, fallbacks: chain,
      providerOptions: { openrouter: { reasoningEffort: 'low' } },
      system: 'sys', history: [{ role: 'user', content: 'go' }], tools,
    })) events.push(event);
  } catch (error) {
    threw = error instanceof Error ? error : new Error(String(error));
  } finally {
    await server.stop(true);
  }

  return { events, threw, served };
}

describe('a failed call hands the turn down its fallback chain', () => {
  test('a refused model hands over at once, and the turn says which model answered and why', async () => {
    const { events, threw, served } = await turn((model) => (model === 'primary' ? refused(402) : answer('from backup')), ['backup']);

    expect(threw).toBeNull();
    expect(served.map((entry) => entry.model)).toEqual(['primary', 'backup']);
    const switched = events.find((event) => event.type === 'model-fallback');
    expect(switched).toMatchObject({ type: 'model-fallback', from: 'openrouter/primary', to: 'openrouter/backup' });
    expect(switched?.type === 'model-fallback' ? switched.reason : '').toContain('HTTP 402');
    expect(events.find((event) => event.type === 'done')).toMatchObject({ text: 'from backup' });
  });

  test('a model that keeps failing hands over after its retries, and the next model carries on from the kept steps under its own name', async () => {
    const { events, threw, served } = await turn((model, seen) => {
      if (model === 'backup') return answer('done after the tool');

      return seen === 1 ? toolStep() : refused(503);
    }, ['backup']);

    expect(threw).toBeNull();
    // One tool step, then the SDK's own attempts at the failing second step, then the backup.
    expect(served.map((entry) => entry.model)).toEqual(['primary', 'primary', 'primary', 'primary', 'backup']);
    // The backup continues the turn: the finished tool step and its result are in its request.
    expect(served.at(-1)?.body).toContain('ran: wc -l');
    expect(events.filter((event) => event.type === 'model-fallback')).toHaveLength(1);
    expect(events.find((event) => event.type === 'done')).toMatchObject({ text: 'done after the tool' });
    // A step names the fallback that served it, and none when the turn's own model did.
    expect(events.flatMap((event) => (event.type === 'step-finish' ? [{ fallback: event.fallback, modelId: event.modelId }] : [])))
      .toEqual([{ fallback: undefined, modelId: 'primary' }, { fallback: 'openrouter/backup', modelId: 'backup' }]);
  });

  test('each failing model is announced in turn until one answers', async () => {
    const { events, threw } = await turn((model) => (model === 'last' ? answer('from last') : refused(401)), ['backup', 'last']);

    expect(threw).toBeNull();
    expect(events.filter((event) => event.type === 'model-fallback').map((event) => (event.type === 'model-fallback' ? `${event.from}>${event.to}` : '')))
      .toEqual(['openrouter/primary>openrouter/backup', 'openrouter/backup>openrouter/last']);
  });

  test('each call carries its own model\u2019s reasoning options, never the failed model\u2019s', async () => {
    const { served } = await turn((model) => (model === 'primary' ? refused(402) : answer('from backup')), ['backup']);

    expect(served.map((entry) => {
      const request = v.parse(ServedSchema, JSON.parse(entry.body));

      return [request.model, request.reasoning_effort];
    })).toEqual([['primary', 'low'], ['backup', 'high']]);
  });

  test('a chain that runs out fails the turn with the last model\u2019s error', async () => {
    const { events, threw } = await turn(() => refused(401), ['backup']);

    expect(events.filter((event) => event.type === 'model-fallback')).toHaveLength(1);
    expect(threw?.message ?? '').toContain('HTTP 401');
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });

  test('a model that fails after streaming part of its answer fails the turn, as the person already saw that part', async () => {
    const { events, threw, served } = await turn((model) => (model === 'primary' ? partThenFail('The answer is') : answer('from backup')), ['backup']);

    expect(served.map((entry) => entry.model)).toEqual(['primary']);
    expect(events.some((event) => event.type === 'model-fallback' || event.type === 'done')).toBe(false);
    expect(threw).not.toBeNull();
  });

  test('a request refused as malformed fails the turn instead of trying the next model, which would refuse it too', async () => {
    const { events, threw, served } = await turn((model) => (model === 'primary' ? refused(400) : answer('from backup')), ['backup']);

    expect(served.map((entry) => entry.model)).toEqual(['primary']);
    expect(events.some((event) => event.type === 'model-fallback')).toBe(false);
    expect(threw?.message ?? '').toContain('HTTP 400');
  });
});

/** Two accounts of one OpenAI-compatible provider on one endpoint; `answerFor` decides by the key each request carries. */
async function accountTurn(answerFor: (key: string, seen: number) => Response, fallbacks: readonly string[]) {
  const served: { key: string; handover: boolean }[] = [];

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const key = request.headers.get('authorization') ?? '';
      served.push({ key, handover: request.headers.has('x-kinu-rate-limit-handover') });

      return answerFor(key, served.filter((entry) => entry.key === key).length);
    },
  });

  const baseURL = `http://localhost:${String(server.port)}/v1`;

  const stored = new Map<string, AuthResolution>([
    ['openai-compat.default@work', { headers: { Authorization: 'Bearer key-work' }, baseURL }],
    ['openai-compat.default@home', { headers: { Authorization: 'Bearer key-home' }, baseURL }],
  ]);

  const deps: ProviderDeps = {
    env: {},
    async getAuth(key) { return stored.get(key) ?? null; },
    async hasCredential(key) { return stored.has(key); },
    async listCredentialKeys() { return [...stored.keys()]; },
  };

  const registry = createProviderRegistry();
  registry.register(createOpenAICompatProvider());

  const chain: ChatFallback[] = fallbacks.map((spec) => ({
    spec,
    bind: () => ({ model: registry.resolve(spec, deps), provider: 'openai-compat' }),
  }));

  const events: ChatEvent[] = [];

  try {
    for await (const event of runChat({
      model: registry.resolve('openai-compat@work/m', deps), modelContext: { id: 'openai-compat@work/m' }, fallbacks: chain,
      system: 'sys', history: [{ role: 'user', content: 'go' }], tools: {},
    })) events.push(event);
  } finally {
    await server.stop(true);
  }

  return { events, served };
}

const rateLimited = (retryAfterSeconds: number): Response => Response.json(
  { error: { message: 'rate limited' } },
  { status: 429, headers: { 'retry-after': String(retryAfterSeconds) } },
);

describe('an account that hits its limit hands the turn to the next account of its chain', () => {
  test('a 429 inside a chain hands over at once, says why, and the next account does not wait out the first\'s cooldown', async () => {
    const { events, served } = await accountTurn(
      (key) => (key === 'Bearer key-work' ? rateLimited(30) : answer('from home')),
      ['openai-compat@home/m'],
    );

    expect(served.map((entry) => entry.key)).toEqual(['Bearer key-work', 'Bearer key-home']);
    expect(served.some((entry) => entry.handover)).toBe(false);
    const switched = events.find((event) => event.type === 'model-fallback');
    expect(switched).toMatchObject({ type: 'model-fallback', from: 'openai-compat@work/m', to: 'openai-compat@home/m' });
    const reason = switched?.type === 'model-fallback' ? switched.reason : '';
    expect(reason).toContain('rate-limiting this account (HTTP 429)');
    expect(reason).toContain('resets in 30s');
    expect(events.find((event) => event.type === 'done')).toMatchObject({ text: 'from home' });
    // The step the second account answered is charged to it, under the fallback that served it.
    expect(events.flatMap((event) => (event.type === 'step-finish' ? [{ account: event.account?.name, fallback: event.fallback }] : [])))
      .toEqual([{ account: 'home', fallback: 'openai-compat@home/m' }]);
  });

  test('a lone model keeps waiting out its limit, and nothing hands over', async () => {
    const { events, served } = await accountTurn(
      (_key, seen) => (seen === 1 ? rateLimited(0) : answer('from work')),
      [],
    );

    expect(served.map((entry) => entry.key)).toEqual(['Bearer key-work', 'Bearer key-work']);
    expect(events.some((event) => event.type === 'model-fallback')).toBe(false);
    expect(events.find((event) => event.type === 'done')).toMatchObject({ text: 'from work' });
  });
});
