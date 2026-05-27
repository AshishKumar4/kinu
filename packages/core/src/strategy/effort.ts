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

export type ReasoningEffort = 'low' | 'medium' | 'high';

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

export const REASONING_EFFORT_FOR_STAGE: Record<InferenceStage, ReasoningEffort> = {
  chat: 'medium',
  judge: 'medium',
  reflection: 'low',
  mcts_rollout: 'low',
  mcts_judge: 'medium',
  rlm_subcall: 'low',
  scaffold_mutation: 'high',
  head_merge: 'medium',
  memory_compress: 'low',
};

/** Build the `providerOptions` AI-SDK option that carries reasoning_effort
 *  through to Workers AI's underlying `binding.run(model, { reasoning_effort })`.
 *  Returns `{}` when effort is undefined so callers can spread unconditionally. */
export function workersAIEffortOption(
  effort?: ReasoningEffort | undefined,
): { providerOptions?: { 'workers-ai': { reasoning_effort: ReasoningEffort } } } {
  if (!effort) return {};
  return { providerOptions: { 'workers-ai': { reasoning_effort: effort } } };
}

/** Shortcut: `effortFor('judge')` → `{ providerOptions: ... }`. */
export function effortFor(stage: InferenceStage) {
  return workersAIEffortOption(REASONING_EFFORT_FOR_STAGE[stage]);
}
