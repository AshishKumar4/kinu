/**
 * Branching heads — types.
 *
 * A *head* is a divergent reasoning thread of the agent's working state.
 *
 * What's different from sub-agents:
 *   • Sub-agent  → isolated context, gets only its input, returns structured result
 *   • Head       → sees the WHOLE conversation context, accumulates EPHEMERAL
 *                  interim context (scratch notes, tool results), merges back
 *                  via LLM synthesis. Can recursively spawn children under a
 *                  depth budget.
 *
 * What's different from MCTS branches:
 *   • MCTS branch → samples one approach for evaluation (one short LLM call)
 *   • Head        → does real work: multiple turns, tool calls, file writes
 *
 * Lifecycle:
 *   1. parent calls HeadController.split({ rationale, heads: [...] })
 *   2. controller materializes each head as a Facet via runtime hook
 *   3. each head runs its task autonomously (own ephemeral storage)
 *   4. heads may call splitHeads() on themselves (recursive, decremented depth)
 *   5. controller awaitAll(heads) collects HeadReport[]
 *   6. merge(reports, strategy) → LLM synthesis → MergeResult
 *   7. parent writes MergeResult.mergedNarrative back into conversation
 */

import type { ToolCallRecord } from '../evolution/types.js';

/** Opaque head identifier — kebab-case string, globally unique within a turn. */
export type HeadId = string;

/** What kind of merging the parent wants — drives the merge prompt. */
export type MergeStrategy =
  | 'synthesize'   // unify into one coherent narrative (default)
  | 'best_of'      // pick the strongest single head; cite weaker ones briefly
  | 'consensus';   // emphasize areas of agreement; surface disagreements

/**
 * Hard budgets that propagate down the head tree.
 *
 * Each spawn DECREMENTS maxDepth. When 0, further splits are rejected.
 * Token + wall-clock budgets are shared across the subtree — child heads
 * receive their slice when spawned.
 */
export interface HeadBudget {
  /** Remaining depth; root = configured root, decremented per spawn. */
  readonly maxDepth: number;
  /** Cumulative token ceiling for this head and its descendants. */
  readonly maxTokens: number;
  /** Wall-clock ceiling in milliseconds. */
  readonly maxWallClockMs: number;
  /** Epoch ms when the head was spawned; used for wall-clock enforcement. */
  readonly spawnedAt: number;
}

/** Cap a sub-budget on spawn — child gets at most this much of parent's budget. */
export interface BudgetSplit {
  /** Fraction of parent.maxTokens given to each child. Default = 1 / n_children. */
  readonly tokensRatio?: number;
  /** Fraction of parent.maxWallClockMs given to each child. Default = same as parent. */
  readonly wallClockRatio?: number;
}

/** A snapshotted message from the parent's conversation, given to each head. */
export interface SerializedMessage {
  readonly id: string;
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly createdAt: number;
  /** For 'tool' role: which tool produced this result. */
  readonly toolName?: string;
}

/** Everything a HeadAgent needs to start working. */
export interface HeadInput {
  readonly id: HeadId;
  readonly rootId: HeadId;                 // root of the split tree (== id if this is a root)
  readonly parentId: HeadId | null;        // null only for the root head
  readonly depth: number;                  // 0 for root, +1 per spawn
  readonly task: string;                   // what this head should explore
  readonly rationale: string;              // why this head was spawned (carried for merge prompt)
  readonly inheritedContext: SerializedMessage[];
  readonly budget: HeadBudget;
  /** The model to use for this head — usually the same as the parent's. */
  readonly model?: string;
  /**
   * Namespaces of sandboxes this head may use. Empty = none allowed (read-only
   * exploration). Default = all the parent has access to.
   */
  readonly allowedSandboxes?: readonly string[];
  /** Names of crafted tools this head may invoke. Empty = none. Undefined = all. */
  readonly allowedTools?: readonly string[];
  /** Merge strategy the parent will apply — exposed so the head can shape its summary. */
  readonly mergeStrategy: MergeStrategy;
}

/** A single piece of evidence the head considered authoritative. */
export interface Evidence {
  readonly id: string;
  readonly kind: 'tool_output' | 'fact' | 'citation' | 'artifact';
  readonly body: string;
  /** Optional pointer to where this came from (file path, URL, tool call id). */
  readonly ref?: string;
  /** Confidence 0..1 — heads self-report; used by merge to weight contributions. */
  readonly confidence?: number;
}

