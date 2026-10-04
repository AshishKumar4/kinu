/**
 * Anthropic's server-side compaction (platform.claude.com/docs/en/build-with-claude/compaction-threshold): past the
 * trigger, the API summarizes the conversation into a `compaction` block that opens it from then on. A Claude model
 * that supports it compacts there instead of in better-compact's summary stages, at Kinu's one compaction trigger.
 */
import type { ProviderMetadata } from 'ai';
import * as v from 'valibot';
import type { JsonValue } from '../utils/json';
import type { ProviderOptions } from './effort';

/** Where Kinu compacts, as a percentage of the context window: the ladder's trigger and the provider's. */
export const COMPACTION_TRIGGER_PERCENT = 85;

/** The fewest input tokens the API compacts at: it refuses a lower trigger. */
export const SERVER_COMPACTION_MIN_TOKENS = 50_000;

/** A forced compaction triggers this far under the request's own input, so a count a little high still trips it. */
const FORCED_TRIGGER = 0.9;

/** Anthropic's compatibility list: Opus and Sonnet from 4.6, Fable and Mythos from 5, and Mythos Preview. */
const COMPACTING = /^claude-(?:(opus|sonnet)-(\d+)(?:-(\d{1,2}))?(?!\d)|(fable|mythos)-(\d+)|mythos-preview)/u;

export function compactsServerSide(spec: string | undefined): boolean {
  const match = /^(?:anthropic|claude)(?:@[^/]*)?\/(?:.*\/)?([^/]+)$/u.exec(spec ?? '');
  const model = COMPACTING.exec(match?.[1] ?? '');

  if (model === null) return false;

  if (model[1] !== undefined) return Number(model[2]) + Number(model[3] ?? 0) / 10 >= 4.6;

  return model[4] === undefined || Number(model[5]) >= 5;
}

/**
 * The request option asking for it, or undefined where the model does not compact server-side. A forced compaction
 * (`/compact`, an overflow's recovery) passes the request's own input, so this request compacts.
 */
export function serverCompactionOptions(
  spec: string | undefined, contextWindow: number | undefined, forcedInput?: number,
): ProviderOptions | undefined {
  const threshold = Math.floor(((contextWindow ?? 0) * COMPACTION_TRIGGER_PERCENT) / 100);

  if (!compactsServerSide(spec) || threshold < SERVER_COMPACTION_MIN_TOKENS) return undefined;

  const value = forcedInput === undefined
    ? threshold
    : Math.max(SERVER_COMPACTION_MIN_TOKENS, Math.min(threshold, Math.floor(forcedInput * FORCED_TRIGGER)));

  return { anthropic: { contextManagement: { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value } }] } } };
}

const CompactionMarkSchema = v.object({ anthropic: v.looseObject({ type: v.literal('compaction') }) });

/** A text part, chunk or stored part carrying the provider's summary, by the mark @ai-sdk/anthropic gives it. */
export function isServerCompaction(metadata: ProviderMetadata | JsonValue | undefined): boolean {
  return v.is(CompactionMarkSchema, metadata);
}
