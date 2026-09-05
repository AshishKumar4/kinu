import { describe, expect, test } from 'bun:test';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { FetchFunction } from '@ai-sdk/provider-utils';
import { generateText } from 'ai';
import * as v from 'valibot';
import {
  USAGE_FIELDS, UsageSchema, addUsage, normalizeUsage, usageReported, usageTotal, type Usage,
} from '../src/usage';

/**
 * The provider shapes are driven through the REAL SDK provider adapters rather
 * than hand-typed into `normalizeUsage`, because the defect being guarded lives
 * in those adapters: they fabricate `0` for fields the provider never mentioned.
 * A test that fed `normalizeUsage` a tidy object would assert nothing about the
 * thing that actually goes wrong.
 *
 * The Workers AI usage below is a verbatim capture off the deployed proxy
 * (`POST /api/user/ai/v1/chat/completions`, `@cf/deepseek-ai/deepseek-v4-pro-0813`).
 */

/** Workers AI / my-gateway / ai-gateway / openrouter, and OpenAI chat-completions. */
interface OpenAICompatUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
  readonly prompt_tokens_details?: { readonly cached_tokens?: number };
  readonly completion_tokens_details?: { readonly reasoning_tokens?: number };
  /** Cloudflare's billing unit — the one provider-reported cost figure. */
  readonly neurons?: number;
}

interface AnthropicUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_creation?: {
    readonly ephemeral_5m_input_tokens?: number;
    readonly ephemeral_1h_input_tokens?: number;
  };
}

/** The OpenAI Responses API — the shape Codex rides. */
interface OpenAIResponsesUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
  readonly input_tokens_details?: { readonly cached_tokens?: number };
  readonly output_tokens_details?: { readonly reasoning_tokens?: number };
}

/** Verbatim from the deployed proxy. Note `reasoning_content` WITH no
 *  `completion_tokens_details` — the model reasoned and reported no reasoning
 *  token count — and `cached_tokens: 0`, a real reported zero. */
const WORKERS_AI_USAGE: OpenAICompatUsage = {
  prompt_tokens: 88,
  completion_tokens: 24,
  total_tokens: 112,
  prompt_tokens_details: { cached_tokens: 0 },
  neurons: 19.199999809265137,
};

const ANTHROPIC_USAGE: AnthropicUsage = {
  input_tokens: 12,
  output_tokens: 5,
  cache_creation_input_tokens: 1024,
  cache_read_input_tokens: 2048,
  cache_creation: { ephemeral_5m_input_tokens: 24, ephemeral_1h_input_tokens: 1000 },
};

function jsonReply(serialized: string): FetchFunction {
  const stub = async (): Promise<Response> => new Response(serialized, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  // `FetchFunction` is the platform `typeof fetch`, which carries `preconnect`.
  // The SDK never calls it; the type requires it to exist.
  return Object.assign(stub, { preconnect: async (): Promise<void> => {} });
}

async function usageFromOpenAICompat(usage: OpenAICompatUsage): Promise<Usage> {
  const provider = createOpenAICompatible({
    name: 'workers-ai',
    baseURL: 'https://example.invalid/v1',
    fetch: jsonReply(JSON.stringify({
      id: 'id-1786985048670',
      object: 'chat.completion',
      created: 1786985048,
      model: '@cf/deepseek-ai/deepseek-v4-pro-0813',
      choices: [{
        finish_reason: 'stop',
        index: 0,
        message: { content: 'ok', reasoning_content: 'We need answer exactly "ok".', role: 'assistant' },
      }],
      usage,
    })),
  });
  const r = await generateText({ model: provider('@cf/deepseek-ai/deepseek-v4-pro-0813'), prompt: 'hi' });
  return normalizeUsage(r.usage);
}

async function usageFromAnthropic(usage: AnthropicUsage): Promise<Usage> {
  const provider = createAnthropic({
    apiKey: 'test',
    fetch: jsonReply(JSON.stringify({
      id: 'msg_01probe',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage,
    })),
  });
  const r = await generateText({ model: provider('claude-sonnet-4-5'), prompt: 'hi' });
  return normalizeUsage(r.usage);
}

async function usageFromOpenAIResponses(usage: OpenAIResponsesUsage): Promise<Usage> {
  const provider = createOpenAI({
    apiKey: 'test',
    fetch: jsonReply(JSON.stringify({
      id: 'resp_01probe',
      object: 'response',
      created_at: 1786985048,
      status: 'completed',
      model: 'gpt-5-codex',
      output: [{
        type: 'message', id: 'msg_1', status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text: 'ok', annotations: [] }],
      }],
      usage,
    })),
  });
  const r = await generateText({ model: provider.responses('gpt-5-codex'), prompt: 'hi' });
  return normalizeUsage(r.usage);
}

