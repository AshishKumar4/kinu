// KINU-048: admission counts the assembled request, compacts once, recounts, and refuses before submission.
import { describe, expect, test } from 'bun:test';
import { tool, type ModelMessage } from 'ai';
import * as v from 'valibot';
import { z } from 'zod';
import { assembleTurnMessages } from '../src/orchestrator/turn-context';
import { runChat } from '../src/chat';
import { ExtensionHost } from '../src/extension';
import { classifyTurnFailure, planOverflowRecovery } from '../src/turn-failure';
import { stepContextLimit } from '../src/prompting/step-prune';
import {
  countRequestInputTokens, NO_COUNT_ENDPOINT,
  type CountableRequest, type InputTokenCount,
} from '../src/providers/input-tokens';
import { createAnthropicProvider } from '../src/providers/anthropic';
import { createOpenAIProvider } from '../src/providers/openai';
import { createOpenRouterProvider } from '../src/providers/openrouter';
import { createCodexProvider } from '../src/providers/codex';
import { createOpenAICompatProvider } from '../src/providers/openai-compat';
import type { ProviderDeps } from '../src/providers/types';
import { asFetchFunction } from '../src/providers/fetch-shim';

function bodyText(init: RequestInit | undefined): string {
  const body = v.safeParse(v.string(), init?.body);

  return body.success ? body.output : '{}';
}

const HISTORY: ModelMessage[] = [
  { role: 'user', content: 'the long conversation' },
  { role: 'assistant', content: 'the long answer' },
];

const COMPACTED: ModelMessage[] = [{ role: 'user', content: 'summary of the long conversation' }];

/** Measured window: an unmeasured one is admitted over rather than refused against. */
const LIMITS = { contextWindow: 200_000, modelOutputLimit: 40_000, windowMeasured: true };

const LIMIT = stepContextLimit(LIMITS);

function base() {
  return { system: 'SYS', history: HISTORY, sessionKey: 'k', contextWindow: LIMITS.contextWindow };
}

const SentCountBodySchema = v.looseObject({
  system: v.string(),
  messages: v.array(v.looseObject({
    role: v.string(),
    content: v.array(v.looseObject({ type: v.string() })),
  })),
  tools: v.array(v.looseObject({ name: v.string(), input_schema: v.looseObject({}) })),
});

/** Loose: vendor-only fields cost no tokens and the count endpoint does not take them. */
const WireBodySchema = v.looseObject({
  system: v.optional(v.union([
    v.string(),
    v.array(v.looseObject({ type: v.string(), text: v.optional(v.string()) })),
  ])),
  messages: v.array(v.looseObject({
    role: v.string(),
    content: v.union([
      v.string(),
      v.array(v.looseObject({ type: v.string(), text: v.optional(v.string()) })),
    ]),
  })),
  tools: v.optional(v.array(v.looseObject({
    name: v.string(),
    description: v.optional(v.string()),
    input_schema: v.optional(v.looseObject({})),
  }))),
});

type WireBody = v.InferOutput<typeof WireBodySchema>;

function systemTextOf(body: WireBody): string {
  const system = body.system;

  if (system === undefined) return '';

  if (Array.isArray(system)) return system.map((block) => block.text ?? '').join('');

  return system;
}

function countedBlocks(message: WireBody['messages'][number]): Array<{ type: string; text: string }> {
  const content = message.content;

  if (!Array.isArray(content)) return [{ type: 'text', text: content }];

  return content.map((block) => ({ type: block.type, text: block.text ?? '' }));
}

function toolIdentity(entry: NonNullable<WireBody['tools']>[number]): string {
  return JSON.stringify([entry.name, entry.description ?? '', entry.input_schema ?? {}]);
}

function compactionProbe() {
  const triggers: string[] = [];

  const extensions = new ExtensionHost().register({
    name: 'test.compact',
    transformContext: async (ctx) => {
      triggers.push(ctx.trigger);

      return ctx.trigger === 'force' ? COMPACTED : undefined;
    },
  });

  return { extensions, triggers };
}

function scriptedCounter(counts: readonly number[]) {
  const seen: CountableRequest[] = [];
  let call = 0;

  const count = async (request: CountableRequest): Promise<InputTokenCount> => {
    seen.push(request);
    const tokens = counts[Math.min(call, counts.length - 1)] ?? 0;
    call += 1;

    return { kind: 'counted', tokens };
  };

  return { seen, count };
}

