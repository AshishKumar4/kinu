// The reasoning-effort vocabulary. A platform fact: it is what the providers'
// wire fields accept, and a model's catalog entry names the subset it takes.
// The per-stage policy that CHOOSES an effort lives in strategy/effort.ts.
import * as v from 'valibot';

/**
 * Every effort level any provider documents, ordered low to high. This is the
 * WIRE vocabulary only: which subset a given model accepts is a fact about
 * that model and lives on its catalog entry (`ModelInfo.reasoningEfforts`),
 * which is what a settings control renders. Sources:
 *   OpenAI     none|minimal|low|medium|high|xhigh|max, per model —
 *              https://developers.openai.com/api/docs/guides/reasoning
 *   Anthropic  low|medium|high|xhigh|max, per model —
 *              https://platform.claude.com/docs/en/build-with-claude/effort
 *   OpenRouter none|minimal|low|medium|high|xhigh|max, per model —
 *              https://openrouter.ai/docs/use-cases/reasoning-tokens
 *   Workers AI low|medium|high, per model page —
 *              https://developers.cloudflare.com/workers-ai/models/
 */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** The three levels every OpenAI-compatible Chat Completions endpoint accepts
 *  in `reasoning_effort` — what a reasoning model gets when its catalog says
 *  it reasons but nothing names its levels.
 *  https://platform.openai.com/docs/api-reference/chat/create#chat_create-reasoning_effort */
export const CHAT_COMPLETIONS_REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

const ReasoningEffortSchema = v.picklist(REASONING_EFFORTS);

export function isReasoningEffort<Value>(value: Value): value is Value & ReasoningEffort {
  return v.safeParse(ReasoningEffortSchema, value).success;
}

/** Narrow an untrusted list (a provider's `supported_efforts`, a catalog row)
 *  to the levels this build knows, keeping the provider's order. Unknown
 *  spellings drop rather than fail: a vendor adding a level tomorrow must not
 *  empty today's menu. */
export function knownReasoningEfforts(values: readonly unknown[]): ReasoningEffort[] {
  return values.filter((value): value is ReasoningEffort => isReasoningEffort(value));
}

/** What a settings control offers for one model, after "model default": the
 *  levels the model's catalog entry declares, plus a stored level the entry
 *  no longer lists, so a row shows what it holds instead of reading as unset.
 *  An entry that declares nothing offers nothing: the three levels the old
 *  control hardcoded were wrong for every model with more or fewer. */
export function offeredReasoningEfforts(
  declared: readonly ReasoningEffort[] | undefined,
  stored: ReasoningEffort | null | undefined,
): ReasoningEffort[] {
  const offered = [...(declared ?? [])];

  if (stored != null && !offered.includes(stored)) offered.push(stored);

  return offered;
}

/** The level after `current` in a model's offer, wrapping; `current` itself
 *  when the offer is empty, so a cycle key on a model with no levels is a
 *  no-op rather than a write of `undefined`. */
export function nextReasoningEffort(offered: readonly ReasoningEffort[], current: ReasoningEffort): ReasoningEffort {
  return offered[(offered.indexOf(current) + 1) % offered.length] ?? current;
}
