/**
 * MCTS types — search nodes, phases, configuration.
 *
 * Architecture reference: final-architecture.md §5.2
 *
 * BUG-1 FIX: NodeData.value defaults to 0, NOT 0.5.
 * Formal spec: MCTS/Backpropagation.lean — initial_valid, init_values_equal_at_first_step.
 */

export type NodeStatus = 'open' | 'terminal' | 'failed' | 'pruned';

/** A row in the search_nodes SQLite table */
export interface SearchNode {
  id: string;
  parent_id: string | null;
  task: string;
  action: string;
  observation: string;
  /** Code extracted from exploration branch (JS code blocks). Used for CraftStore extraction. */
  code_used: string | null;
  visits: number;
  /** Mean return in [0, 1]. Initialized to 0 (BUG-1 fix). */
  value: number;
  depth: number;
  status: NodeStatus;
  msg_id: string | null;
  branch_agent_key: string | null;
  created_at: number;
}

/** Fiber checkpoint state */
export interface MCTSPhase {
  iteration: number;
  budget: number;
  rootId: string;
  rootMsgId: string;
  task: string;
}

export interface MCTSConfig {
  budget: number;
  branches: number;
  maxDepth?: number;
  explorationWeight?: number;
  pruneThreshold?: number;
  minAcceptableScore?: number;
  maxCostUSD?: number;
  /** Judge ensemble size per branch evaluation (median-aggregated). */
  judgeSamples?: number;
  /** Per-branch evaluation LLM-call budget (assertions + judge samples). */
  maxEvalLLMCalls?: number;
  /** Near-tie gap for Alternate Takes capture at convergence. */
  takesEpsilon?: number;
  /**
   * Step-level Process Reward Model gate (default off). When on, each branch's
   * proposal is first scored by a cheap one-call step-PRM judge; proposals below
   * `stepPrmPruneThreshold` are pruned at that step score and SKIP the expensive
   * grounded evaluator (assertions + judge ensemble). Off by default: at the
   * current single-step rollout depth it duplicates the grounded evaluator's
   * signal at extra cost — it pays off only when branches are wide or the
   * grounded evaluator is expensive. See mcts/step-prm.ts.
   */
  stepPrm?: boolean;
  /** Step-PRM prune threshold [0..1]; proposals scoring below skip the grounded
   *  evaluator. Only consulted when `stepPrm` is on. */
  stepPrmPruneThreshold?: number;
  signal?: AbortSignal;
  /** Called after each MCTS iteration completes — use for real-time UI updates. */
  onIterationComplete?: (iteration: number, remainingBudget: number) => void;
}
