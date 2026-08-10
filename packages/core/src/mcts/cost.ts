/**
 * MCTS cost estimation — pre-check before running search.
 * Architecture reference: docs/MCTS.md — "UCT Formula" (budget defaults)
 */

import type { CostEstimate } from '../types/evaluation.js';
import { DEFAULT_CONFIG } from '../config.js';
import { BLENDED_USD_PER_1K_TOKENS } from '../llm.js';

/** Rough blended tokens per LLM call (prompt in + completion out) across the
 *  explore / assertion / judge / reflection call mix. Static, same caveat. */
const AVG_TOKENS_PER_CALL = 2000;

/**
 * Estimate total LLM calls and approximate USD cost for an MCTS search.
 *
 * Call model (one iteration expands `branches` children from the selected node):
 *   exploration calls = budget × branches
 *                       (branch rollouts are SINGLE-STEP — BranchHandle.explore
 *                        is exactly one LLM call producing one proposal)
 *   evaluation calls  = budget × branches × evalCallsPerBranch
 *                       (grounded scoring: assertion generation + judge
 *                        ensemble, capped by mcts.maxEvalLLMCalls)
 *   reflection calls  = budget × branches × ~30% failure rate
 *
 * Cost uses the static blended rate (see BLENDED_USD_PER_1K_TOKENS) — the gate
 * is a spend ceiling, not an invoice.
 */
export function estimateCost(
  budget: number,
  branches: number,
  evalCallsPerBranch: number = DEFAULT_CONFIG.mcts.maxEvalLLMCalls,
): CostEstimate {
  const explorationCalls = budget * branches;
  const evaluationCalls = budget * branches * evalCallsPerBranch;
  const reflectionCalls = Math.ceil(budget * branches * 0.3);
  const totalCalls = explorationCalls + evaluationCalls + reflectionCalls;
  const estimatedUSD = (totalCalls * AVG_TOKENS_PER_CALL / 1000) * BLENDED_USD_PER_1K_TOKENS;

  return {
    totalCalls,
    estimatedUSD,
    description: `~${totalCalls} LLM calls, ~$${estimatedUSD.toFixed(2)} (budget=${budget}, branches=${branches})`,
  };
}
