import type { ModelPricing } from '../providers/types';

/** `undifferentiated`: distinct approaches scored identically, so argmax was noise (DO-NOW #3). */
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

export type EvaluationGrounding = 'execution' | 'judge' | 'unrunnable';

/** Keeps "costs nothing" (`catalog`, 0) apart from "nobody priced it" (`blended` fallback ceiling). */
export type CostBasis =
  | {
    readonly source: 'catalog';
    readonly model: string;
    /** models.dev USD per 1M tokens, verbatim. */
    readonly rates: ModelPricing;
  }
  | {
    readonly source: 'blended';
    readonly model: string | null;
    readonly usdPer1kTokens: number;
  };

export interface CostEstimate {
  totalCalls: number;
  /** Zero is only free when `basis.source` is `catalog`. */
  estimatedUSD: number;
  basis: CostBasis;
  description: string;
}
