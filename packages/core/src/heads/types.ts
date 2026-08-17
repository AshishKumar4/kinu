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
import type { HeadFileChange } from './file-changes.js';
import type { EvaluationGrounding } from '../types/evaluation.js';
import type { Usage } from '../usage.js';

/** What a head did to the shared filesystem — see heads/file-changes.ts. */
export type { HeadFileChange };

/** Opaque head identifier — kebab-case string, globally unique within a turn. */
export type HeadId = string;

/** What kind of merging the parent wants — drives the merge prompt. */
export type MergeStrategy =
  | 'synthesize'   // unify into one coherent narrative (default)
  | 'best_of'      // pick the strongest single head; cite weaker ones briefly
  | 'consensus';   // emphasize areas of agreement; surface disagreements

/**
 * What propagates down the head tree.
 *
 * A head is a FORK of its parent — the same workspace, files and sandbox — so it
 * gets the same working envelope its parent turn gets: run until the work is
 * done. There is no token pool and no wall clock by default. Cost is governed
 * where cost is actually owned: the mission budget governor (mission-budget.ts),
 * which is label-scoped, opt-in, and enforced at the spawn and model-call seams.
 *
 * The two fields here are not work limits:
 *   • `maxDepth` terminates RECURSION. `split_subheads` lets a head spawn heads
 *     that spawn heads; without a decrementing depth there is no fixed point and
 *     a single fork call can expand without bound. It never stops a running
 *     head — it refuses a NEW split.
 *   • `maxWallClockMs` is undefined unless a caller explicitly asks for one
 *     (`agents` fork `wall_clock_ms`). Opt-in, never a default.
 */
