/**
 * MCTS cost estimation — pre-check before running search.
 * Architecture reference: final-architecture.md §5.8
 */

import type { CostEstimate } from '../types/evaluation.js';
import { DEFAULT_CONFIG } from '../config.js';

/**
 * Rough blended USD per 1k tokens, used only for the pre-flight `maxCostUSD`
 * gate. This is a STATIC estimate, not a per-model quote: models.dev ships a
 * `cost` field per model but it is not yet surfaced through `ModelInfo`
 * (providers/types.ts), so estimateCost has no model-id to price against here.
 * The value is a deliberately conservative mid-range blend (≈ $3 / 1M tokens)
 * so the gate errs toward over- rather than under-estimating spend. When
 * per-model pricing lands in ModelInfo, thread the resolved rate through this
 * function and drop the constant.
 */
const USD_PER_1K_TOKENS = 0.003;
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
 * Cost uses a static blended rate (see USD_PER_1K_TOKENS) — the gate is a
 * spend ceiling, not an invoice.
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
  const estimatedUSD = (totalCalls * AVG_TOKENS_PER_CALL / 1000) * USD_PER_1K_TOKENS;

  return {
    totalCalls,
    estimatedUSD,
    description: `~${totalCalls} LLM calls, ~$${estimatedUSD.toFixed(2)} (budget=${budget}, branches=${branches})`,
  };
}
