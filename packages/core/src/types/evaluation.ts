/**
 * Evaluation types — results from MCTS exploration, convergence, cost estimates.
 * Architecture reference: final-architecture.md §5.6, §5.9
 */

export interface ExplorationResult {
  text: string;
  codeUsed: string | null;
  steps: number;
}

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
