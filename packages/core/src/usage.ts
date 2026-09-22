/**
 * The one normalized report of what a model request cost. Every field is optional: absent means the provider
 * did not report it, never zero. Prices live in `priceCall`, not here; `neurons` is provider-reported.
 */

import type { LanguageModelUsage } from 'ai';
import * as v from 'valibot';

export interface Usage {
  /** Prompt tokens, cache-inclusive: `cacheRead` and `cacheWrite` are subsets of this. */
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  /** Charged at a different rate from a plain input token. */
  readonly cacheWrite?: number;
  /** The subset of `cacheWrite` with 1h retention; only Anthropic reports it, and only in `raw`. */
  readonly cacheWrite1h?: number;
  /** A subset of `output`, already counted there. */
  readonly reasoning?: number;
  /** Cloudflare's billing unit for a Workers AI call, as the proxy reported it. */
  readonly neurons?: number;
}

export const USAGE_FIELDS = [
  'input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'reasoning', 'neurons',
] as const satisfies ReadonlyArray<keyof Usage>;

/** Spelled out rather than generated from `USAGE_FIELDS`; `unit-usage.test.ts` asserts the two stay in step. */
export const UsageSchema = v.object({
  input: v.optional(v.number()),
  output: v.optional(v.number()),
  cacheRead: v.optional(v.number()),
  cacheWrite: v.optional(v.number()),
  cacheWrite1h: v.optional(v.number()),
  reasoning: v.optional(v.number()),
  neurons: v.optional(v.number()),
});

/** Omitted, null, or mistyped all read as "not reported", so one bad key cannot sink the parse. */
const ReportedCount = v.fallback(v.optional(v.nullable(v.number())), undefined);

const details = <const TEntries extends v.ObjectEntries>(entries: TEntries) =>
  v.fallback(v.optional(v.nullable(v.looseObject(entries))), undefined);

/**
 * Provider usage payload across every reachable dialect (openai-compatible, anthropic, OpenAI chat and Responses).
 * `looseObject` so unmodelled keys survive; `raw` is the authority on whether a number was reported, because the
 * SDK adapters fabricate zeros.
 */
const RawProviderUsageSchema = v.looseObject({
  // Anthropic /v1/messages and the OpenAI Responses API.
  input_tokens: ReportedCount,
  output_tokens: ReportedCount,
  // Anthropic only.
  cache_read_input_tokens: ReportedCount,
  cache_creation_input_tokens: ReportedCount,
  cache_creation: details({
    ephemeral_1h_input_tokens: ReportedCount,
  }),
  // OpenAI Responses API.
  input_tokens_details: details({
    cached_tokens: ReportedCount,
  }),
  output_tokens_details: details({
    reasoning_tokens: ReportedCount,
  }),
  // OpenAI-compatible and OpenAI chat-completions.
  prompt_tokens: ReportedCount,
  completion_tokens: ReportedCount,
  prompt_tokens_details: details({
    cached_tokens: ReportedCount,
    cache_write_tokens: ReportedCount,
  }),
  completion_tokens_details: details({
    reasoning_tokens: ReportedCount,
  }),
  // Cloudflare Workers AI adds its billing unit to the OpenAI-compatible shape.
  neurons: ReportedCount,
});

type RawProviderUsage = v.InferOutput<typeof RawProviderUsageSchema>;

function reportedByProvider(r: RawProviderUsage): Usage {
  return {
    input: r.input_tokens ?? r.prompt_tokens ?? undefined,
    output: r.output_tokens ?? r.completion_tokens ?? undefined,
    cacheRead: r.cache_read_input_tokens
      ?? r.prompt_tokens_details?.cached_tokens
      ?? r.input_tokens_details?.cached_tokens
      ?? undefined,
    cacheWrite: r.cache_creation_input_tokens
      ?? r.prompt_tokens_details?.cache_write_tokens
      ?? undefined,
    cacheWrite1h: r.cache_creation?.ephemeral_1h_input_tokens ?? undefined,
    reasoning: r.completion_tokens_details?.reasoning_tokens
      ?? r.output_tokens_details?.reasoning_tokens
      ?? undefined,
    neurons: r.neurons ?? undefined,
  };
}

/** `raw` decides whether each field was reported; the SDK value is preferred for what it is. Without `raw`, the SDK
 *  field's presence decides. */
export function normalizeUsage(usage: LanguageModelUsage | undefined): Usage {
  if (usage === undefined) return {};
  const provider = v.safeParse(RawProviderUsageSchema, usage.raw);
  const fromProvider = provider.success ? reportedByProvider(provider.output) : undefined;

  const sdk: Usage = {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.inputTokenDetails?.cacheReadTokens,
    cacheWrite: usage.inputTokenDetails?.cacheWriteTokens,
    reasoning: usage.outputTokenDetails?.reasoningTokens,
  };

  const out: { -readonly [K in keyof Usage]: number } = {};

  for (const field of USAGE_FIELDS) {
    const witness = fromProvider ?? sdk;

    if (witness[field] === undefined) continue;
    const value = sdk[field] ?? fromProvider?.[field];

    if (value !== undefined) out[field] = value;
  }

  return out;
}

/** Gate for writing a usage row: a silent provider carries no usage rather than fabricated zeros. */
export function usageReported(usage: Usage): boolean {
  return USAGE_FIELDS.some((f) => usage[f] !== undefined);
}

/** Derived, not stored: cache fields are subsets of `input` and `reasoning` of `output`. */
export function usageTotal(usage: Usage): number | undefined {
  if (usage.input === undefined && usage.output === undefined) return undefined;

  return (usage.input ?? 0) + (usage.output ?? 0);
}

/** Accumulate, preserving absence: summing through `?? 0` would erase "reported zero" vs "not reported". */
export function addUsage(a: Usage, b: Usage): Usage {
  const out: { -readonly [K in keyof Usage]: number } = {};

  for (const field of USAGE_FIELDS) {
    const left = a[field];
    const right = b[field];

    if (left === undefined && right === undefined) continue;
    out[field] = (left ?? 0) + (right ?? 0);
  }

  return out;
}
