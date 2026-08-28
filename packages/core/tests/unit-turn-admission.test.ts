// KINU-048. Turn admission used to run on catalog metadata: the resolved
// model's `contextWindow` is a fact about the MODEL, and the context meter's
// chars/4 scale says of itself that it is an estimate, so an oversized request
// passed locally and was refused remotely — and the one forced-compaction
// recovery then ran without ever proving the compacted request fits.
//
// These tests drive the shared assembly (`assembleTurnMessages`, the ONE
// ordering both backends run) with a provider counter, and pin the whole
// decision: count the assembled request, compact once, count again, and refuse
// before submission rather than hand back a request that cannot be sent. The
// Anthropic counter is exercised through its own endpoint, because it is the
// one active provider that publishes a pre-request count.
import { describe, expect, test } from 'bun:test';
import { tool, type ModelMessage } from 'ai';
import * as v from 'valibot';
import { z } from 'zod';
import { assembleTurnMessages } from '../src/orchestrator/turn-context';
import { runChat } from '../src/chat';
import { ExtensionHost } from '../src/extension';
import { classifyTurnFailure } from '../src/turn-failure';
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

const HISTORY: ModelMessage[] = [
  { role: 'user', content: 'the long conversation' },
  { role: 'assistant', content: 'the long answer' },
];

const COMPACTED: ModelMessage[] = [{ role: 'user', content: 'summary of the long conversation' }];

/** A window whose input allocation is a round number: a 200k window with a 40k
 *  answer reserve, so `stepContextLimit` is 160k. Read from that function rather
 *  than restated, so this suite budgets against the one allocation every
 *  producer divides instead of a second copy of the arithmetic. */
const LIMITS = { contextWindow: 200_000, modelOutputLimit: 40_000 };
const LIMIT = stepContextLimit(LIMITS);

function base() {
  return { system: 'SYS', history: HISTORY, sessionKey: 'k', contextWindow: LIMITS.contextWindow };
}

/** The count body as this suite reads it back off the wire. */
const SentCountBodySchema = v.looseObject({
  system: v.string(),
  messages: v.array(v.looseObject({
    role: v.string(),
    content: v.array(v.looseObject({ type: v.string() })),
  })),
  tools: v.array(v.looseObject({ name: v.string(), input_schema: v.looseObject({}) })),
});

/** One Anthropic request body, read only for the fields a token count depends
 *  on. Loose on purpose: the vendor's body carries sampling fields and cache
 *  markers the count endpoint does not take, and comparing those would fail on
 *  differences that cost no tokens. */
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

/** The system channel's text, whichever shape the body carries it in. */
function systemTextOf(body: WireBody): string {
  const system = body.system;
  if (system === undefined) return '';
  if (Array.isArray(system)) return system.map((block) => block.text ?? '').join('');
  return system;
}

/** One message reduced to what it costs: its block types, and their text. */
function countedBlocks(message: WireBody['messages'][number]): Array<{ type: string; text: string }> {
  const content = message.content;
  if (!Array.isArray(content)) return [{ type: 'text', text: content }];
  return content.map((block) => ({ type: block.type, text: block.text ?? '' }));
}

/** One tool definition's priced identity: what the provider tokenizes of it. */
function toolIdentity(entry: NonNullable<WireBody['tools']>[number]): string {
  return JSON.stringify([entry.name, entry.description ?? '', entry.input_schema ?? {}]);
}

/** A compaction extension that records every trigger it was run with — the
 *  evidence for "compacted exactly once". */
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

/** A counter that answers from a script, one entry per call. */
function scriptedCounter(counts: readonly number[]) {
  const seen: CountableRequest[] = [];
  let call = 0;
  // Typed at its own definition rather than through an annotation on the
  // factory: the seam's contract belongs to the function that implements it.
  const count = async (request: CountableRequest): Promise<InputTokenCount> => {
    seen.push(request);
    const tokens = counts[Math.min(call, counts.length - 1)] ?? 0;
    call += 1;
    return { kind: 'counted', tokens };
  };
  return { seen, count };
}

