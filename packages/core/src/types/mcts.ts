/**
 * MCTS types — search nodes, phases, configuration.
 *
 * Architecture reference: final-architecture.md §5.2
 *
 * BUG-1 FIX: NodeData.value defaults to 0, NOT 0.5.
 * Formal spec: Backpropagation.lean:initial_valid, init_05_eq_init_0_first_step.
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
  signal?: AbortSignal;
  /** Called after each MCTS iteration completes — use for real-time UI updates. */
  onIterationComplete?: (iteration: number, remainingBudget: number) => void;
}
