/**
 * Every model call core makes reaches the workspace spend total, read back from the ledger the total sums
 * (`workspaceSpend` over the run-event rows). One case per call family: the endpoint LLM, the completion rater,
 * the JSON judge, and the Workers AI utility bindings. The turn loop's steps and the MCTS rollouts reach the total
 * by their own seams (`step_finish`, the engine's report), which unit-workspace-spend and the MCTS suites hold.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider';
import { createTestActors } from '@kinu.run/test-utils';
import { createTestWorkspace } from './helpers';
import { RunEventRecorder } from '../src/events/recorder';
import { unpricedLedgerSink } from '../src/events/model-call-event';
import { workspaceSpend } from '../src/read-models/workspace-spend';
import { createCompletionLLM, createVercelAILLM } from '../src/llm';
import { createJsonJudge } from '../src/evolution/control';
import { createWorkersAIEmbedder } from '../src/providers/model-invocation';
import { buildCfWebSearchProvider } from '../src/web/provider-factory';
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
    report: unpricedLedgerSink(events),
    producers: () => Object.fromEntries(workspaceSpend({ events, sql: ws.sql, actor }).producers
      .map((producer) => [producer.source, {
        calls: producer.calls, unmeasured: producer.callsWithoutUsage, usage: producer.usage,
      }])),
    accounts: () => Object.fromEntries(workspaceSpend({ events, sql: ws.sql, actor }).accounts
      .map((spent) => [`${spent.provider ?? '-'}@${spent.account ?? '-'}`, spent.calls])),
  };
}

function answered(text: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 30, noCache: 30, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 4, text: 4, reasoning: undefined },
    },
    warnings: [],
    response: { modelId: 'served-model' },
  };
}

const modelAnswering = (text: string): MockLanguageModelV3 =>
  new MockLanguageModelV3({ doGenerate: async () => answered(text) });

describe('an endpoint LLM files every call it makes', () => {
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

    const llm = createVercelAILLM({
      name: 'endpoint', baseURL: `http://127.0.0.1:${String(server.port)}/v1`, headers: {}, model: 'served-model',
    }, { source: 'reflection', report });

    expect(await llm.complete('reflect')).toBe('completed');
    let streamed = '';

    for await (const chunk of llm.stream({ system: 'brief', messages: [{ role: 'user', content: 'go' }] })) streamed += chunk;

    expect(streamed).toBe('streamed');
    // The endpoint reports cache reads and reasoning as measured zeros, and they stay measured.
    expect(producers()).toEqual({
      reflection: { calls: 2, unmeasured: 0, usage: { input: 24, output: 6, cacheRead: 0, reasoning: 0 } },
    });
    expect(accounts()).toEqual({ 'openai@work': 2 });
  });
});

describe('the raters file their calls as judge spend', () => {
  test('a completion rater files each answer it gives, priced against its spec', async () => {
    const { report, producers } = ledger();

    const rater = createCompletionLLM({
      model: modelAnswering('accepted'), spec: 'workers-ai/@cf/rater', stage: 'judge', spend: { source: 'judge', report },
    });

    expect(await rater.complete('classify this turn')).toBe('accepted');
    expect(producers()).toEqual({ judge: { calls: 1, unmeasured: 0, usage: { input: 30, output: 4 } } });
  });

  test('a JSON judge files its call even when the answer fails the schema: the call was billed', async () => {
    const { report, producers } = ledger();
    const judge = createJsonJudge(() => modelAnswering('{"score": "not a number"}'), report);
    const Score = v.object({ score: v.number() });

    await expect(judge({ schema: Score, prompt: 'score it' })).rejects.toThrow();
    expect(producers()).toEqual({ judge: { calls: 1, unmeasured: 0, usage: { input: 30, output: 4 } } });
  });

  test('a call the provider refused was not billed, and files nothing', async () => {
    const { report, producers } = ledger();

    const rater = createCompletionLLM({
      model: new MockLanguageModelV3({ doGenerate: async () => { throw new Error('provider down'); } }),
      spec: 'workers-ai/@cf/rater', stage: 'judge', spend: { source: 'judge', report },
    });

    await expect(rater.complete('classify this turn')).rejects.toThrow('provider down');
    expect(producers()).toEqual({});
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
      const converting = buildCfWebSearchProvider({
        AI: { toMarkdown: async () => [{ format: 'markdown', data: '# Title' }] },
      }, () => undefined, report);

      expect((await converting.fetch('https://example.test/')).markdown).toContain('# Title');
      expect(producers()).toEqual({ platform: { calls: 1, unmeasured: 1, usage: {} } });

      await buildCfWebSearchProvider({}, () => undefined, report).fetch('https://example.test/');
      expect(producers()).toEqual({ platform: { calls: 1, unmeasured: 1, usage: {} } });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