/**
 * The error an assembly refused with, or null when it admitted the request.
 *
 * A caught binding rather than a rejection callback: the refusal IS the
 * observation these tests are about, so it must arrive as a value the
 * assertions can read rather than as an untyped handler parameter.
 */
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
    // The COMPACTED request is what leaves the assembly, and it was counted.
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
    // One compaction, two counts: the second count is what proved the refusal.
    expect(triggers).toEqual(['auto', 'force']);
    expect(counter.seen.length).toBe(2);
  });

  test('the refusal does not read as a context-length provider failure', async () => {
    // A local refusal must NOT arm the shared recovery: that policy answers a
    // REMOTE context-length failure by force-compacting and enqueuing one retry
    // turn, and this request was already compacted and re-counted. A retry would
    // be a second forced compaction of history that just proved it cannot shrink
    // enough. The wording is pinned here so it cannot drift into the pattern
    // list that would re-arm it.
    const { extensions } = compactionProbe();
    const counter = scriptedCounter([LIMIT + 1, LIMIT + 1]);
    const failure = await refusalOf(assembleTurnMessages({
      ...base(), extensions, trigger: 'auto',
      admission: { count: counter.count, limits: LIMITS },
    }));
    // Asserted before the classification, so an assembly that refused NOTHING
    // cannot pass this by classifying the empty string.
    expect(failure).toBeInstanceOf(Error);
    const message = failure?.message ?? '';
    expect(classifyTurnFailure(message)).toBe('transient');
    // Negative control for the oracle above: the classifier DOES name a real
    // remote refusal, so the assertion is about this wording and not about a
    // classifier that never fires.
    expect(classifyTurnFailure('prompt is too long: 300000 tokens > 200000 maximum'))
      .toBe('context_length');
  });

  test('a turn that arrived already force-compacted is refused without compacting again', async () => {
    const { extensions, triggers } = compactionProbe();
    const counter = scriptedCounter([LIMIT + 1]);
    const failure = await refusalOf(assembleTurnMessages({
      ...base(),
      extensions,
      // The caller consumed an armed force flag to get here: the one forced
      // compaction this turn is entitled to has already been spent.
      trigger: 'force',
      admission: { count: counter.count, limits: LIMITS },
    }));

    expect(failure).toBeInstanceOf(Error);
    expect(triggers).toEqual(['force']);
    expect(counter.seen.length).toBe(1);
  });

  test('a provider with no count endpoint is assembled ungated, never on an estimate', async () => {
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
    // No gate, and no compaction on the strength of a number nobody measured.
    expect(triggers).toEqual(['auto']);
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
    // The tail is part of the request, so it is part of what was counted.
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
    // The matrix, as runtime behavior rather than a comment: only Anthropic
    // publishes a documented pre-request count, so every other active provider
    // reports the absence and nothing invents a number for it.
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
        body = JSON.parse(String(init?.body ?? '{}'));
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
    // Parsed rather than asserted: this is raw JSON off the wire, and a cast
    // would let a body that lost its tools or its roles satisfy the reads below.
    const sent = v.parse(SentCountBodySchema, body);
    expect(sent.system).toBe('SYS');
    expect(sent.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    // The vendor's request drops an unsigned reasoning part, so the count body
    // drops it too: counting text the request will not send would over-report.
    expect(sent.messages[1]?.content.map((c) => c.type)).toEqual(['text', 'tool_use']);
    // Anthropic carries tool results on a USER message.
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
      // No media type, so the count body cannot say what this image costs.
      messages: [{ role: 'user', content: [{ type: 'image', image: 'AAAA' }] }],
    });
    expect(answer.kind).toBe('unsupported');
    expect(answer.kind === 'unsupported' && answer.reason).toContain('image part');
  });

  test('an endpoint that refuses the count does not fail the turn', async () => {
    const deps: ProviderDeps = {
      ...NO_DEPS,
      // A refusal the shared transport does NOT retry, so this asserts the
      // preflight's own behavior rather than the rate-limit ladder's: a count
      // call rides `createAuthedFetch`, so a 429/529 waits and retries exactly
      // as the model request would.
      fetch: asFetchFunction(async () => new Response('{"error":{"message":"bad body"}}', { status: 400 })),
    };
    const answer = await countRequestInputTokens(createAnthropicProvider(), 'claude-opus-4-7', deps, {
      system: 'SYS', messages: [{ role: 'user', content: 'ask' }],
    });
    // Reported as uncounted — the request is exactly as submittable as it was
    // before anyone asked, so admission proceeds ungated rather than the turn
    // failing on its own preflight.
    expect(answer.kind).toBe('unsupported');
    expect(answer.kind === 'unsupported' && answer.reason).toContain('400');
  });

  /**
   * THE DRIFT TRIPWIRE. `@ai-sdk/anthropic` does not export its message
   * converter, so `anthropic-count.ts` owns a second conversion of the same
   * ModelMessages — and a count taken over a body that differs from the body
   * actually submitted is not an exact count, it is a coincidence. This drives
   * BOTH conversions over one input and compares the fields the count depends
   * on: the system text, the message roles, the block types and their text, and
   * the tool names with their schemas. Vendor-only request fields (max_tokens,
   * stream, cache_control) are deliberately not compared — they carry no
   * content and the count endpoint does not take them.
   */
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

    // What the vendor's own adapter submits for this turn. The 400 is the
    // point: the request is the observation.
    let vendorBody: unknown;
    const vendorDeps: ProviderDeps = {
      ...NO_DEPS,
      fetch: asFetchFunction(async (_input, init) => {
        vendorBody = JSON.parse(String(init?.body ?? '{}'));
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
    // Accounted, not swallowed: the turn MUST have reached the wire, or the
    // comparison below would be against an empty capture.
    expect(refused).toBeInstanceOf(Error);
    // The DISCRIMINATOR: a turn that threw for any other reason (a missing
    // import, a refused model construction) would satisfy the assertion above
    // while capturing nothing, and the comparison would then be against an
    // empty body. The capture itself is what proves the vendor converted.
    expect(vendorBody).toBeDefined();

    // What the counter sends for the same input.
    let countBody: unknown;
    const countDeps: ProviderDeps = {
      ...NO_DEPS,
      fetch: asFetchFunction(async (_input, init) => {
        countBody = JSON.parse(String(init?.body ?? '{}'));
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
