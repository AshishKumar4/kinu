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

/** Everything a branching head needs to start working. */
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

/** One tool call within a head step — name + (digested) input/output. */
export interface HeadStepToolCall {
  readonly name: string;
  readonly input?: unknown;
  readonly output?: unknown;
}

/** One reasoning step of a head's run — the ordered trace the UI replays so the
 *  user can see what each branch actually did, turn by turn. */
export interface HeadStep {
  readonly text: string;
  readonly reasoning?: string;
  readonly toolCalls: readonly HeadStepToolCall[];
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
  /** Ordered per-step trace (text + reasoning + tool calls) — drives the live
   *  expandable head timeline in the Reasoning surface. */
  readonly steps: readonly HeadStep[];
  readonly tokenUsage: { input: number; output: number; total: number };
  readonly wallClockMs: number;
  /** Free-form failure message if status != 'completed'. */
  readonly errorMessage?: string;
}

/** One head as the Reasoning surface renders it — lifecycle + the ordered
 *  trace. Assembled by HeadJournal.listRuns; returned verbatim by getHeadRuns. */
export interface HeadRunHeadView {
  readonly id: HeadId;
  readonly task: string;
  readonly rationale: string;
  readonly status: string;
  readonly summary: string | null;
  readonly errorMessage: string | null;
  readonly tokenInput: number;
  readonly tokenOutput: number;
  readonly wallClockMs: number;
  readonly toolCalls: ReadonlyArray<{ name: string; status: string }>;
  readonly decisions: ReadonlyArray<{ question: string; choice: string; rationale: string }>;
  readonly steps: readonly HeadStep[];
}

/** One split (a run): its identity + grouped heads + the merge synthesis. */
export interface HeadRunView {
  readonly rootId: HeadId;
  readonly task: string;
  readonly rationale: string;
  readonly status: string;
  readonly spawnedAt: number;
  readonly heads: readonly HeadRunHeadView[];
  readonly merge: { narrative: string; headCount: number; totalTokens: number } | null;
}

