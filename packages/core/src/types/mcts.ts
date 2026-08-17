/**
 * MCTS types — search nodes, phases, configuration.
 *
 * Architecture reference: docs/MCTS.md — "search_nodes Table"
 *
 * BUG-1 FIX: NodeData.value defaults to 0, NOT 0.5.
 * Formal spec: MCTS/Backpropagation.lean — initial_valid, init_values_equal_at_first_step.
 */

export type NodeStatus = 'open' | 'terminal' | 'failed' | 'pruned';

/** A row in the search_nodes SQLite table */
export interface SearchNode {
  id: string;
  parent_id: string | null;
  /** The search run this node belongs to (the root's id, itself included).
   *  NULL only on legacy rows written before the column existed. */
  root_id: string | null;
  task: string;
  action: string;
  observation: string;
  /** Runnable source extracted from the proposal. */
  code_used: string | null;
  /** Executor language for code_used. */
  code_language: string | null;
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
 * What a search reports, without saying which search. Branch failures are
 * non-fatal by design — a failed exploration or evaluation scores 0 and the
 * search continues — so they are reported rather than thrown; without them a
 * fully degraded run is indistinguishable from a healthy one that simply found
 * nothing.
 *
 * Never consumed on its own: {@link MCTSProgressEvent} is this plus the search
 * that raised it. Exported only so the engine can stamp that identity once.
 */
export type MCTSProgressBody =
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
      type: 'grounding-unavailable';
      language: string;
      canRun: readonly string[];
      iteration: number;
      remainingBudget: number;
    }
  | {
      type: 'iteration-complete';
      iteration: number;
      remainingBudget: number;
      scores: readonly number[];
    };

/**
 * Live search progress, and WHICH search produced it.
 *
 * A workspace runs several searches at once — two `agents(settle:'mcts')` forks
 * detach independently — so a consumer that answered a progress event by
 * reading "the latest tree" was reading whichever root had been written to most
 * recently. That is a coin flip between the live searches: one search's
 * iteration shipped another's nodes under its own phase and budget, and a
 * backpropagation (which updates visits without inserting a node, so it never
 * becomes "latest") was dropped as a no-change. The event names its own tree so
 * neither is possible.
 */
export type MCTSProgressEvent = MCTSProgressBody & { readonly rootId: string };

export interface MCTSConfig {
  /** Trusted caller mode. Direct/eval callers default to Build. */
  mode?: import('../prompting/surface.js').WorkMode;
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
  /**
   * The mission ledger this search charges, when it runs under one.
   *
   * A branch resolves its own model in another process, so its rollout spend is
   * invisible to the governed `rt.llm` the fork seam wraps: it arrives with the
   * result instead, and the engine debits it between expansions. The engine is
   * also the only place a refusal can be HANDLED — a branch that refused its own
   * call would come back empty, score 0 and backpropagate that 0 up the
   * persisted tree, so the stop has to be "do not open the next expansion",
   * which only the loop can decide.
   *
   * Absent is the default and then nothing is asked: no port call, no query, no
   * refusal.
   */
  mission?: import('../mission-budget.js').MissionScope;
  /** Called as the search progresses — phase transitions, branch failures and
   *  iteration completion. Use for real-time UI updates. */
  onProgress?: (event: MCTSProgressEvent) => void;
  /** Durable search checkpoint. When present, the loop's progress + resolved
   *  config are persisted per iteration under a lease epoch, so a DO eviction can
   *  re-enter runMCTS and continue the remaining budget against the persisted
   *  tree instead of discarding the search (B6). Absent ⇒ fiber-snapshot resume
   *  only (tests / inline fast path). Typed loosely here to avoid an mcts→store
   *  import cycle; the concrete type is MctsSearchStore. */
  search?: import('../mcts/search-store.js').MctsSearchStore;
}