describe('normalizeUsage over the OpenAI-compatible family (Workers AI)', () => {
  test('carries the tokens the provider reported', async () => {
    const u = await usageFromOpenAICompat(WORKERS_AI_USAGE);
    expect(u.input).toBe(88);
    expect(u.output).toBe(24);
  });

  test('a reported cache read of zero stays zero, not absent', async () => {
    const u = await usageFromOpenAICompat(WORKERS_AI_USAGE);
    expect(u.cacheRead).toBe(0);
    expect('cacheRead' in u).toBe(true);
  });

  test('an unreported reasoning count is ABSENT, not the zero the SDK fabricates', async () => {
    const provider = createOpenAICompatible({
      name: 'workers-ai',
      baseURL: 'https://example.invalid/v1',
      fetch: jsonReply(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 1, model: 'm',
        choices: [{ finish_reason: 'stop', index: 0, message: { content: 'ok', role: 'assistant' } }],
        usage: WORKERS_AI_USAGE,
      })),
    });
    const r = await generateText({ model: provider('m'), prompt: 'hi' });
    // The defect, demonstrated: the SDK hands over a 0 the provider never sent.
    expect(r.usage.outputTokenDetails?.reasoningTokens).toBe(0);
    expect(r.usage.raw).not.toHaveProperty('completion_tokens_details');
    // The normalized view refuses to repeat it.
    const u = normalizeUsage(r.usage);
    expect(u.reasoning).toBeUndefined();
    expect('reasoning' in u).toBe(false);
  });

  test('cache writes this family never reports are absent', async () => {
    const u = await usageFromOpenAICompat(WORKERS_AI_USAGE);
    expect('cacheWrite' in u).toBe(false);
    expect('cacheWrite1h' in u).toBe(false);
  });

  test('carries the provider-reported neuron figure', async () => {
    const u = await usageFromOpenAICompat(WORKERS_AI_USAGE);
    expect(u.neurons).toBeCloseTo(19.1999998, 5);
  });

  test('a reported reasoning breakdown IS carried', async () => {
    const u = await usageFromOpenAICompat({
      ...WORKERS_AI_USAGE,
      completion_tokens_details: { reasoning_tokens: 7 },
    });
    expect(u.reasoning).toBe(7);
  });

  test('a reasoning breakdown reported AS zero is carried as zero', async () => {
    const u = await usageFromOpenAICompat({
      ...WORKERS_AI_USAGE,
      completion_tokens_details: { reasoning_tokens: 0 },
    });
    expect(u.reasoning).toBe(0);
    expect('reasoning' in u).toBe(true);
  });

  test('a provider that omits cache details reports no cache read at all', async () => {
    const u = await usageFromOpenAICompat({ prompt_tokens: 88, completion_tokens: 24, total_tokens: 112 });
    expect('cacheRead' in u).toBe(false);
    expect(u.input).toBe(88);
  });

  test('no neuron figure from a provider that does not bill in them', async () => {
    const u = await usageFromOpenAICompat({ prompt_tokens: 5, completion_tokens: 1 });
    expect('neurons' in u).toBe(false);
  });
});

