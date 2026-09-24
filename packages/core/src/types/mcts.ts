/**
 * MCTS types. NodeData.value defaults to 0, not 0.5.
 * Formal spec: MCTS/Backpropagation.lean — initial_in_range, init_values_equal_at_first_step.
 */

import type { ModelCallSink } from '../events/model-call';
import type { ModelPricing } from '../providers/types';

export interface CostModel {
  /** Resolved `<provider>/<modelId>`. */
  readonly spec: string;
  /** Null is unknown, never free; a free model arrives as `{ input: 0, output: 0 }`. */
  readonly pricing: ModelPricing | null;
}

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
  code_language: string | null;
  visits: number;
  /** Subtree mean in [0, 1], initialized to 0. */
  value: number;
  depth: number;
  status: NodeStatus;
  msg_id: string | null;
  branch_agent_key: string | null;
  /** Null for the root, a failed evaluation and a swarm node. */
  evaluation_json: string | null;
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
 * Branch failures are non-fatal (score 0, search continues), so they are reported here rather
 * than thrown. Only consumed as {@link MCTSProgressEvent}.
 */
export type MCTSProgressBody =
  | {
      type: 'phase';
      phase: 'explore' | 'evaluate' | 'reflect';
      iteration: number;
      remainingBudget: number;
      /** Reflect covers only the failing branches. */
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

/** Progress names its own tree: a workspace runs several searches at once. */
export type MCTSProgressEvent = MCTSProgressBody & { readonly rootId: string };

export interface MCTSConfig {
  /** Trusted caller mode. Direct/eval callers default to Build. */
  mode?: import('./turn').WorkMode;
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
   * Mission ledger this search charges. Branch spend arrives with results, so the engine debits it
   * between expansions and a refusal stops the next expansion rather than scoring a branch 0.
   */
  mission?: import('../mission-budget').MissionScope;
  /** Reports every rollout's usage as `mcts` spend, unconditionally; `mission` is only a cap. */
  reportModelCall?: ModelCallSink;
  /**
   * Read once by the pre-run `maxCostUSD` gate; a thunk because the catalog lookup lands
   * asynchronously. Absent: the gate prices at the blended fallback.
   */
  costModel?: () => CostModel;
  onProgress?: (event: MCTSProgressEvent) => void;
  /**
   * Durable checkpoint so a DO eviction can resume the remaining budget against the persisted tree
   * (B6). Absent: fiber-snapshot resume only.
   */
  search?: import('../mcts/search-store').MctsSearchStore;
}
