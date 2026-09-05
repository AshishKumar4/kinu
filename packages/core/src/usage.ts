/**
 * Usage — the ONE normalized report of what a model request cost.
 *
 * Before this existed the same provider report was restated in nine shapes
 * (the `step_finish` event's own `StepUsage`, `turn_end.tokenUsage`, the
 * `ChatEvent` step fields, `TurnUsage`, `MissionCallUsage`/`BranchUsage`,
 * `HeadReport.tokenUsage`, the step telemetry aggregate, `RunSummary.tokens*`,
 * and the eval record's spend), and two of them hand-merged Anthropic's
 * cache-read field with the OpenAI family's because the AI SDK does not
 * normalize usage. One type, one normalizer.
 *
 * EVERY FIELD IS OPTIONAL, AND THAT IS THE POINT. An absent field means the
 * provider did not report it — never that it reported zero. The two are
 * different claims and the difference is load-bearing: a cache-read of 0 is a
 * cold prompt worth alerting on, while an unreported cache-read is a provider
 * that has nothing to say about caching, and a metric that renders the second as
 * the first invents a regression. This is the discipline the step event's `usd`
 * already had ("an absent `usd` means unpriced, never free") applied to tokens.
 *
 * WHY `raw` IS THE ORACLE. The SDK's flattened fields cannot be trusted for
 * presence, because the provider adapters fabricate zeros in mirror-image ways:
 * `@ai-sdk/openai-compatible` (dist/index.js:88-89) does
 * `usage.completion_tokens_details?.reasoning_tokens ?? 0`, so a Workers AI reply
 * that reports no reasoning breakdown at all arrives as `reasoningTokens: 0`;
 * `@ai-sdk/anthropic` (dist/index.js:1782-1783) does the same to
 * `cache_creation_input_tokens`, while leaving `reasoning` genuinely `undefined`.
 * `usage.raw` is the provider's own words (both families set it —
 * openai-compatible dist/index.js:102, anthropic dist/index.js:1820 — and both
 * parse usage with `z.looseObject`, so keys the SDK does not model survive), so
 * it is the authority on WHETHER a number was reported. The SDK's arithmetic is
 * still the authority on WHAT `input`/`output` are, because it is what folds
 * Anthropic's three-part input into one cache-inclusive total.
 *
 * Observed, not assumed — the two shapes this reconciles, captured live:
 *   Workers AI `@cf/deepseek-ai/deepseek-v4-pro-0813` through the deployed proxy
 *     raw: { prompt_tokens: 88, completion_tokens: 24, total_tokens: 112,
 *            prompt_tokens_details: { cached_tokens: 0 }, neurons: 19.19… }
 *     — reports a cache read OF ZERO, reports no reasoning breakdown even though
 *       the reply carried `reasoning_content`, and reports `neurons`.
 *   Anthropic `/v1/messages` through @ai-sdk/anthropic
 *     raw: { input_tokens: 12, output_tokens: 5,
 *            cache_creation_input_tokens: 1024, cache_read_input_tokens: 2048,
 *            cache_creation: { ephemeral_5m_input_tokens: 24,
 *                              ephemeral_1h_input_tokens: 1000 } }
 *     — reports both cache halves and the 1h retention split, and no reasoning.
 *
 * COST IS NOT HERE. `@earendil-works/pi-ai` carries a `cost` breakdown inside its
 * own `Usage` (dist/types.d.ts:255-276, which is also where `cacheRead`,
 * `cacheWrite`, the `cacheWrite1h` split and `reasoning` are modelled — this type
 * is our implementation of that idea, not that package). We deliberately do not:
 * a price is not something a provider reported, it is something we computed, and
 * it already has exactly one source of truth (`priceCall` in mission-budget.ts,
 * fed by the models.dev catalog rate) and one home (`usd` beside the usage on the
 * step event, absent when the model is unpriced). Putting it in here would make
 * the type two things and give the rate a second place to drift to. `neurons` is
 * the exception that proves the rule: it is a cost figure, but it is one the
 * PROVIDER reports, so it is a measurement like the rest.
 */

import type { LanguageModelUsage } from 'ai';
import * as v from 'valibot';

export interface Usage {
  /** Prompt tokens, cache-inclusive — `cacheRead` and `cacheWrite` are subsets
   *  of this, never additions to it (@ai-sdk/anthropic dist/index.js:1810 sums
   *  the three parts; @ai-sdk/openai-compatible dist/index.js:93 subtracts the
   *  cache read back out of the prompt total). */
  readonly input?: number;
  /** Completion tokens, `reasoning` included. */
  readonly output?: number;
  /** Prompt tokens served from the provider's cache. */
  readonly cacheRead?: number;
  /** Prompt tokens written INTO the provider's cache. Charged at a different
   *  rate from a plain input token, which is why it is carried separately. */
  readonly cacheWrite?: number;
  /** The subset of `cacheWrite` written with 1h retention rather than the
   *  default 5m. Only Anthropic reports this split, and only in `raw` — the
   *  SDK's own schema does not model it. */
  readonly cacheWrite1h?: number;
  /** Reasoning/thinking tokens — a SUBSET of `output`, already counted there. */
  readonly reasoning?: number;
  /** Cloudflare's own billing unit for a Workers AI call, as the proxy reported
   *  it. The one cost figure that is a provider measurement rather than
   *  something we priced. */
  readonly neurons?: number;
}