/** The error an assembly refused with, or null when it admitted the request. */
async function refusalOf(assembly: Promise<readonly ModelMessage[]>): Promise<Error | null> {
  try {
    await assembly;

    return null;
  } catch (caught) {
    return caught instanceof Error ? caught : new Error(String(caught));
  }
}

describe('exact turn admission', () => {
  test('the allocation admission budgets against is the one every producer divides', () => {
    expect(LIMIT).toBe(160_000);
  });

  test('a request that fits is admitted, counted once, and compaction never forced', async () => {
    const { extensions, triggers } = compactionProbe();
    const counter = scriptedCounter([LIMIT]);

    const out = await assembleTurnMessages({
      ...base(),
      extensions,
      trigger: 'auto',
      admission: { count: counter.count, limits: LIMITS },
    });

    expect(out).toEqual(HISTORY);
    expect(triggers).toEqual(['auto']);
    expect(counter.seen.length).toBe(1);
  });

  test('an oversized request is compacted once and re-counted before submission', async () => {
    const { extensions, triggers } = compactionProbe();
    const counter = scriptedCounter([LIMIT + 1, LIMIT]);

    const out = await assembleTurnMessages({
      ...base(),
      extensions,
      trigger: 'auto',
      admission: { count: counter.count, limits: LIMITS },
    });

    expect(out).toEqual(COMPACTED);
    expect(triggers).toEqual(['auto', 'force']);
    expect(counter.seen.length).toBe(2);
    expect(counter.seen[1]?.messages).toEqual(COMPACTED);
  });

  test('a post-compaction request that still does not fit is refused, not submitted', async () => {
    const { extensions, triggers } = compactionProbe();
    const counter = scriptedCounter([LIMIT + 50_000, LIMIT + 1]);

    const failure = await refusalOf(assembleTurnMessages({
      ...base(),
      extensions,
      trigger: 'auto',
      admission: { count: counter.count, limits: LIMITS },
    }));

    expect(failure).toBeInstanceOf(Error);
    const message = failure?.message ?? '';
    expect(message).toContain('refused before submission');
    expect(message).toContain((LIMIT + 1).toLocaleString('en-US'));
    expect(triggers).toEqual(['auto', 'force']);
    expect(counter.seen.length).toBe(2);
  });

  test('the refusal carries its own failure class, not a transient one', async () => {
    // A local refusal must not arm the remote context-length recovery or read as `transient`: it can only refuse again.
    const { extensions } = compactionProbe();
    const counter = scriptedCounter([LIMIT + 1, LIMIT + 1]);

    const failure = await refusalOf(assembleTurnMessages({
      ...base(), extensions, trigger: 'auto',
      admission: { count: counter.count, limits: LIMITS },
    }));

    // Asserted first so an assembly that refused nothing cannot pass by classifying the empty string.
    expect(failure).toBeInstanceOf(Error);
    const message = failure?.message ?? '';
    expect(classifyTurnFailure(message)).toBe('admission_refused');
    expect(planOverflowRecovery({ error: message, turnWasOverflowRetry: false }))
      .toEqual({ failureClass: 'admission_refused', forceCompaction: false, enqueueRetry: false });
    // Negative control: the classifier does fire on a real remote refusal.
    expect(classifyTurnFailure('prompt is too long: 300000 tokens > 200000 maximum'))
      .toBe('context_length');
  });

  test('a turn that arrived already force-compacted is refused without compacting again', async () => {
    const { extensions, triggers } = compactionProbe();
    const counter = scriptedCounter([LIMIT + 1]);

    const failure = await refusalOf(assembleTurnMessages({
      ...base(),
      extensions,
      trigger: 'force',
      admission: { count: counter.count, limits: LIMITS },
    }));

    expect(failure).toBeInstanceOf(Error);
    expect(triggers).toEqual(['force']);
    expect(counter.seen.length).toBe(1);
  });

  test('a provider with no count endpoint is gated by the estimate: an over-window request compacts once, then is admitted or refused', async () => {
    const { extensions, triggers } = compactionProbe();
    let asked = 0;

    const out = await assembleTurnMessages({
      ...base(),
      extensions,
      trigger: 'auto',
      admission: {
        count: async () => {
          asked += 1;

          return { kind: 'unsupported', provider: 'openai', reason: NO_COUNT_ENDPOINT };
        },
        limits: LIMITS,
      },
    });

    expect(asked).toBe(1);
    expect(out).toEqual(HISTORY);
    expect(triggers).toEqual(['auto']);
  });

  test('with no count endpoint, an estimate over the window triggers the one forced compaction instead of submitting', async () => {
    const { extensions, triggers } = compactionProbe();
    // The allocation sits between the assembled and compacted estimates, so the estimate forces the compaction.
    const tight = { contextWindow: 48, modelOutputLimit: 20, windowMeasured: true };

    const out = await assembleTurnMessages({
      ...base(),
      extensions,
      trigger: 'auto',
      admission: { limits: tight },
    });

    expect(out).toEqual(COMPACTED);
    expect(triggers).toEqual(['auto', 'force']);
  });

  test('with no count endpoint, an estimate that still overflows after compaction is refused, not submitted', async () => {
    const { extensions } = compactionProbe();
    const tight = { contextWindow: 8, modelOutputLimit: 4, windowMeasured: true };

    const failure = await refusalOf(assembleTurnMessages({
      ...base(),
      extensions,
      trigger: 'force',
      admission: { limits: tight },
    }));

    expect(failure).not.toBeNull();
    expect(failure !== null && 'code' in failure ? failure.code : undefined).toBe('bad_input');
  });

  test('what is counted is the assembled request: system, messages, and the tools that ride it', async () => {
    const { extensions } = compactionProbe();
    const counter = scriptedCounter([1_000]);

    const tools = {
      look: tool({ description: 'look', inputSchema: z.object({ q: z.string() }) }),
    };

    await assembleTurnMessages({
      ...base(),
      extensions,
      trigger: 'auto',
      turnLocal: [{ role: 'user', content: 'turn-local tail' }],
      admission: { count: counter.count, limits: LIMITS, tools },
    });
    const counted = counter.seen[0];
    expect(counted?.system).toBe('SYS');

    expect(counted?.messages.at(-1)).toEqual({ role: 'user', content: 'turn-local tail' });
    expect(Object.keys(counted?.tools ?? {})).toEqual(['look']);
  });
});

