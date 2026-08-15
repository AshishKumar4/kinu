/**
 * Evaluation types — results from MCTS exploration, convergence, cost estimates.
 * Architecture reference: docs/MCTS.md — "Scoring", "Pruning and convergence"
 */

export interface ConvergenceResult {
  winnerId: string;
  winnerValue: number;
  converged: boolean;
  trajectory: Array<{ role: string; content: string }>;
}

/** Whether a candidate ran, contained no code, or used an unsupported language. */
export type EvaluationGrounding = 'execution' | 'judge' | 'unrunnable';

export interface CostEstimate {
  totalCalls: number;
  estimatedUSD: number;
  description: string;
}
