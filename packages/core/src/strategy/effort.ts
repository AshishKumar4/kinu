// Adaptive reasoning-effort budgets per inference stage.
//
// Workers AI exposes `reasoning_effort: 'low' | 'medium' | 'high'` for the
// reasoning-capable models (Kimi K2.6, GLM-4, GPT-OSS, DeepSeek R1). The
// AI SDK forwards `providerOptions['workers-ai'].reasoning_effort` to the
// binding's `inputs` field, so we can set it per-call without touching the
// provider construction.
//
// The defaults here encode the policy: cheap on fan-out (MCTS rollouts,
// RLM sub-calls), medium for user-visible work, high for rare-but-important
// turns (scaffold mutation). Callers can override.

import type { streamText } from 'ai';

export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>;

export function isReasoningEffort<Value>(value: Value): value is Value & ReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high';
}

export type InferenceStage =
  | 'chat'              // User-facing chat turn
  | 'judge'             // Judge / review / quality scoring
  | 'reflection'        // Lesson extraction after a turn
  | 'mcts_rollout'      // Inside MCTS — many cheap samples
  | 'mcts_judge'        // MCTS final-rollout scoring
  | 'rlm_subcall'       // Inside llm.query() — cheap fan-out
  | 'scaffold_mutation' // Rare; agent rewrites its own controller — be careful
  | 'head_merge'        // LLM-driven merge of parallel heads
  | 'memory_compress';  // Background sleep-time compute (compress memory)

export const REASONING_EFFORT_FOR_STAGE = {
  chat: 'medium',
  judge: 'medium',
  reflection: 'low',
  mcts_rollout: 'low',
  mcts_judge: 'medium',
  rlm_subcall: 'low',
  scaffold_mutation: 'high',
  head_merge: 'medium',
  memory_compress: 'low',
} satisfies Record<InferenceStage, ReasoningEffort>;

/** Build the `providerOptions` AI-SDK option that carries reasoning_effort
 *  through to Workers AI's underlying `binding.run(model, { reasoning_effort })`.
 *  Returns `{}` when effort is undefined so callers can spread unconditionally. */
export function workersAIEffortOption(
  effort?: ReasoningEffort | undefined,
) {
  if (!effort) return {};
  return { providerOptions: { 'workers-ai': { reasoning_effort: effort } } };
}

const ANTHROPIC_THINKING_BUDGET = {
  low: 4_000,
  medium: 16_000,
  high: 32_000,
} satisfies Record<ReasoningEffort, number>;

/** Provider-native reasoning options for a resolved model-spec prefix. */
export function reasoningEffortOptions(
  effort: ReasoningEffort | undefined,
  providerFamily: string,
): ProviderOptions | undefined {
  if (!effort) return undefined;
  const family = providerFamily.split(':', 1)[0];
  switch (family) {
    case 'workers-ai':
      return workersAIEffortOption(effort).providerOptions;
    case 'openai':
    case 'opencode':
    case 'codex':
    case 'openai-compat':
      return { openai: { reasoningEffort: effort } };
    case 'openrouter':
      return { openrouter: { reasoningEffort: effort } };
    case 'anthropic':
      return {
        anthropic: {
          thinking: { type: 'enabled', budgetTokens: ANTHROPIC_THINKING_BUDGET[effort] },
        },
      };
    default:
      return undefined;
  }
}

/** Merge request-level options by provider namespace so cache and reasoning
 *  settings can coexist on the same model request. */
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

/** Shortcut: `effortFor('judge')` → `{ providerOptions: ... }`. */
export function effortFor(stage: InferenceStage) {
  return workersAIEffortOption(REASONING_EFFORT_FOR_STAGE[stage]);
}
