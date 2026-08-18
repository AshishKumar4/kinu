/**
 * Evaluation types — results from MCTS exploration, convergence, cost estimates.
 * Architecture reference: docs/MCTS.md — "Scoring", "Pruning and convergence"
 */

import type { ModelPricing } from '../providers/types';

export interface ConvergenceResult {
  winnerId: string;
  winnerValue: number;
  converged: boolean;
  trajectory: Array<{ role: string; content: string }>;
}

/** Whether a candidate ran, contained no code, or used an unsupported language. */
export type EvaluationGrounding = 'execution' | 'judge' | 'unrunnable';

/**
 * How an estimate's dollars were arrived at — the field that keeps "costs
 * nothing" and "nobody priced it" apart.
 *
 * `catalog` carries the model's real models.dev rates, so an `estimatedUSD` of
 * 0 under it means the catalog prices this model at nothing and a spend gate
 * has no business refusing the work. `blended` means the price is UNKNOWN: the
 * figure is `llm.ts`'s conservative fallback over a projected token count — a
 * ceiling that still stops runaway spend, not a claim about what the model
 * charges.
 */
export type CostBasis =
  | {
    readonly source: 'catalog';
    /** The `<provider>/<modelId>` the rates were read for. */
    readonly model: string;
    /** models.dev USD per 1M tokens, verbatim. */
    readonly rates: ModelPricing;
  }
  | {
    readonly source: 'blended';
    /** The model whose price is unknown, or null when the caller named none. */
    readonly model: string | null;
    /** The fallback applied — `BLENDED_USD_PER_1K_TOKENS`. */
    readonly usdPer1kTokens: number;
  };

export interface CostEstimate {
  totalCalls: number;
  /** Projected spend at `basis`. Read the two together: a zero here is only
   *  free when `basis.source` is `catalog`. */
  estimatedUSD: number;
  basis: CostBasis;
  description: string;
}
