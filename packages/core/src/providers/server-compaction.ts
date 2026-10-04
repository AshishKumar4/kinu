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

/** The API refuses a lower trigger. */
const ANTHROPIC_MIN_TRIGGER = 50_000;

/** Anthropic's compatibility list: Opus and Sonnet from 4.6, Fable and Mythos from 5, and Mythos Preview. */
const COMPACTING = /^claude-(?:(opus|sonnet)-(\d+)(?:-(\d{1,2}))?(?!\d)|(fable|mythos)-(\d+)|mythos-preview)/u;

export function compactsServerSide(spec: string | undefined): boolean {
  const match = /^(?:anthropic|claude)(?:@[^/]*)?\/(?:.*\/)?([^/]+)$/u.exec(spec ?? '');
  const model = COMPACTING.exec(match?.[1] ?? '');

  if (model === null) return false;

  if (model[1] !== undefined) return Number(model[2]) + Number(model[3] ?? 0) / 10 >= 4.6;

  return model[4] === undefined || Number(model[5]) >= 5;
}

/** The request option asking for it, or undefined where the model does not compact server-side. */
export function serverCompactionOptions(spec: string | undefined, contextWindow: number | undefined): ProviderOptions | undefined {
  const value = Math.floor(((contextWindow ?? 0) * COMPACTION_TRIGGER_PERCENT) / 100);

  if (!compactsServerSide(spec) || value < ANTHROPIC_MIN_TRIGGER) return undefined;

  return { anthropic: { contextManagement: { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value } }] } } };
}

const CompactionMarkSchema = v.object({ anthropic: v.looseObject({ type: v.literal('compaction') }) });

/** A text part, chunk or stored part carrying the provider's summary, by the mark @ai-sdk/anthropic gives it. */
export function isServerCompaction(metadata: ProviderMetadata | JsonValue | undefined): boolean {
  return v.is(CompactionMarkSchema, metadata);
}
