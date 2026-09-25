/**
 * Branching heads: a head is a fork of the agent's working state that sees the whole conversation,
 * does real work as a claimed actor turn, may split recursively under a depth budget, and merges
 * back via LLM synthesis.
 */

import type { ToolCallRecord } from '../evolution/types';
import type { HeadFileChange, HeadFileChangeSet, HeadId, SerializedMessage } from '../types/heads';
import type { EvaluationGrounding } from '../types/evaluation';
import type { Usage } from '../usage';
import type { BuiltinToolName } from '../tools/registry';
import type { LoopOrigin } from '../scaffold/loop-origin';
import type { MessageReference, MessagePartReference } from '../session/messages';

export type { HeadFileChange, HeadFileChangeSet, HeadId, SerializedMessage };

export type MergeStrategy =
  | 'synthesize'   // unify into one coherent narrative (default)
  | 'best_of'      // pick the strongest single head; cite weaker ones briefly
  | 'consensus';   // emphasize areas of agreement; surface disagreements

/**
 * A head gets its parent's envelope: no token pool, no wall clock. Cost is governed by the
 * mission budget governor (mission-budget.ts). `maxDepth` terminates recursion; it refuses new splits only.
 */
export interface HeadBudget {
  /** Decremented per spawn. 0 rejects splits. */
  readonly maxDepth: number;
  readonly spawnedAt: number;
}

export interface HeadInput {
  readonly id: HeadId;
  readonly rootId: HeadId;                 // root of the split tree (== id if this is a root)
  readonly parentId: HeadId | null;        // null only for the root head
  readonly depth: number;                  // 0 for root, +1 per spawn
  readonly task: string;
  readonly mode: WorkMode;                 // inherited mutation boundary
  readonly rationale: string;
  readonly inheritedContext: SerializedMessage[];
  readonly budget: HeadBudget;
  readonly model?: string;
  /** Empty = none. Undefined = all. */
  readonly allowedTools?: readonly string[];
  /** Mission-budget labels, as strings because this input crosses a facet boundary. Absent or empty: unbudgeted, nothing is asked.
   *  Set only by {@link forkMission}. */
  readonly missionLabels?: readonly string[];
  /** Always stated, never inferred; a head's default is `inherit` (`defaultLoopOrigin`). */
  readonly loop: LoopOrigin;
  readonly mergeStrategy: MergeStrategy;
}

export interface Evidence {
  readonly id: string;
  readonly kind: 'tool_output' | 'fact' | 'citation' | 'artifact';
  readonly body: string;
  readonly ref?: string;
  /** 0..1, self-reported; the merge weights contributions by it. */
  readonly confidence?: number;
}

export interface Decision {
  readonly question: string;
  readonly choice: string;
  readonly rationale: string;
  readonly supportingEvidence?: readonly string[];
}

export interface ArtifactRef {
  readonly kind: 'file' | 'port' | 'memory' | 'note';
  readonly ref: string;
  readonly description?: string;
}

export interface HeadStepToolCall {
  readonly toolCallId?: string;
  readonly name: string;
  readonly input?: unknown;
  readonly output?: unknown;
}

export interface HeadStep {
  readonly text: string;
  readonly reasoning?: string;
  readonly toolCalls: readonly HeadStepToolCall[];
}

/** Every terminal status of a head run; readers classifying a `TEXT` column must handle all four, not `completed` versus the rest. */
const HEAD_REPORT_STATUSES = ['completed', 'budget_exceeded', 'aborted', 'errored'] as const;

export type HeadReportStatus = (typeof HEAD_REPORT_STATUSES)[number];

/** Non-terminal journal statuses, the complement of {@link HEAD_REPORT_STATUSES}; the resume gate re-drives or `abandonRunning` settles them. */
const HEAD_UNSETTLED_STATUSES = ['running', 'interrupted'] as const;

export type HeadUnsettledStatus = (typeof HEAD_UNSETTLED_STATUSES)[number];

export function headStatusUnsettled(status: string): status is HeadUnsettledStatus {
  return HEAD_UNSETTLED_STATUSES.some((unsettled) => unsettled === status);
}

/** Null for an unsettled row and for an unknown value; ask {@link headStatusUnsettled} to tell them apart. */
export function storedHeadReportStatus(status: string): HeadReportStatus | null {
  return HEAD_REPORT_STATUSES.find((reported) => reported === status) ?? null;
}

