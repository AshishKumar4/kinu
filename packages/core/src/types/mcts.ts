/**
 * Search tree types. NodeData.value defaults to 0, not 0.5.
 * Formal spec: MCTS/Backpropagation.lean — initial_in_range, init_values_equal_at_first_step.
 */

export type NodeStatus = 'open' | 'terminal' | 'failed' | 'pruned';

/** A row in the search_nodes SQLite table */
export interface SearchNode {
  id: string;
  parent_id: string | null;
  /** The root's id, itself included. */
  root_id: string;
  task: string;
  action: string;
  observation: string;
  code_used: string | null;
  visits: number;
  /** Subtree mean in [0, 1], initialized to 0. */
  value: number;
  depth: number;
  status: NodeStatus;
  msg_id: string | null;
  /** Null for the root, a failed evaluation and a swarm node. */
  created_at: number;
}