describe('normalizeUsage over Anthropic', () => {
  test('input is the cache-inclusive total the SDK folds', async () => {
    const u = await usageFromAnthropic(ANTHROPIC_USAGE);
    // 12 fresh + 1024 written + 2048 read.
    expect(u.input).toBe(3084);
    expect(u.output).toBe(5);
  });

  test('both cache halves are carried', async () => {
    const u = await usageFromAnthropic(ANTHROPIC_USAGE);
    expect(u.cacheRead).toBe(2048);
    expect(u.cacheWrite).toBe(1024);
  });

  test('the 1h retention split the SDK does not model is recovered from raw', async () => {
    const u = await usageFromAnthropic(ANTHROPIC_USAGE);
    expect(u.cacheWrite1h).toBe(1000);
  });

  test('an unreported reasoning count is absent', async () => {
    const u = await usageFromAnthropic(ANTHROPIC_USAGE);
    expect('reasoning' in u).toBe(false);
  });

  test('no neuron figure outside Workers AI', async () => {
    const u = await usageFromAnthropic(ANTHROPIC_USAGE);
    expect('neurons' in u).toBe(false);
  });

  test('an unreported cache write is ABSENT, not the zero the SDK fabricates', async () => {
    const provider = createAnthropic({
      apiKey: 'test',
      fetch: jsonReply(JSON.stringify({
        id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 5 },
      })),
    });
    const r = await generateText({ model: provider('claude-sonnet-4-5'), prompt: 'hi' });
    // The mirror-image defect: this family fabricates the cache zeros.
    expect(r.usage.inputTokenDetails?.cacheWriteTokens).toBe(0);
    const u = normalizeUsage(r.usage);
    expect('cacheWrite' in u).toBe(false);
    expect('cacheRead' in u).toBe(false);
    expect('cacheWrite1h' in u).toBe(false);
    expect(u.input).toBe(12);
  });

  test('a cache write with no retention breakdown leaves only the 1h split absent', async () => {
    const u = await usageFromAnthropic({
      input_tokens: 12, output_tokens: 5, cache_creation_input_tokens: 1024,
    });
    expect(u.cacheWrite).toBe(1024);
    expect('cacheWrite1h' in u).toBe(false);
  });

  test('a 1h split reported as zero is carried as zero', async () => {
    const u = await usageFromAnthropic({
      ...ANTHROPIC_USAGE,
      cache_creation: { ephemeral_5m_input_tokens: 1024, ephemeral_1h_input_tokens: 0 },
    });
    expect(u.cacheWrite1h).toBe(0);
    expect('cacheWrite1h' in u).toBe(true);
  });
});

describe('normalizeUsage over the OpenAI Responses API (the Codex path)', () => {
  test('reads the Responses-dialect detail objects', async () => {
    const u = await usageFromOpenAIResponses({
      input_tokens: 500,
      output_tokens: 40,
      total_tokens: 540,
      input_tokens_details: { cached_tokens: 384 },
      output_tokens_details: { reasoning_tokens: 32 },
    });
    expect(u.input).toBe(500);
    expect(u.output).toBe(40);
    expect(u.cacheRead).toBe(384);
    expect(u.reasoning).toBe(32);
  });

  test('an omitted Responses detail object stays absent', async () => {
    const u = await usageFromOpenAIResponses({ input_tokens: 500, output_tokens: 40 });
    expect('cacheRead' in u).toBe(false);
    expect('reasoning' in u).toBe(false);
    expect('cacheWrite' in u).toBe(false);
  });
});

describe('normalizeUsage without a provider report', () => {
  test('no usage object at all normalizes to nothing reported', () => {
    expect(normalizeUsage(undefined)).toEqual({});
    expect(usageReported({})).toBe(false);
  });

  test('a hand-built report with no raw is taken at its word', () => {
    // A backend that counts tokens itself has no provider payload to appeal to;
    // its defined fields are the only witness there is.
    const u = normalizeUsage({
      inputTokens: 10,
      outputTokens: 4,
      inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      totalTokens: 14,
    });
    expect(u).toEqual({ input: 10, output: 4 });
  });

  test('an all-undefined report reports nothing', () => {
    const u = normalizeUsage({
      inputTokens: undefined,
      outputTokens: undefined,
      inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      totalTokens: undefined,
    });
    expect(usageReported(u)).toBe(false);
  });
});