export interface HeadReport {
  readonly id: HeadId;
  readonly canonicalCompletion?: { readonly turnId: string; readonly runId: string; readonly outputReferences: readonly MessageReference[]; readonly outputPartReferences: readonly MessagePartReference[]; readonly finalTextReference: MessagePartReference | null };
  readonly status: HeadReportStatus;
  /** 2-4 sentence finding; used in the merge prompt. */
  readonly summary: string;
  readonly evidence: readonly Evidence[];
  readonly decisions: readonly Decision[];
  readonly artifactRefs: readonly ArtifactRef[];
  /** Changes on the shared planes, attributed at the head's own file plane (see heads/file-changes.ts). */
  readonly fileChanges: readonly HeadFileChange[];
  readonly childHeadIds: readonly HeadId[];
  readonly toolCalls: readonly ToolCallRecord[];
  /** The trace is not carried: steps are journalled live via `reportStep`, and a late empty report must not erase them. */
  readonly stepCount: number;
  /** Absent fields mean the provider said nothing; no scalar total is stored (use `usageTotal`). */
  readonly usage: Usage;
  readonly wallClockMs: number;
  readonly errorMessage?: string;
}

/**
 * One head as the Exploration surface renders it (HeadJournal.assembleRun). The trace is deliberately
 * absent to keep run views small; one branch's trace is read via {@link HeadJournal.readSteps}.
 */
export interface HeadRunHeadView {
  readonly id: HeadId;
  /** The journalled parent edge; null for a top-level split's head or a run with no edge recorded. */
  readonly parentId: HeadId | null;
  readonly depth: number;
  readonly task: string;
  readonly rationale: string;
  readonly status: string;
  readonly summary: string | null;
  readonly errorMessage: string | null;
  /** A field is absent when its column is NULL (never reported); never rendered as 0. */
  readonly usage: Usage;
  /** 0 while the head runs; in-flight timing uses `spawnedAt`. */
  readonly wallClockMs: number;
  readonly spawnedAt: number;
  readonly lastStepAt: number | null;
  readonly decisions: ReadonlyArray<{ question: string; choice: string; rationale: string }>;
}

export interface HeadRunView {
  readonly rootId: HeadId;
  readonly task: string;
  readonly rationale: string;
  readonly status: string;
  readonly spawnedAt: number;
  readonly heads: readonly HeadRunHeadView[];
  /** Null when no head reported any; never substituted with 0. */
  readonly merge: { narrative: string; headCount: number; totalTokens: number | null } | null;
}

/**
 * A head charges the mission of the turn that started its tree: a steer branch the scope the live turn runs
 * under, a split's children their parent's. An unscoped turn leaves the key absent, so its heads never reach
 * the ledger.
 */
export function forkMission(labels: readonly string[] | undefined): Pick<HeadInput, 'missionLabels'> {
  return labels === undefined || labels.length === 0 ? {} : { missionLabels: [...labels] };
}

export interface SplitRequest {
  readonly rationale: string;
  readonly heads: readonly {
    readonly task: string;
    readonly rationale: string;
    /** Per-head provider/model spec (e.g. `codex/gpt-5.5`). */
    readonly model?: string;
    readonly allowedTools?: readonly string[];
  }[];
  readonly mergeStrategy?: MergeStrategy;
}

export interface MergeResult {
  readonly mergedNarrative: string;
  readonly selectedDecisions: readonly Decision[];
  readonly unresolvedQuestions: readonly string[];
  readonly recommendations: readonly string[];
  /** Ground no head covered, distinct from unresolvedQuestions. Empty on the empty-split and merge-fallback paths. */
  readonly blindSpots: readonly string[];
  readonly evidenceAggregate: readonly Evidence[];
  /** Root-level only, not recursive. */
  readonly headIds: readonly HeadId[];
  /** One entry per head, for Alternate-Takes and the preference ledger; neutral 0.5 when ungrounded. */
  readonly headScores: readonly HeadScore[];
  /** Only heads that changed something appear. */
  readonly fileChanges: readonly HeadFileChangeSet[];
  readonly grounded: boolean;
  readonly costSummary: {
    readonly headCount: number;
    /** Heads that banked a finding (headProducedFindings). */
    readonly headsWithFindings: number;
    /** Undefined when no head reported any: unknown cost, not zero. */
    readonly totalTokens: number | undefined;
    readonly totalWallClockMs: number;
    readonly maxDepth: number;
  };
}

/** Mirrors MCTS BranchEvaluation (evaluation.ts). */
export interface HeadScore {
  readonly id: HeadId;
  readonly text: string;
  readonly status: HeadReport['status'];
  /** [0,1]: execution band when the head ran code, else judge. */
  readonly score: number;
  readonly grounding: EvaluationGrounding;
}

export const DEFAULT_MERGE_STRATEGY: MergeStrategy = 'synthesize';

export function deriveChildBudget(parent: HeadBudget, now: number = Date.now()): HeadBudget {
  return { maxDepth: parent.maxDepth - 1, spawnedAt: now };
}

import type { WorkMode } from '../types/turn';

/** `memory` and `skills` are withheld because they would address head-private stores. */
export const HEAD_BUILTIN_TOOLS = ['eval', 'shell', 'file', 'web'] as const satisfies readonly BuiltinToolName[];