/** What the parent asks the controller to run. */
export interface SplitRequest {
  /** The merge prompt will receive this as overall framing. */
  readonly rationale: string;
  readonly heads: Array<{
    readonly task: string;
    readonly rationale: string;
    /** Per-head provider/model spec (e.g. `codex/gpt-5.5`). Heterogeneous
     *  models per head enable multi-agent debate / panel-of-experts. */
    readonly model?: string;
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
  /** Per-head outcome score in [0,1] + the head's text — one entry per head,
   *  surfaced as Alternate-Takes and reported to the preference ledger. When
   *  `grounded`, the score is execution-banded (mcts/evaluation.ts); otherwise a
   *  neutral 0.5 (no grounding seam wired). A failed/unresolved head scores below
   *  a head whose work ran and held up. */
  readonly headScores: readonly HeadScore[];
  /** True when headScores carry a real grounded verdict (the controller had a
   *  grounding seam); false when they are neutral placeholders. */
  readonly grounded: boolean;
  readonly costSummary: {
    readonly headCount: number;
    /** How many of those heads actually banked a finding (headProducedFindings).
     *  `headCount - headsWithFindings` is how many forks came back empty — the
     *  one number that says whether a delegation was worth its tokens. */
    readonly headsWithFindings: number;
    readonly totalTokens: number;
    readonly totalWallClockMs: number;
    readonly maxDepth: number;
  };
}

/** A single head's execution-grounded outcome score, mirroring the MCTS
 *  BranchEvaluation shape (evaluation.ts) so heads and branches report the same
 *  grounded signal. Carries the head's summary so the backend can build the
 *  Alternate-Takes set (the comparable answer of each thread) without re-reading
 *  the journal. */
export interface HeadScore {
  readonly id: HeadId;
  /** The head's finding (its report summary) — the take candidate's text. */
  readonly text: string;
  readonly status: HeadReport['status'];
  /** [0,1] — grounded outcome (execution band when the head ran code, else judge). */
  readonly score: number;
  readonly grounding: 'execution' | 'judge';
}

/** Steps of room the DEFAULT pool gives each head at the widest legal fan-out
 *  — a pool-sizing factor, not a ceiling. The runaway step guard in
 *  head-inference derives from each head's own token budget. */
export const NOMINAL_HEAD_STEPS = 16;

/** Nominal marginal cost of one head step: the head's own output plus the tool
 *  output it pulls in. Two things derive from it — the tighter step cap a small
 *  budget implies (head-inference) and the default pool below. */
export const NOMINAL_STEP_TOKENS = 1_200;

/** Widest fan-out the fork surface accepts (2–6 head specs). The pool is divided
 *  among siblings, so this is the divisor the default has to survive. */
export const MAX_FORK_WIDTH = 6;

/**
 * Default budget for a fresh root head if the parent doesn't specify.
 *
 * `maxTokens` is a subtree pool, divided among siblings on spawn. It is sized so
 * that even at the widest legal fan-out each head still has room for
 * NOMINAL_HEAD_STEPS of nominal-cost work: below that the pool starves a head
 * before it can do the work the split assumed, and a fork returns empty because
 * it was starved rather than because it finished. (The old flat 50_000 gave a
 * 6-wide split 8.3k per head — under half of that room.)
 */
export const DEFAULT_HEAD_BUDGET: Omit<HeadBudget, 'spawnedAt'> = {
  maxDepth: 3,
  maxTokens: MAX_FORK_WIDTH * NOMINAL_HEAD_STEPS * NOMINAL_STEP_TOKENS,
  maxWallClockMs: 5 * 60 * 1000,
};

/** Default merge strategy. */
export const DEFAULT_MERGE_STRATEGY: MergeStrategy = 'synthesize';

/**
 * Split parent's budget among N children. Returns the per-child budget.
 *
 * Defaults: equal token split. Wall-clock is bounded by the parent's REMAINING
 * time, never the parent's full ceiling: the child resets `spawnedAt` to now, so
 * handing it the full `maxWallClockMs` would let a recursive subtree run past the
 * operator's wall-clock ceiling on every level it descends (a 3-deep split could
 * triple it). We cap each child's deadline at the parent's deadline by clamping
 * its wall-clock to the time the parent has left (THINKING-AUDIT §4 #7). Depth is
 * decremented unconditionally.
 */
export function deriveChildBudget(
  parent: HeadBudget,
  n: number,
  split?: BudgetSplit,
  now: number = Date.now(),
): HeadBudget {
  const safeN = Math.max(1, n);
  const tokensRatio = split?.tokensRatio ?? 1 / safeN;
  const wallClockRatio = split?.wallClockRatio ?? 1;
  const parentRemainingMs = Math.max(0, parent.maxWallClockMs - (now - parent.spawnedAt));
  return {
    maxDepth: parent.maxDepth - 1,
    maxTokens: Math.floor(parent.maxTokens * tokensRatio),
    // A child can never outlive the parent's remaining wall-clock, regardless
    // of the requested ratio — the child clock starts fresh at `now`.
    maxWallClockMs: Math.min(
      Math.floor(parent.maxWallClockMs * wallClockRatio),
      parentRemainingMs,
    ),
    spawnedAt: now,
  };
}

/**
 * Returns true if this budget is exhausted along any dimension.
 *
 * `consumedTokens` is the MARGINAL spend of this head + descendants so far —
 * `HeadCapture.tokenUsage.budgetCharged`, not gross provider usage. Passing gross
 * bills the re-sent prompt prefix on every step, which makes the ceiling a
 * function of how long the parent has been running. Omitted (or 0) only checks
 * depth + wall-clock.
 */
export function budgetExhausted(
  b: HeadBudget,
  consumedTokens = 0,
): { exhausted: boolean; reason?: string } {
  if (b.maxDepth <= 0) return { exhausted: true, reason: 'max-depth' };
  if (consumedTokens >= b.maxTokens) return { exhausted: true, reason: 'tokens' };
  if (Date.now() - b.spawnedAt >= b.maxWallClockMs) return { exhausted: true, reason: 'wall-clock' };
  return { exhausted: false };
}