export interface HeadBudget {
  /** Remaining recursive-split depth; decremented per spawn. 0 rejects splits. */
  readonly maxDepth: number;
  /** Caller-requested wall-clock ceiling in ms. Undefined = run to completion. */
  readonly maxWallClockMs?: number;
  /** Epoch ms when the head was spawned; used for wall-clock enforcement. */
  readonly spawnedAt: number;
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
  readonly mode: WorkMode;                 // inherited mutation boundary
  readonly rationale: string;              // why this head was spawned (carried for merge prompt)
  readonly inheritedContext: SerializedMessage[];
  readonly budget: HeadBudget;
  /** The model to use for this head — usually the same as the parent's. */
  readonly model?: string;
  /** Names of crafted tools this head may invoke. Empty = none. Undefined = all. */
  readonly allowedTools?: readonly string[];
  /**
   * The mission-budget labels this head's model calls charge, carried down so a
   * head running in another process can find the ledger its spend belongs to.
   *
   * Strings, not a port: this input crosses a facet boundary as structured
   * data, and the boundary is exactly why the labels have to travel at all.
   * The runtime on the far side turns them back into a
   * {@link import('../mission-budget.js').MissionScope} over whatever reaches
   * the ledger from there.
   *
   * Absent or empty means unbudgeted — the default, and then nothing is asked:
   * no query, no RPC, no refusal.
   */
  readonly missionLabels?: readonly string[];
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

/** One head's change set as the merge payload carries it. Heads that changed
 *  nothing are absent rather than present-and-empty: a fork that touched no
 *  files has nothing to report, and an empty row would still print a heading. */
export interface HeadFileChangeSet {
  readonly id: HeadId;
  readonly changes: readonly HeadFileChange[];
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
  /** Files this head created, changed or deleted on the SHARED planes, with
   *  line counts — the review a parent gets of what its child actually did.
   *  Attributed at the head's own file plane, which is why a concurrent sibling
   *  cannot appear here; see heads/file-changes.ts for what that leaves out. */
  readonly fileChanges: readonly HeadFileChange[];
  /** Heads this one spawned (already merged before returning). */
  readonly childHeadIds: readonly HeadId[];
  /** Tool calls the head made — for telemetry. */
  readonly toolCalls: readonly ToolCallRecord[];
  /** How many steps the head took. The trace itself is NOT carried here: a
   *  head writes each step to its journal as it finishes it (HeadInferenceDeps
   *  .reportStep), so the branch is readable while it is still running rather
   *  than only once this report exists. Returning the trace as well would ship
   *  the same rows twice and let a late empty report erase a live one. */
  readonly stepCount: number;
  /** What this head's provider calls reported, accumulated. Absent fields mean
   *  the provider said nothing — a head aborted before its first call carries
   *  `{}`, not a set of zeros. Callers wanting one number call `usageTotal`,
   *  which answers `undefined` for exactly that case; no scalar total is stored
   *  here because it could only ever drift from its own parts. */
  readonly usage: Usage;
  readonly wallClockMs: number;
  /** Free-form failure message if status != 'completed'. */
  readonly errorMessage?: string;
}

/**
 * One head as the Exploration surface renders it — lifecycle, liveness, and
 * the ordered trace. Assembled by HeadJournal.assembleRun.
 *
 * `spawnedAt` and `lastStepAt` are what make a RUNNING branch legible. Without
 * them the surface could only say "no steps", which reads as lost data; with
 * them it can say "started 3s ago, nothing yet" or "4 steps, last one 6 minutes
 * ago" — the difference between a head that is working and a head that is
 * wedged on a call that never answers.
 */
export interface HeadRunHeadView {
  readonly id: HeadId;
  readonly task: string;
  readonly rationale: string;
  readonly status: string;
  readonly summary: string | null;
  readonly errorMessage: string | null;
  /** This head's tokens as the journal stored them. A field is absent when its
   *  column is NULL, which is what a head that never reported looks like —
   *  distinct from a head that reported zero, and never rendered as 0. */
  readonly usage: Usage;
  /** Measured wall clock, written with the report. 0 while the head runs —
   *  `spawnedAt` is what an in-flight branch is timed from. */
  readonly wallClockMs: number;
  readonly spawnedAt: number;
  /** When the head last recorded a step, or null when it has recorded none. */
  readonly lastStepAt: number | null;
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
  /** `totalTokens` is null when no head in the run reported any — the SQL
   *  column's own absence crossing the seam, deliberately spelled `null` here
   *  rather than as an absent key because this whole view is a row read. Domain
   *  types spell the same absence by omitting the field; what neither may do is
   *  substitute 0, which is the claim that the split was free. */
  readonly merge: { narrative: string; headCount: number; totalTokens: number | null } | null;
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
    maxWallClockMs: number;
  }>;
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
  /** Ground NO head covered — the negative space of the split. Distinct from
   *  unresolvedQuestions, which the heads themselves raised: a blind spot is
   *  something none of them thought to look at, so nothing in their reports
   *  points at it. Empty when the heads between them covered the task, and
   *  empty on the deterministic empty-split and merge-fallback paths, which
   *  have no synthesis to draw it from. */
  readonly blindSpots: readonly string[];
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
  /** Which files each head created, changed or deleted — the review of the
   *  split's actual effect on the shared workspace, per head, with line counts.
   *  Only heads that changed something appear. */
  readonly fileChanges: readonly HeadFileChangeSet[];
  /** True when headScores carry a real grounded verdict (the controller had a
   *  grounding seam); false when they are neutral placeholders. */
  readonly grounded: boolean;
  readonly costSummary: {
    readonly headCount: number;
    /** How many of those heads actually banked a finding (headProducedFindings).
     *  `headCount - headsWithFindings` is how many forks came back empty — the
     *  one number that says whether a delegation was worth its tokens. */
    readonly headsWithFindings: number;
    /** Every head's tokens, or undefined when NO head reported any — a split
     *  whose heads all died before their first provider call did not cost zero
     *  tokens, it cost an unknown number, and claiming 0 is what let a failed
     *  delegation look free. */
    readonly totalTokens: number | undefined;
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
  readonly grounding: EvaluationGrounding;
}

/**
 * What a fresh root head inherits when the parent names nothing: recursion room
 * and nothing else. No token pool, no clock — a fork works until the work is
 * done, exactly like the turn it forked from.
 */
export const DEFAULT_HEAD_BUDGET: Omit<HeadBudget, 'spawnedAt'> = {
  maxDepth: 3,
};

/** Default merge strategy. */
export const DEFAULT_MERGE_STRATEGY: MergeStrategy = 'synthesize';

/**
 * The budget a child head inherits from its parent.
 *
 * Depth decrements — that is the whole point of it. A caller-requested
 * wall-clock is bounded by the parent's REMAINING time rather than re-granted in
 * full: the child resets `spawnedAt` to now, so handing it the parent's whole
 * ceiling would let a recursive subtree run past the deadline the caller asked
 * for, once per level it descends (THINKING-AUDIT §4 #7). With no wall clock
 * requested there is nothing to clamp and the child, like the parent, just runs.
 */
export function deriveChildBudget(parent: HeadBudget, now: number = Date.now()): HeadBudget {
  if (parent.maxWallClockMs === undefined) {
    return { maxDepth: parent.maxDepth - 1, spawnedAt: now };
  }
  return {
    maxDepth: parent.maxDepth - 1,
    maxWallClockMs: Math.max(0, parent.maxWallClockMs - (now - parent.spawnedAt)),
    spawnedAt: now,
  };
}

/**
 * Whether this head may still spawn, and whether a requested deadline has passed.
 *
 * Only two things can be spent: recursion depth, and the wall-clock a caller
 * explicitly asked for. There is no token dimension — cumulative spend is the
 * mission budget governor's job (mission-budget.ts), which owns a real ledger
 * across a whole mission instead of a per-head pool that starves a fork before
 * it can do the work the split assumed.
 */
export function budgetExhausted(b: HeadBudget) {
  if (b.maxDepth <= 0) return { exhausted: true, reason: 'max-depth' };
  if (b.maxWallClockMs !== undefined && Date.now() - b.spawnedAt >= b.maxWallClockMs) {
    return { exhausted: true, reason: 'wall-clock' };
  }
  return { exhausted: false };
}
import type { WorkMode } from '../prompting/surface.js';
