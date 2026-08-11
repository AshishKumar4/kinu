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

export interface CostEstimate {
  totalCalls: number;
  estimatedUSD: number;
  description: string;
}
