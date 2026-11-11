// Reasoning-effort levels, and provider options merged per namespace. A call sends its effort as the AI SDK's own
// `reasoning`, which each provider's adapter sends as its API takes it, per model (Claude's adaptive thinking with its
// text shown, OpenAI's effort with its reasoning summary, Workers AI's reasoning_effort).

import type { streamText } from 'ai';

export {
  REASONING_EFFORTS, isReasoningEffort, knownReasoningEfforts,
  type ReasoningEffort,
} from './reasoning-effort';

export type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>;

/** Merges per provider namespace, the request's options over the plan's. */
export function mergeProviderOptions(
  base: ProviderOptions | undefined,
  override: ProviderOptions | undefined,
): ProviderOptions | undefined {
  if (!base) return override;

  if (!override) return base;
  const merged: ProviderOptions = { ...base };

  for (const [provider, options] of Object.entries(override)) {
    merged[provider] = { ...base[provider], ...options };
  }

  return merged;
}
