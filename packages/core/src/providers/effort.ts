// Adaptive reasoning-effort budgets per inference stage.
//
// Chat Completions SDKs read `reasoningEffort` under their provider's name (workers-ai, opencode-go)
// and serialize reasoning_effort, overwriting a wire-spelled option.

import type { streamText } from 'ai';
import type { ReasoningEffort } from './reasoning-effort';

export {
  REASONING_EFFORTS, isReasoningEffort, knownReasoningEfforts,
  type ReasoningEffort,
} from './reasoning-effort';

export type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>;

export type InferenceStage =
  | 'chat'
  | 'judge'
  | 'reflection'
  | 'mcts_rollout'
  | 'mcts_judge'
  | 'scaffold_mutation' // Agent rewrites its own controller
  | 'head_merge'
  | 'memory_compress';

export const REASONING_EFFORT_FOR_STAGE = {
  chat: 'medium',
  judge: 'medium',
  reflection: 'low',
  mcts_rollout: 'low',
  mcts_judge: 'medium',
  scaffold_mutation: 'high',
  head_merge: 'medium',
  memory_compress: 'low',
} satisfies Record<InferenceStage, ReasoningEffort>;

export function workersAIEffortOption(
  effort?: ReasoningEffort,
) {
  if (!effort) return {};

  return { providerOptions: { 'workers-ai': { reasoningEffort: effort } } };
}

/** Levels Anthropic's `effort` accepts; others leave the model on its default rather than being refused. */
const ANTHROPIC_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function reasoningEffortOptions(
  effort: ReasoningEffort | null | undefined,
  providerFamily: string,
): ProviderOptions | undefined {
  if (!effort) return undefined;
  const family = providerFamily.split(':', 1)[0];

  switch (family) {
    case 'workers-ai':
      return workersAIEffortOption(effort).providerOptions;
    case 'openai':
    case 'codex':
    case 'openai-compat':
      return { openai: { reasoningEffort: effort } };
    case 'opencode':
    case 'opencode-go':
      return { openai: { reasoningEffort: effort }, [family]: { reasoningEffort: effort } };
    case 'openrouter':
      return { openrouter: { reasoningEffort: effort } };
    case 'anthropic':
    case 'claude':
      return ANTHROPIC_EFFORTS.includes(effort) ? { anthropic: { effort } } : undefined;
    default:
      return undefined;
  }
}

/** Merges per provider namespace so cache and reasoning settings coexist. */
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

export function effortFor(stage: InferenceStage) {
  return workersAIEffortOption(REASONING_EFFORT_FOR_STAGE[stage]);
}
