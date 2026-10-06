/**
 * Server-side compaction (ADR P2, P3): past Kinu's one trigger, the API summarizes the conversation into an item that
 * opens it from then on, instead of better-compact's summary stages. Anthropic's is a `compaction` block
 * (platform.claude.com/docs/en/build-with-claude/compaction-threshold), OpenAI's an encrypted `compaction` item
 * (developers.openai.com/api/docs/guides/compaction).
 */
import type { ModelMessage, ProviderMetadata } from 'ai';
import * as v from 'valibot';
import type { JsonValue } from '../utils/json';
import type { ProviderOptions } from './effort';
import { CHARS_PER_TOKEN } from '../llm';

/** Where Kinu compacts, as a percentage of the context window: the ladder's trigger and the provider's. */
export const COMPACTION_TRIGGER_PERCENT = 85;

/** The fewest input tokens Anthropic compacts at: it refuses a lower trigger. OpenAI is held to the same floor. */
export const SERVER_COMPACTION_MIN_TOKENS = 50_000;

/** A forced compaction triggers this far under the request's own input, so a count a little high still trips it. */
const FORCED_TRIGGER = 0.9;

/** Anthropic's compatibility list: Opus and Sonnet from 4.6, Fable and Mythos from 5, and Mythos Preview. */
const COMPACTING = /^claude-(?:(opus|sonnet)-(\d+)(?:-(\d{1,2}))?(?!\d)|(fable|mythos)-(\d+)|mythos-preview)/u;

/** OpenAI's guide lists no models; GPT-5 and later, on every route that speaks api.openai.com's Responses API
 *  (`gpt-6.1-sol` compacted there on the ChatGPT plan, measured 2026-10-06). */
const OPENAI_COMPACTING = /^gpt-(?:[5-9]|\d{2,})/u;

/** The Codex backend takes no threshold: a step asks by a trailing `compaction_trigger` (ADR P3). The plan's API route
 *  refuses that item (400 `subscription_sharing_unsupported_capability`, 2026-10-06) and takes the threshold. */
const CODEX_ROUTE = /^codex(?:@[^/]*)?\//u;

/** Whose summary a model reads and writes: only that provider's adapters carry it. */
export type ServerCompactor = 'anthropic' | 'openai';

/** The provider a model compacts with, or null for a model compacted the local way. */
export function serverCompactor(spec: string | undefined): ServerCompactor | null {
  if (CODEX_ROUTE.test(spec ?? '')) return 'openai';
  const match = /^(anthropic|claude|openai|chatgpt)(?:@[^/]*)?\/(?:.*\/)?([^/]+)$/u.exec(spec ?? '');

  if (match?.[1] === 'openai' || match?.[1] === 'chatgpt') return OPENAI_COMPACTING.test(match[2] ?? '') ? 'openai' : null;
  const model = COMPACTING.exec(match?.[2] ?? '');

  if (model === null) return null;

  if (model[1] !== undefined) return Number(model[2]) + Number(model[3] ?? 0) / 10 >= 4.6 ? 'anthropic' : null;

  return model[4] === undefined || Number(model[5]) >= 5 ? 'anthropic' : null;
}

/**
 * The threshold option, or undefined. A forced compaction (`/compact`, an overflow) passes the request's input.
 * OpenAI counts a replayed compaction item at its original size (6,504 tokens for one item, measured 2026-10-06), so a
 * request carrying one stays over the threshold and recompacts every time: it asks only once `sinceLatest`, what came
 * after the latest item, crosses the threshold itself.
 */
export function serverCompactionOptions(
  spec: string | undefined, contextWindow: number | null | undefined, forcedInput?: number, sinceLatest: number | null = null,
): ProviderOptions | undefined {
  const threshold = triggerTokens(contextWindow);
  const vendor = serverCompactor(spec);

  if (vendor === null || CODEX_ROUTE.test(spec ?? '') || threshold < SERVER_COMPACTION_MIN_TOKENS) return undefined;

  if (vendor === 'openai' && forcedInput === undefined && sinceLatest !== null && sinceLatest < threshold) return undefined;

  const value = forcedInput === undefined
    ? threshold
    : Math.max(SERVER_COMPACTION_MIN_TOKENS, Math.min(threshold, Math.floor(forcedInput * FORCED_TRIGGER)));

  return vendor === 'openai'
    ? { openai: { contextManagement: [{ type: 'compaction', compactThreshold: value }] } }
    : { anthropic: { contextManagement: { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value } }] } } };
}

export function compactionTriggerOptions(
  spec: string | undefined, contextWindow: number | null | undefined, inputTokens: number | undefined, forced: boolean,
): ProviderOptions | undefined {
  const threshold = triggerTokens(contextWindow);

  if (!CODEX_ROUTE.test(spec ?? '') || inputTokens === undefined || threshold < SERVER_COMPACTION_MIN_TOKENS) return undefined;

  return inputTokens >= (forced ? SERVER_COMPACTION_MIN_TOKENS : threshold) ? { openai: { compactionTrigger: true } } : undefined;
}

function triggerTokens(contextWindow: number | null | undefined): number {
  return Math.floor(((contextWindow ?? 0) * COMPACTION_TRIGGER_PERCENT) / 100);
}

const CompactionMark = v.looseObject({ type: v.literal('compaction') });

/** A part, chunk or stored part carrying a provider's summary (`by` that one only), by the mark its SDK adapter gives
 *  it: Anthropic's on a text part, OpenAI's on a `custom` one. */
/** Estimated tokens after the latest OpenAI compaction item, or null when none is replayed. */
export function sinceLatestCompaction(messages: readonly ModelMessage[]): number | null {
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at];

    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;

    const parts = message.content;
    const latest = parts.map((part) => part.type === 'custom' && isServerCompaction(part.providerOptions, 'openai')).lastIndexOf(true);

    if (latest >= 0) return Math.ceil(JSON.stringify([...parts.slice(latest + 1), ...messages.slice(at + 1)]).length / CHARS_PER_TOKEN);
  }

  return null;
}

export function isServerCompaction(metadata: ProviderMetadata | JsonValue | undefined, by?: ServerCompactor): boolean {
  return (['anthropic', 'openai'] as const).some((vendor) => (by ?? vendor) === vendor && v.is(v.object({ [vendor]: CompactionMark }), metadata));
}
