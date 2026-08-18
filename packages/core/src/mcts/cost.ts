/**
 * MCTS cost estimation — pre-check before running search.
 * Architecture reference: docs/MCTS.md — "UCT Formula" (budget defaults)
 *
 * The estimate is MODEL-AWARE. It has to be: one blended rate over every model
 * both refuses work that the catalog prices at nothing and waves through work
 * on a model that costs an order of magnitude more, and the second failure is
 * the dangerous one. Rates come from the catalog the repo already reads
 * (models.dev, via ModelInfo.cost → ModelCatalogSession.pricing()) — there is
 * no price table here to rot.
 */

import type { CostBasis, CostEstimate } from '../types/evaluation';
import type { ModelPricing } from '../providers/types';
import type { Usage } from '../usage';
import { DEFAULT_CONFIG } from '../config';
import { BLENDED_USD_PER_1K_TOKENS, estimateUsdCost } from '../llm';
import { priceCall } from '../mission-budget';

/**
 * The projected shape of ONE average search call, across the explore /
 * assertion / judge / reflection mix.
 *
 * Split into input and output because catalog rates are, and the two differ by
 * 3x on the default model: a judge call is nearly all prompt, and charging its
 * completion tokens at the input rate (or the reverse) is how a model-aware
 * estimate would still lie.
 *
 * Deliberately carries NO `cacheRead`. A search that has not started has no
 * warm prefix, and crediting one would understate a cold run by the whole
 * cache discount — 30x on the default model, which is the wrong direction for
 * a spend ceiling to err in.
 */
const AVG_CALL_USAGE = { input: 1_500, output: 500 } as const satisfies Usage;

/** Blended tokens per LLM call — the sum of the split above rather than its own
 *  literal, so the fallback path prices exactly the token count the catalog
 *  path does and the two answers stay comparable. */
const AVG_TOKENS_PER_CALL = AVG_CALL_USAGE.input + AVG_CALL_USAGE.output;

/** The model a search will run on, as the pre-run gate needs to see it. */
export interface CostModel {
  /** Resolved `<provider>/<modelId>`. Named in the refusal so an operator can
   *  tell a real cap from a mispriced one. */
  readonly spec: string;
  /** The catalog's rates, or null when the lookup has not landed or the
   *  catalog publishes no price. Null is UNKNOWN — never free. A model the
   *  catalog prices at nothing arrives as `{ input: 0, output: 0 }`. */
  readonly pricing: ModelPricing | null;
}

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
 * `model` absent — or present with no catalog rates — falls back to the blended
 * rate and says so in `basis`, which is what this did for every model before it
 * was model-aware. The gate is a spend ceiling, not an invoice.
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
    // The ONE pricing implementation (mission-budget.priceCall), so a search's
    // pre-run estimate and the ledger that later debits the same calls cannot
    // disagree about what a token costs.
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

/** The basis as one human clause. Shared by the estimate's own description and
 *  the engine's refusal, so the two can never describe one figure differently. */
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
