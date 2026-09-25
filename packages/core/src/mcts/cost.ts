/**
 * MCTS cost estimation before search, priced per model from the catalog (ModelCatalogSession.pricing()).
 * Reference: docs/MCTS.md "UCT Formula" (budget defaults).
 */

import type { CostBasis, CostEstimate } from '../types/evaluation';
import type { CostModel } from '../types/mcts';
import type { Usage } from '../usage';
import { DEFAULT_CONFIG } from '../config';
import { BLENDED_USD_PER_1K_TOKENS, estimateUsdCost } from '../llm';
import { priceCall } from '../mission-budget';

export type { CostModel } from '../types/mcts';

/**
 * Projected tokens of one average search call, split input/output as catalog rates are.
 * No `cacheRead`: a cold search has no warm prefix, and crediting one would understate the ceiling.
 */
const AVG_CALL_USAGE = { input: 1_500, output: 500 } as const satisfies Usage;

/** Sum of the split above, so the fallback prices the same token count as the catalog path. */
const AVG_TOKENS_PER_CALL = AVG_CALL_USAGE.input + AVG_CALL_USAGE.output;

/**
 * Estimate total LLM calls and approximate USD cost for an MCTS search. Without catalog rates for
 * `model`, falls back to the blended rate and says so in `basis`. A spend ceiling, not an invoice.
 */
export function estimateCost(
  budget: number,
  branches: number,
  evalCallsPerBranch: number = DEFAULT_CONFIG.mcts.maxEvalLLMCalls,
  model?: CostModel,
): CostEstimate {
  const explorationCalls = budget * branches;
  const evaluationCalls = budget * branches * evalCallsPerBranch;
  const reflectionCalls = Math.ceil(budget * branches * 0.3);
  const totalCalls = explorationCalls + evaluationCalls + reflectionCalls;

  const { estimatedUSD, basis } = priceProjection(totalCalls, model);

  return {
    totalCalls,
    estimatedUSD,
    basis,
    description: `~${totalCalls} LLM calls, ~$${estimatedUSD.toFixed(2)} `
      + `(budget=${budget}, branches=${branches}; ${describeCostBasis(basis)})`,
  };
}

function priceProjection(totalCalls: number, model: CostModel | undefined) {
  const pricing = model?.pricing;

  if (model && pricing) {
    const projected: Usage = {
      input: totalCalls * AVG_CALL_USAGE.input,
      output: totalCalls * AVG_CALL_USAGE.output,
    };

    // Same pricing as the ledger (mission-budget.priceCall), so estimate and debit agree.
    const priced = priceCall(projected, pricing);

    if (priced !== undefined) {
      return {
        estimatedUSD: priced,
        basis: { source: 'catalog', model: model.spec, rates: pricing } satisfies CostBasis,
      };
    }
  }

  return {
    estimatedUSD: estimateUsdCost(totalCalls * AVG_TOKENS_PER_CALL),
    basis: {
      source: 'blended',
      model: model?.spec ?? null,
      usdPer1kTokens: BLENDED_USD_PER_1K_TOKENS,
    } satisfies CostBasis,
  };
}

/** The basis as one human clause, shared by the estimate and the engine's refusal. */
export function describeCostBasis(basis: CostBasis): string {
  if (basis.source === 'catalog') {
    return `catalog rates for ${basis.model}: `
      + `$${basis.rates.input}/1M in, $${basis.rates.output}/1M out`;
  }

  const fallback = `the $${basis.usdPer1kTokens}/1k blended fallback`;

  return basis.model === null
    ? `no model named, so ${fallback} — the price is unknown, not zero`
    : `${basis.model} is unpriced in the catalog, so ${fallback} `
      + '— the price is unknown, not zero';
}
