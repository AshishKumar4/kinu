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
  /** The search's task, on its root; null on a child, which reads its root's through `search_node_scores`. */
  task: string | null;
  action: string;
  observation: string;
  visits: number;
  /** Subtree mean in [0, 1], initialized to 0. */
  value: number;
  depth: number;
  status: NodeStatus;
  created_at: number;
}
