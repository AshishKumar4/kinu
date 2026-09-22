// Reasoning-effort wire vocabulary; the per-stage choice lives in strategy/effort.ts.
import * as v from 'valibot';

/**
 * Every effort level any provider documents, low to high; per-model subsets live on
 * `ModelInfo.reasoningEfforts`. Sources:
 *   OpenAI     https://developers.openai.com/api/docs/guides/reasoning
 *   Anthropic  https://platform.claude.com/docs/en/build-with-claude/effort
 *   OpenRouter https://openrouter.ai/docs/use-cases/reasoning-tokens
 *   Workers AI https://developers.cloudflare.com/workers-ai/models/
 */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

const ReasoningEffortSchema = v.picklist(REASONING_EFFORTS);

export function isReasoningEffort<Value>(value: Value): value is Value & ReasoningEffort {
  return v.safeParse(ReasoningEffortSchema, value).success;
}

/** Narrow an untrusted list to known levels in the provider's order; unknown spellings drop. */
export function knownReasoningEfforts(values: readonly unknown[]): ReasoningEffort[] {
  return values.filter((value): value is ReasoningEffort => isReasoningEffort(value));
}

/** The model's declared levels plus a stored level it no longer lists, so the row
 *  shows what it holds. */
export function offeredReasoningEfforts(
  declared: readonly ReasoningEffort[] | undefined,
  stored: ReasoningEffort | null | undefined,
): ReasoningEffort[] {
  const offered = [...(declared ?? [])];

  if (stored != null && !offered.includes(stored)) offered.push(stored);

  return offered;
}

/** Next level in the offer, wrapping; `current` itself when the offer is empty. */
export function nextReasoningEffort(offered: readonly ReasoningEffort[], current: ReasoningEffort): ReasoningEffort {
  return offered[(offered.indexOf(current) + 1) % offered.length] ?? current;
}
