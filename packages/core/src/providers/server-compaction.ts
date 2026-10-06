/**
 * Server-side compaction: past the trigger, the API summarizes the conversation into an item that opens it from then
 * on. Anthropic's is a `compaction` block (platform.claude.com/docs/en/build-with-claude/compaction-threshold), OpenAI's
 * an encrypted `compaction` item (developers.openai.com/api/docs/guides/compaction). A model that supports it compacts
 * there instead of in better-compact's summary stages, at Kinu's one compaction trigger.
 */
import type { ProviderMetadata } from 'ai';
import * as v from 'valibot';
import type { JsonValue } from '../utils/json';
import type { ProviderOptions } from './effort';

/** Where Kinu compacts, as a percentage of the context window: the ladder's trigger and the provider's. */
export const COMPACTION_TRIGGER_PERCENT = 85;

/** The fewest input tokens Anthropic compacts at: it refuses a lower trigger. OpenAI is held to the same floor. */
export const SERVER_COMPACTION_MIN_TOKENS = 50_000;

/** A forced compaction triggers this far under the request's own input, so a count a little high still trips it. */
const FORCED_TRIGGER = 0.9;

/** Anthropic's compatibility list: Opus and Sonnet from 4.6, Fable and Mythos from 5, and Mythos Preview. */
const COMPACTING = /^claude-(?:(opus|sonnet)-(\d+)(?:-(\d{1,2}))?(?!\d)|(fable|mythos)-(\d+)|mythos-preview)/u;

/** OpenAI's guide lists no models; Kinu asks the GPT-5 family on the direct Responses API route. */
const OPENAI_COMPACTING = /^gpt-5/u;

/** Whose summary a model reads and writes: only that provider's adapters carry it. */
export type ServerCompactor = 'anthropic' | 'openai';

/** The provider a model compacts with, or null for a model compacted the local way. */
export function serverCompactor(spec: string | undefined): ServerCompactor | null {
  const match = /^(anthropic|claude|openai)(?:@[^/]*)?\/(?:.*\/)?([^/]+)$/u.exec(spec ?? '');

  if (match?.[1] === 'openai') return OPENAI_COMPACTING.test(match[2] ?? '') ? 'openai' : null;
  const model = COMPACTING.exec(match?.[2] ?? '');

  if (model === null) return null;

  if (model[1] !== undefined) return Number(model[2]) + Number(model[3] ?? 0) / 10 >= 4.6 ? 'anthropic' : null;

  return model[4] === undefined || Number(model[5]) >= 5 ? 'anthropic' : null;
}

/**
 * The request option asking for it, or undefined where the model does not compact server-side. A forced compaction
 * (`/compact`, an overflow's recovery) passes the request's own input, so this request compacts.
 */
export function serverCompactionOptions(
  spec: string | undefined, contextWindow: number | null | undefined, forcedInput?: number,
): ProviderOptions | undefined {
  const threshold = Math.floor(((contextWindow ?? 0) * COMPACTION_TRIGGER_PERCENT) / 100);
  const vendor = serverCompactor(spec);

  if (vendor === null || threshold < SERVER_COMPACTION_MIN_TOKENS) return undefined;

  const value = forcedInput === undefined
    ? threshold
    : Math.max(SERVER_COMPACTION_MIN_TOKENS, Math.min(threshold, Math.floor(forcedInput * FORCED_TRIGGER)));

  return vendor === 'openai'
    ? { openai: { contextManagement: [{ type: 'compaction', compactThreshold: value }] } }
    : { anthropic: { contextManagement: { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value } }] } } };
}

const CompactionMark = v.looseObject({ type: v.literal('compaction') });

/** A part, chunk or stored part carrying a provider's summary (`by` that one only), by the mark its SDK adapter gives
 *  it: Anthropic's on a text part, OpenAI's on a `custom` one. */
export function isServerCompaction(metadata: ProviderMetadata | JsonValue | undefined, by?: ServerCompactor): boolean {
  return (['anthropic', 'openai'] as const).some((vendor) => (by ?? vendor) === vendor && v.is(v.object({ [vendor]: CompactionMark }), metadata));
}
