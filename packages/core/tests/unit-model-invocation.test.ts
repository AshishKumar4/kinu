/**
 * Every model call core makes reaches the workspace spend total, read back from the ledger the total sums
 * (`workspaceSpend` over the run-event rows). One case per call family: an endpoint model called through the one
 * stack, and the Workers AI utility bindings. The turn loop's steps and the MCTS rollouts reach the total
 * by their own seams (`step_finish`, the engine's report), which unit-workspace-spend and the MCTS suites hold.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { createTestActors, unpricedLedger } from '@kinu.run/test-utils';
import { createTestWorkspace } from './helpers';
import { RunEventRecorder } from '../src/events/recorder';
import { workspaceSpend } from '../src/read-models/workspace-spend';
import { createWorkersAIEmbedder, generateObjectReported, generateReported, streamTextReported } from '../src/providers/model-invocation';
import { createChatModel } from '../src/llm';
import { createWireModel, withModelStack } from '../src/providers/wire-model';
import { asFetchFunction } from '../src/providers/fetch-shim';
import { buildCfWebSearchProvider } from '../src/web/provider-factory';
import { DEFAULT_WEB_SEARCH_CHAIN } from '../src/providers/web-search';
import type { ModelCallSink } from '../src/events/model-call';
import type { Usage } from '../src/usage';

interface Spent {
  readonly calls: number;
  readonly unmeasured: number;
  readonly usage: Usage;
}

/** A fresh workspace's ledger: the sink its calls file into, and the producers its spend total reads back. */
interface Ledger {
  readonly report: ModelCallSink;
  readonly producers: () => Record<string, Spent>;
  /** Calls per provider account, as the gateway's account stamp named them. */
  readonly accounts: () => Record<string, number>;
}

function ledger(): Ledger {
  const ws = createTestWorkspace();
  const actor = createTestActors(ws.sql, ws.execRaw).main;
  const events = new RunEventRecorder(ws.sql, actor);

  return {
    report: unpricedLedger(events),
    producers: () => Object.fromEntries(workspaceSpend({ events, sql: ws.sql, actor }).producers
      .map((producer) => [producer.source, {
        calls: producer.calls, unmeasured: producer.callsWithoutUsage, usage: producer.usage,
      }])),
    accounts: () => Object.fromEntries(workspaceSpend({ events, sql: ws.sql, actor }).accounts
      .map((spent) => [`${spent.provider ?? '-'}@${spent.account ?? '-'}`, spent.calls])),
  };
}

describe('an endpoint model files every call it makes', () => {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const body = v.parse(v.looseObject({ stream: v.optional(v.boolean()) }), await request.json());
      const usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };

      if (body.stream === true) {
        const chunk = (delta: { content?: string }, finish: string | null): string => `data: ${JSON.stringify({
          id: 'c-1', object: 'chat.completion.chunk', created: 0, model: 'served-model',
          choices: [{ index: 0, delta, finish_reason: finish }], usage,
        })}\n\n`;

        return new Response(`${chunk({ content: 'streamed' }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`, {
          headers: { 'content-type': 'text/event-stream', 'x-kinu-account': 'openai@work' },
        });
      }

      return Response.json({
        id: 'c-1', object: 'chat.completion', created: 0, model: 'served-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'completed' }, finish_reason: 'stop' }], usage,
      }, { headers: { 'x-kinu-account': 'openai@work' } });
    },
  });

  afterAll(() => server.stop(true));

  test('a completion and a drained stream each land once, measured, under the caller\'s producer and account', async () => {
    const { report, producers, accounts } = ledger();

    const model = withModelStack(createChatModel({
      kind: 'openai-compat', name: 'endpoint', baseURL: `http://127.0.0.1:${String(server.port)}/v1`, headers: {}, modelId: 'served-model',
    }), { provider: 'endpoint', modelId: 'served-model', lane: 'endpoint' });

    const spend = { source: 'reflection', report } as const;

    expect((await generateReported({ model, prompt: 'reflect' }, { spend })).text).toBe('completed');
    let streamed = '';

    for await (const chunk of streamTextReported({ model, instructions: 'brief', messages: [{ role: 'user', content: 'go' }] }, { spend })) {
      streamed += chunk;
    }

    expect(streamed).toBe('streamed');
    // The endpoint reports cache reads and reasoning as measured zeros, and they stay measured.
    expect(producers()).toEqual({
      reflection: { calls: 2, unmeasured: 0, usage: { input: 24, output: 6, cacheRead: 0, reasoning: 0 } },
    });
    expect(accounts()).toEqual({ 'openai@work': 2 });
  });
});