describe('normalizeUsage with one mistyped provider field', () => {
  test('a string neurons leaves the other fields on the provider witness', () => {
    const u = normalizeUsage({
      inputTokens: 88,
      outputTokens: 24,
      inputTokenDetails: { noCacheTokens: 88, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 24, reasoningTokens: 0 },
      totalTokens: 112,
      raw: {
        prompt_tokens: 88,
        completion_tokens: 24,
        total_tokens: 112,
        prompt_tokens_details: { cached_tokens: 0 },
        neurons: '19.2',
      },
    });
    expect(u.input).toBe(88);
    expect(u.output).toBe(24);
    expect(u.cacheRead).toBe(0);
    expect('reasoning' in u).toBe(false);
    expect('cacheWrite' in u).toBe(false);
    expect('neurons' in u).toBe(false);
  });
});

describe('usageReported', () => {
  test('a single reported zero counts as a report', () => {
    expect(usageReported({ cacheRead: 0 })).toBe(true);
    expect(usageReported({ output: 0 })).toBe(true);
  });
});

describe('usageTotal', () => {
  test('undefined when neither side was reported', () => {
    expect(usageTotal({})).toBeUndefined();
    expect(usageTotal({ cacheRead: 0, neurons: 3 })).toBeUndefined();
  });

  test('sums the two reported sides without double-counting subsets', () => {
    expect(usageTotal({ input: 3084, output: 5, cacheRead: 2048, cacheWrite: 1024, reasoning: 2 })).toBe(3089);
  });

  test('a half report totals that half', () => {
    expect(usageTotal({ output: 5 })).toBe(5);
  });

  test('a reported zero totals zero, which is not absence', () => {
    expect(usageTotal({ input: 0, output: 0 })).toBe(0);
  });
});

describe('addUsage preserves absence', () => {
  test('a field neither side reported stays absent', () => {
    const sum = addUsage({ input: 10 }, { input: 5 });
    expect(sum).toEqual({ input: 15 });
    expect('reasoning' in sum).toBe(false);
    expect('cacheWrite1h' in sum).toBe(false);
  });

  test('a field only one side reported carries that side', () => {
    expect(addUsage({ input: 10 }, { input: 5, cacheRead: 2 })).toEqual({ input: 15, cacheRead: 2 });
  });

  test('a reported zero survives accumulation as a report', () => {
    const sum = addUsage({ cacheRead: 0 }, { cacheRead: 0 });
    expect(sum.cacheRead).toBe(0);
    expect(usageReported(sum)).toBe(true);
  });

  test('accumulating nothing onto nothing reports nothing', () => {
    expect(usageReported(addUsage({}, {}))).toBe(false);
  });

  test('mixing the two provider shapes keeps each provider\'s silence', async () => {
    const wai = await usageFromOpenAICompat(WORKERS_AI_USAGE);
    const ant = await usageFromAnthropic(ANTHROPIC_USAGE);
    const sum = addUsage(wai, ant);
    expect(sum.input).toBe(88 + 3084);
    expect(sum.cacheRead).toBe(0 + 2048);
    // Only Anthropic reported these; the sum says so rather than halving them.
    expect(sum.cacheWrite).toBe(1024);
    expect(sum.cacheWrite1h).toBe(1000);
    // Only Workers AI reported this.
    expect(sum.neurons).toBeCloseTo(19.1999998, 5);
    // NEITHER reported reasoning, so the total must not claim zero.
    expect('reasoning' in sum).toBe(false);
  });
});

describe('UsageSchema is the durable gate', () => {
  test('governs exactly the fields the type declares', () => {
    expect(Object.keys(UsageSchema.entries).sort()).toEqual([...USAGE_FIELDS].sort());
  });

  test('every field may be absent, and absence round-trips', () => {
    const parsed = v.parse(UsageSchema, JSON.parse(JSON.stringify({ input: 88, cacheRead: 0 })));
    expect(parsed).toEqual({ input: 88, cacheRead: 0 });
    expect('reasoning' in parsed).toBe(false);
  });

  test('an empty report is valid', () => {
    expect(v.parse(UsageSchema, {})).toEqual({});
  });

  test('a non-number is refused', () => {
    expect(v.safeParse(UsageSchema, { input: 'lots' }).success).toBe(false);
  });
});