/** Every key of `Usage`, as the one list the schema, the adder and the tests all
 *  read — so a field added above cannot be forgotten by any of them. */
export const USAGE_FIELDS = [
  'input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'reasoning', 'neurons',
] as const satisfies ReadonlyArray<keyof Usage>;

/** The durable gate. One declaration beside the type so a stored row and an
 *  in-memory value cannot disagree about which fields may be absent. Spelled out
 *  rather than generated from `USAGE_FIELDS` so the shape is readable at a
 *  glance; `unit-usage.test.ts` asserts the two stay in step. */
export const UsageSchema = v.object({
  input: v.optional(v.number()),
  output: v.optional(v.number()),
  cacheRead: v.optional(v.number()),
  cacheWrite: v.optional(v.number()),
  cacheWrite1h: v.optional(v.number()),
  reasoning: v.optional(v.number()),
  neurons: v.optional(v.number()),
});

/** A count a provider may omit, or send as an explicit null. Both mean "not
 *  reported", which `??` then folds into the next candidate. A count of the
 *  wrong type reads as not reported too, so one mistyped key cannot sink the
 *  parse and hide the counts beside it. */
const ReportedCount = v.fallback(v.optional(v.nullable(v.number())), undefined);
/** A detail object a provider may omit, send as null, or send malformed; the
 *  last reads as absent for the reason ReportedCount does. */
const details = <const TEntries extends v.ObjectEntries>(entries: TEntries) =>
  v.fallback(v.optional(v.nullable(v.looseObject(entries))), undefined);

/**
 * The provider's own usage payload — every dialect the repo can reach, in one
 * schema.
 *
 * Three adapter families are in play and all three populate `raw`:
 * `@ai-sdk/openai-compatible` (dist/index.js:102 — Workers AI, my-gateway,
 * ai-gateway, openrouter, the models.dev catalog providers),
 * `@ai-sdk/anthropic` (dist/index.js:1820) and `@ai-sdk/openai`, which is TWO
 * dialects on its own: chat-completions (dist/index.js:106) and the Responses
 * API (dist/index.js:2724), whose detail objects are named
 * `input_tokens_details`/`output_tokens_details` rather than
 * `prompt_tokens_details`/`completion_tokens_details`. Codex rides the Responses
 * shape, so omitting it would silently drop the cache reads on that path.
 *
 * `workers-ai-provider` is an installed dependency but is NOT one of these: chat
 * inference deliberately goes through the account-scoped REST endpoint via
 * `createOpenAICompatible` (cf-backend/src/providers/workers-ai.ts:1-8), leaving
 * `env.AI` to embeddings. So it never produces a usage report to normalize.
 *
 * `v.looseObject` throughout for the same reason the SDK's own parsers use it:
 * these are other people's payloads and a key we do not model must survive
 * rather than sink the parse. The dialects agree on `input_tokens`/`output_tokens`
 * where they share it, so the provider never has to be identified first —
 * whichever half is present is the one that answers.
 */
const RawProviderUsageSchema = v.looseObject({
  // Anthropic /v1/messages, and the OpenAI Responses API, share these two.
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

/** The provider's payload once parsed — the domain value the reader below reads. */
type RawProviderUsage = v.InferOutput<typeof RawProviderUsageSchema>;

/** What the provider itself said, keyed by our own field names. */
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

/**
 * The AI SDK step report, normalized.
 *
 * One rule, applied to every field: the provider's `raw` payload decides whether
 * the number was reported, and the SDK's own value is preferred for what it is
 * (it is what folds Anthropic's three-part input into one cache-inclusive
 * total). When the SDK preserved no `raw` at all there is no better witness than
 * the SDK's field being defined, so that is what presence falls back to — which
 * is also what makes a hand-built report (a backend that counts tokens itself)
 * faithful rather than silently dropped.
 */
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

/** Whether the provider reported anything at all. The gate for writing a usage
 *  row: a turn served by a provider that says nothing carries no usage rather
 *  than a fabricated set of zeros. */
export function usageReported(usage: Usage): boolean {
  return USAGE_FIELDS.some((f) => usage[f] !== undefined);
}

/**
 * The billable token count, or undefined when neither side was reported.
 *
 * Derived rather than stored: `cacheRead`/`cacheWrite` are subsets of `input`
 * and `reasoning` is a subset of `output`, so `input + output` is the total and
 * a stored copy of it could only ever drift from its own parts.
 */
export function usageTotal(usage: Usage): number | undefined {
  if (usage.input === undefined && usage.output === undefined) return undefined;
  return (usage.input ?? 0) + (usage.output ?? 0);
}

/**
 * Accumulate, preserving absence. A field neither side reported stays absent; a
 * field only one side reported carries that one's number. This is what lets a
 * turn's total distinguish "every step reported a zero cache read" from "no step
 * mentioned caching" — summing through `?? 0` would erase exactly that.
 */
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
