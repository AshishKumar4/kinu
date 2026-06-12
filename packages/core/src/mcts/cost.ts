/**
 * MCTS cost estimation — pre-check before running search.
 * Architecture reference: final-architecture.md §5.8
 */

import type { CostEstimate } from '../types/evaluation.js';
import { DEFAULT_CONFIG } from '../config.js';

/**
 * Estimate total LLM calls and approximate USD cost for an MCTS search.
 *
 * Formula:
 *   exploration calls = budget × branches × avgSteps
 *   evaluation calls  = budget × branches × evalCallsPerBranch
 *                       (grounded scoring: assertion generation + judge
 *                        ensemble, capped by mcts.maxEvalLLMCalls)
 *   reflection calls  = budget × branches × ~30% failure rate
 *
 * Cost: ~2000 tokens/call average, $0.003/1k tokens (rough estimate)
 */
export function estimateCost(
  budget: number,
  branches: number,
  avgSteps: number = 3,
  evalCallsPerBranch: number = DEFAULT_CONFIG.mcts.maxEvalLLMCalls,
): CostEstimate {
  const explorationCalls = budget * branches * avgSteps;
  const evaluationCalls = budget * branches * evalCallsPerBranch;
  const reflectionCalls = Math.ceil(budget * branches * 0.3);
  const totalCalls = explorationCalls + evaluationCalls + reflectionCalls;
  const estimatedUSD = (totalCalls * 2000 / 1000) * 0.003;

  return {
    totalCalls,
    estimatedUSD,
    description: `~${totalCalls} LLM calls, ~$${estimatedUSD.toFixed(2)} (budget=${budget}, branches=${branches})`,
  };
}