describe('a structured call', () => {
  const Fact = v.object({ key: v.string(), value: v.unknown(), note: v.optional(v.string()) });

  const USAGE = { inputTokens: { total: 9, noCache: 9, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 2, text: 2, reasoning: undefined } };

  /** `text` as a model streams it, in pieces of `piece` characters `delay` ms apart, stopping as `finish` says. */
  const streamed = (text: string, opts: { finish?: 'stop' | 'length'; piece?: number; delay?: number } = {}) => {
    const piece = opts.piece ?? text.length;
    const deltas = Array.from({ length: Math.ceil(text.length / Math.max(1, piece)) }, (_, at) => text.slice(at * piece, (at + 1) * piece));

    const parts: LanguageModelV3StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't' },
      ...deltas.map((delta): LanguageModelV3StreamPart => ({ type: 'text-delta', id: 't', delta })),
      { type: 'text-end', id: 't' },
      { type: 'finish', finishReason: { unified: opts.finish ?? 'stop', raw: undefined }, usage: USAGE },
    ];

    return { stream: simulateReadableStream({ chunks: parts, chunkDelayInMs: opts.delay ?? null }) };
  };

  /** A model that answers `text`, stopping as `finish` says, having read 9 tokens and written 2. */
  const answering = (text: string, finish: 'stop' | 'length' = 'stop') => new MockLanguageModelV3({ doStream: async () => streamed(text, { finish }) });

  test('an answer off the schema is refused as wrong, and was billed like any answer', async () => {
    const { report, producers } = ledger();
    const spend = { source: 'fast', report } as const;

    expect(await generateObjectReported({ model: answering('{"key":"build.dir","value":"dist"}'), prompt: 'p' }, Fact, { spend })).toEqual({ key: 'build.dir', value: 'dist' });

    for (const text of ['not json', '{"value":1}']) {
      await expect(generateObjectReported({ model: answering(text), prompt: 'p' }, Fact, { spend })).rejects.toMatchObject({ code: 'bad_input' });
    }

    expect(producers()).toEqual({ fast: { calls: 3, unmeasured: 0, usage: { input: 27, output: 6 } } });
  });

  // Cut off, the answer is incomplete rather than wrong: asked again, the model may finish it.
  test('an answer stopped at the output limit is no answer yet, not a wrong one', async () => {
    const { report } = ledger();

    await expect(generateObjectReported({ model: answering('{"key":"build', 'length'), prompt: 'p' }, Fact, { spend: { source: 'fast', report } }))
      .rejects.toMatchObject({ code: 'unavailable' });
  });

  // Workers AI ended a 14k-token dreamer brief's non-streamed request at 10 minutes (408, 3046) while the same call
  // streamed answered in 7 (2026-10-20): a provider ends a request that sends nothing for that long.
  test('a call that reasons longer than a provider holds a silent request is answered, as it streams', async () => {
    const { report, producers } = ledger();

    const model = new MockLanguageModelV3({
      doGenerate: async () => { throw new Error('Request timeout (HTTP 408, 3046)'); },
      doStream: async () => streamed('{"key":"build.dir","value":"dist"}', { piece: 4, delay: 5 }),
    });

    expect(await generateObjectReported({ model, prompt: 'p', maxRetries: 0 }, Fact, { spend: { source: 'judge', report } })).toEqual({ key: 'build.dir', value: 'dist' });
    expect(producers()).toEqual({ judge: { calls: 1, unmeasured: 0, usage: { input: 9, output: 2 } } });
  });

  // OpenAI's strict mode refuses a schema with an optional field or an open value before answering.
  test('the schema goes to the Responses API as a schema, not strict', async () => {
    const sent: unknown[] = [];

    const model = createWireModel({
      name: 'opencode-go', modelId: 'gpt-6-luna', baseURL: 'https://opencode.example/v1', protocol: 'responses', reasoning: true,
      fetch: asFetchFunction(async (_input, init) => {
        sent.push(await new Response(init?.body).json());

        return Response.json({ error: { message: 'recorded' } }, { status: 400 });
      }),
    });

    await expect(generateObjectReported({ model, prompt: 'p', maxRetries: 0 }, Fact, { spend: { source: 'fast', report: () => {} } })).rejects.toThrow();
    expect(sent).toEqual([expect.objectContaining({ text: { format: expect.objectContaining({ type: 'json_schema', strict: false }) } })]);
  });
});

describe('the Workers AI utility bindings file unmeasured platform spend', () => {
  test('each embedding request is one row, however many texts it carries', async () => {
    const { report, producers } = ledger();

    const embedder = createWorkersAIEmbedder({
      env: { AI: { run: async (_model, input) => ({ data: (Array.isArray(input.text) ? input.text : [input.text]).map(() => [0.5]) }) } },
      dimensions: 1,
      report,
    });

    await embedder?.embed('one');
    await embedder?.embedBatch?.(['two', 'three']);
    // The binding returns no usage: counted, and never zeroed.
    expect(producers()).toEqual({ platform: { calls: 2, unmeasured: 2, usage: {} } });
  });

  test('a page converted through the binding is one row; without the binding nothing is converted or filed', async () => {
    const { report, producers } = ledger();
    const realFetch = globalThis.fetch;

    globalThis.fetch = Object.assign(
      async () => new Response('<html><body><h1>Title</h1></body></html>', { headers: { 'content-type': 'text/html' } }),
      { preconnect: realFetch.preconnect },
    );

    try {
      const unusedBrowser = { quickAction: async () => new Response('this test renders no page', { status: 500 }) };

      const converting = buildCfWebSearchProvider({
        AI: { toMarkdown: async () => [{ format: 'markdown', data: '# Title' }] },
        BROWSER: unusedBrowser,
      }, { auth: () => undefined, chain: async () => ({ routes: DEFAULT_WEB_SEARCH_CHAIN, retries: 0 }) }, report);

      expect((await converting.fetch('https://example.test/')).markdown).toContain('# Title');
      expect(producers()).toEqual({ platform: { calls: 1, unmeasured: 1, usage: {} } });

      await buildCfWebSearchProvider({ BROWSER: unusedBrowser }, { auth: () => undefined, chain: async () => ({ routes: DEFAULT_WEB_SEARCH_CHAIN, retries: 0 }) }, report).fetch('https://example.test/');
      expect(producers()).toEqual({ platform: { calls: 1, unmeasured: 1, usage: {} } });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