const NO_DEPS: ProviderDeps = {
  env: {},
  getAuth: async () => ({ headers: { 'x-api-key': 'k' } }),
  hasCredential: async () => true,
};

describe('provider count support', () => {
  test('every active provider without a pre-request count endpoint says so', async () => {
    // Only Anthropic publishes a pre-request count; every other provider reports the absence.
    for (const provider of [
      createOpenAIProvider(),
      createOpenRouterProvider({ appTitle: 'test' }),
      createCodexProvider(),
      createOpenAICompatProvider(),
    ]) {
      const answer = await countRequestInputTokens(provider, 'm', NO_DEPS, { system: 's', messages: [] });
      expect(answer).toEqual({ kind: 'unsupported', provider: provider.id, reason: NO_COUNT_ENDPOINT });
    }
  });

  test('a model that resolved through no provider is reported, not counted', async () => {
    const answer = await countRequestInputTokens(undefined, 'm', NO_DEPS, { system: 's', messages: [] });
    expect(answer.kind).toBe('unsupported');
  });

  test('anthropic counts the assembled request through its own endpoint', async () => {
    let body: unknown;
    let url = '';

    const deps: ProviderDeps = {
      ...NO_DEPS,
      fetch: asFetchFunction(async (input, init) => {
        url = input instanceof Request ? input.url : String(input);
        body = JSON.parse(bodyText(init));

        return new Response(JSON.stringify({ input_tokens: 4242 }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }),
    };

    const request: CountableRequest = {
      system: 'SYS',
      messages: [
        { role: 'user', content: 'ask' },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'unsigned thinking' },
            { type: 'text', text: 'calling' },
            { type: 'tool-call', toolCallId: 'tc1', toolName: 'look', input: { q: 'x' } },
          ],
        },
        {
          role: 'tool',
          content: [{
            type: 'tool-result', toolCallId: 'tc1', toolName: 'look',
            output: { type: 'text', value: 'found it' },
          }],
        },
      ],
      tools: { look: tool({ description: 'look', inputSchema: z.object({ q: z.string() }) }) },
    };

    const answer = await countRequestInputTokens(createAnthropicProvider(), 'claude-opus-4-7', deps, request);

    expect(answer).toEqual({ kind: 'counted', tokens: 4242 });
    expect(url).toContain('/messages/count_tokens');
    // Parsed, not cast, so a body that lost its tools or roles cannot satisfy the reads below.
    const sent = v.parse(SentCountBodySchema, body);
    expect(sent.system).toBe('SYS');
    expect(sent.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    // The vendor drops unsigned reasoning, so the count body must too or it over-reports.
    expect(sent.messages[1]?.content.map((c) => c.type)).toEqual(['text', 'tool_use']);
    expect(sent.messages[2]?.content.map((c) => c.type)).toEqual(['tool_result']);
    expect(sent.tools[0]?.name).toBe('look');
    expect(sent.tools[0]?.input_schema).toMatchObject({ type: 'object' });
  });

  test('a request carrying a part the count body cannot represent is reported, not silently shrunk', async () => {
    const deps: ProviderDeps = {
      ...NO_DEPS,
      fetch: asFetchFunction(async () => { throw new Error('the endpoint must not be asked'); }),
    };

    const answer = await countRequestInputTokens(createAnthropicProvider(), 'claude-opus-4-7', deps, {
      system: 'SYS',
      messages: [{ role: 'user', content: [{ type: 'image', image: 'AAAA' }] }],
    });

    expect(answer.kind).toBe('unsupported');
    expect(answer.kind === 'unsupported' && answer.reason).toContain('image part');
  });

  test('an endpoint that refuses the count does not fail the turn', async () => {
    const deps: ProviderDeps = {
      ...NO_DEPS,
      // A status the shared transport does not retry (429/529 go through the rate-limit ladder).
      fetch: asFetchFunction(async () => new Response('{"error":{"message":"bad body"}}', { status: 400 })),
    };

    const answer = await countRequestInputTokens(createAnthropicProvider(), 'claude-opus-4-7', deps, {
      system: 'SYS', messages: [{ role: 'user', content: 'ask' }],
    });

    expect(answer.kind).toBe('unsupported');
    expect(answer.kind === 'unsupported' && answer.reason).toContain('400');
  });

  // `@ai-sdk/anthropic` does not export its converter, so `anthropic-count.ts` duplicates it; this catches drift.
  test('the count body matches the AI SDK own Anthropic request, field for field', async () => {
    const system = 'SYS';

    const history: ModelMessage[] = [
      { role: 'user', content: 'read the file and report' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading it' },
          { type: 'tool-call', toolCallId: 'toolu_01PARITY', toolName: 'look', input: { q: 'a.txt' } },
        ],
      },
      {
        role: 'tool',
        content: [{
          type: 'tool-result', toolCallId: 'toolu_01PARITY', toolName: 'look',
          output: { type: 'text', value: 'the file says 41' },
        }],
      },
    ];

    const tools = { look: tool({ description: 'look something up', inputSchema: z.object({ q: z.string() }) }) };

    let vendorBody: unknown;

    const vendorDeps: ProviderDeps = {
      ...NO_DEPS,
      fetch: asFetchFunction(async (_input, init) => {
        vendorBody = JSON.parse(bodyText(init));

        return new Response('{"error":{"message":"captured, not served"}}', { status: 400 });
      }),
    };

    const model = createAnthropicProvider().createModel('claude-opus-4-7', vendorDeps);
    let refused: unknown;

    try {
      for await (const _event of runChat({ model, system, history, tools })) { /* the request is the observation */ }
    } catch (caught) {
      refused = caught;
    }

    expect(refused).toBeInstanceOf(Error);
    // Proves the vendor converted: a turn failing for another reason would capture nothing.
    expect(vendorBody).toBeDefined();

    let countBody: unknown;

    const countDeps: ProviderDeps = {
      ...NO_DEPS,
      fetch: asFetchFunction(async (_input, init) => {
        countBody = JSON.parse(bodyText(init));

        return new Response(JSON.stringify({ input_tokens: 1 }), { status: 200 });
      }),
    };

    const counted = await countRequestInputTokens(
      createAnthropicProvider(), 'claude-opus-4-7', countDeps, { system, messages: history, tools },
    );

    expect(counted.kind).toBe('counted');
    expect(countBody).toBeDefined();

    const vendor = v.parse(WireBodySchema, vendorBody);
    const count = v.parse(WireBodySchema, countBody);
    expect(systemTextOf(count)).toBe(systemTextOf(vendor));
    expect(count.messages.map((m) => m.role)).toEqual(vendor.messages.map((m) => m.role));
    expect(count.messages.map(countedBlocks)).toEqual(vendor.messages.map(countedBlocks));
    expect((count.tools ?? []).map(toolIdentity)).toEqual((vendor.tools ?? []).map(toolIdentity));
  });
});
