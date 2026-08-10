/**
 * MCTS types — search nodes, phases, configuration.
 *
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

/**
 * Live search progress. Branch failures are non-fatal by design — a failed
 * exploration or evaluation scores 0 and the search continues — so they are
 * reported rather than thrown; without them a fully degraded run is
 * indistinguishable from a healthy one that simply found nothing.
 */
export type MCTSProgressEvent =
  | {
      type: 'phase';
      phase: 'explore' | 'evaluate' | 'reflect';
      iteration: number;
      remainingBudget: number;
      /** Branches this phase covers (reflect only covers the failing ones). */
      branches: number;
    }
  | {
      type: 'branch-failed';
      stage: 'explore' | 'evaluate' | 'reflect';
      iteration: number;
      branchId: string;
      error: string;
    }
  | {
      type: 'iteration-complete';
      iteration: number;
      remainingBudget: number;
      scores: readonly number[];
    };

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
  signal?: AbortSignal;
  /** Called as the search progresses — phase transitions, branch failures and
   *  iteration completion. Use for real-time UI updates. */
  onProgress?: (event: MCTSProgressEvent) => void;
  /** Durable search checkpoint. When present, the loop's progress + resolved
   *  config are persisted per iteration under a lease epoch, so a DO eviction can
   *  re-enter runMCTS and continue the remaining budget against the persisted
   *  tree instead of discarding the search (B6). Absent ⇒ fiber-snapshot resume
   *  only (tests / inline fast path). Typed loosely here to avoid a mcts→store
   *  import cycle; the concrete type is MctsSearchStore. */
  search?: import('../mcts/search-store.js').MctsSearchStore;
}