/** A decision the head made — surfaces for the merge prompt to reconcile. */
export interface Decision {
  readonly question: string;
  readonly choice: string;
  readonly rationale: string;
  /** Which evidence ids back this decision. */
  readonly supportingEvidence?: readonly string[];
}

/** Pointer to a tangible side-effect the head produced. */
export interface ArtifactRef {
  readonly kind: 'file' | 'port' | 'memory' | 'note';
  readonly ref: string;
  readonly description?: string;
}

/** What a head reports back to its parent on completion. */
export interface HeadReport {
  readonly id: HeadId;
  readonly status: 'completed' | 'budget_exceeded' | 'aborted' | 'errored';
  /** 2-4 sentence finding — the LLM writes this. Used in the merge prompt. */
  readonly summary: string;
  /** Top-N evidence items (head decides; usually <= 10). */
  readonly evidence: readonly Evidence[];
  readonly decisions: readonly Decision[];
  readonly artifactRefs: readonly ArtifactRef[];
  /** Heads this one spawned (already merged before returning). */
  readonly childHeadIds: readonly HeadId[];
  /** Tool calls the head made — for telemetry. */
  readonly toolCalls: readonly ToolCallRecord[];
  readonly tokenUsage: { input: number; output: number; total: number };
  readonly wallClockMs: number;
  /** Free-form failure message if status != 'completed'. */
  readonly errorMessage?: string;
}

/** What the parent asks the controller to run. */
export interface SplitRequest {
  /** The merge prompt will receive this as overall framing. */
  readonly rationale: string;
  readonly heads: Array<{
    readonly task: string;
    readonly rationale: string;
    readonly allowedSandboxes?: readonly string[];
    readonly allowedTools?: readonly string[];
  }>;
  readonly mergeStrategy?: MergeStrategy;
  readonly budget?: Partial<{
    maxDepth: number;
    maxTokens: number;
    maxWallClockMs: number;
  }>;
  /** How to slice the parent's budget among children — default: equal share. */
  readonly budgetSplit?: BudgetSplit;
}

/** Result of split → await → merge. The parent writes mergedNarrative back. */
export interface MergeResult {
  readonly mergedNarrative: string;
  /** Decisions the LLM selected as final answers (cherry-picked across heads). */
  readonly selectedDecisions: readonly Decision[];
  /** Decisions/questions the heads disagreed on — surfaced for the parent. */
  readonly unresolvedQuestions: readonly string[];
  /** Concrete next-step suggestions. */
  readonly recommendations: readonly string[];
  /** Aggregate of every head's evidence — for memory writeback. */
  readonly evidenceAggregate: readonly Evidence[];
  /** The ids of every head spawned in this split (root-level only — not recursive). */
  readonly headIds: readonly HeadId[];
  readonly costSummary: {
    readonly headCount: number;
    readonly totalTokens: number;
    readonly totalWallClockMs: number;
    readonly maxDepth: number;
  };
}

/** Default budget for a fresh root head if the parent doesn't specify. */
export const DEFAULT_HEAD_BUDGET: Omit<HeadBudget, 'spawnedAt'> = {
  maxDepth: 3,
  maxTokens: 50_000,
  maxWallClockMs: 5 * 60 * 1000,
};

/** Default merge strategy. */
export const DEFAULT_MERGE_STRATEGY: MergeStrategy = 'synthesize';

/**
 * Split parent's budget among N children. Returns the per-child budget.
 *
 * Defaults: equal token split, full wall-clock to each (they run in parallel).
 * Depth decremented unconditionally.
 */
export function deriveChildBudget(
  parent: HeadBudget,
  n: number,
  split?: BudgetSplit,
): HeadBudget {
  const safeN = Math.max(1, n);
  const tokensRatio = split?.tokensRatio ?? 1 / safeN;
  const wallClockRatio = split?.wallClockRatio ?? 1;
  return {
    maxDepth: parent.maxDepth - 1,
    maxTokens: Math.floor(parent.maxTokens * tokensRatio),
    maxWallClockMs: Math.floor(parent.maxWallClockMs * wallClockRatio),
    spawnedAt: Date.now(),
  };
}

/** Returns true if this budget is exhausted along any dimension. */
export function budgetExhausted(b: HeadBudget): { exhausted: boolean; reason?: string } {
  if (b.maxDepth <= 0) return { exhausted: true, reason: 'max-depth' };
  if (b.maxTokens <= 0) return { exhausted: true, reason: 'tokens' };
  if (Date.now() - b.spawnedAt >= b.maxWallClockMs) return { exhausted: true, reason: 'wall-clock' };
  return { exhausted: false };
}
