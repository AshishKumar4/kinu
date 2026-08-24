/**
 * Evaluation types — results from MCTS exploration, convergence, cost estimates.
 * Architecture reference: docs/MCTS.md — "Scoring", "Pruning and convergence"
 */

import type { ModelPricing } from '../providers/types';

/**
 * Why a finished search produced no acceptable answer.
 *
 * `no_acceptable_candidate`: the loop ran and every branch scored below
 * minAcceptableScore. `undifferentiated`: distinct approaches scored
 * identically, so argmax was noise and no winner was earned (DO-NOW #3).
 */
export type NonConvergenceReason = 'no_acceptable_candidate' | 'undifferentiated';

interface ConvergenceBase {
  readonly winnerId: string;
  readonly winnerValue: number;
  readonly trajectory: Array<{ role: string; content: string }>;
}

export type ConvergenceResult =
  | (ConvergenceBase & { readonly converged: true; readonly reason?: never })
  | (ConvergenceBase & {
      readonly converged: false;
      readonly reason: NonConvergenceReason;
    });

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
