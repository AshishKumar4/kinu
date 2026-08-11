/**
 * Steer-as-Branch — typing while a turn runs can BRANCH instead of steering:
 * the redirect runs as ONE budgeted head against a snapshot of the live
 * turn's input conversation, in parallel, without touching the live turn.
 * When both finish, the pair settles into the Alternate Takes pipeline
 * (recordBranchTakeSet) claimed against the live turn — the existing
 * comparison + pick→outcome-ledger flow takes over unchanged.
 *
 * This module owns the single-head run (over the SAME HeadRuntime seam the
 * agents fork uses, journaled like any head run) and the
 * settle step. Both backends drive it: LocalAgentSession.branch() in-process,
 * OrchestratorAgent.branchTurn() over ExplorationAgent Facets.
 */

import type { SqlExecutor } from './types/primitives.js';
import type { HeadInput, HeadReport, SerializedMessage } from './heads/types.js';
import { raceWithTimeout, type HeadRuntime } from './heads/controller.js';
import type { HeadJournal } from './heads/journal.js';
import { recordBranchTakeSet, type AlternateTakeSet } from './mcts/takes.js';
import { nanoid } from './utils/nanoid.js';

/** A branch is one head answering one redirect — no recursive splits, and a
 *  tighter budget than a full agents fork run. */
export const BRANCH_HEAD_BUDGET = {
  maxDepth: 1,
  maxTokens: 16_000,
  maxWallClockMs: 120_000,
} as const;

export const BRANCH_RATIONALE =
  'User redirected mid-turn — running the redirect as a parallel branch of the live turn.';

/** The progress event both backends broadcast (web chip, TUI status segment).
 *  Compatible with BroadcastEvent's `{ type: string; … }` shape. */
export type BranchStatusEvent =
  | { type: 'branch_status'; status: 'running'; branchId: string; task: string }
  | { type: 'branch_status'; status: 'settled'; branchId: string; task: string; takeSetId: string; turnId: string }
  | { type: 'branch_status'; status: 'error'; branchId: string; task: string; message: string };

export function newBranchId(): string {
  return `branch-${nanoid(8)}`;
}

export interface BranchStartInput {
  /** The user's mid-turn redirect — the head's task. */
  task: string;
  /** Snapshot of the live turn's input conversation (already capped by the
   *  backend's readInheritedContext). */
  inheritedContext: SerializedMessage[];
  /** Stable id for progress events; generated when omitted. */
  id?: string;
  /** Per-run model spec override (runtime default when omitted). */
  model?: string;
}

export interface SteerBranchHandle {
  readonly id: string;
  readonly task: string;
  /** Resolves with the head's report — never rejects (timeouts and inference
   *  failures come back as budget_exceeded / errored reports). */
  readonly result: Promise<HeadReport>;
  /** Best-effort abort — used when the live turn dies before settling. */
  abort(reason: string): Promise<void>;
}

/**
 * Spawn + run the redirect as a single budgeted head. Journaled like any head
 * run (its trace shows up on the Reasoning surface), raced against the branch
 * wall-clock. Throws only when the runtime cannot spawn at all.
 */
export async function startBranchHead(
  runtime: HeadRuntime,
  journal: HeadJournal,
  input: BranchStartInput,
): Promise<SteerBranchHandle> {
  const rootId = input.id ?? newBranchId();
  const spawnedAt = Date.now();
  const headInput: HeadInput = {
    id: `${rootId}-d1-0-${nanoid(6)}`,
    rootId,
    parentId: null,
    depth: 0,
    task: input.task,
    rationale: BRANCH_RATIONALE,
    inheritedContext: input.inheritedContext,
    budget: { ...BRANCH_HEAD_BUDGET, spawnedAt },
    model: input.model,
    mergeStrategy: 'best_of',
  };
  journal.recordSplit(rootId, BRANCH_RATIONALE, spawnedAt);
  journal.insertSpawn(headInput);
  const spawned = await runtime.spawnHead(headInput);

  const result = raceWithTimeout(spawned, BRANCH_HEAD_BUDGET.maxWallClockMs)
    .catch((err): HeadReport => ({
      id: headInput.id,
      status: 'budget_exceeded',
      summary: 'Branch was aborted before producing an answer (wall-clock budget exceeded).',
      evidence: [], decisions: [], artifactRefs: [], childHeadIds: [], toolCalls: [], steps: [],
      tokenUsage: { input: 0, output: 0, total: 0 },
      wallClockMs: Date.now() - spawnedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
    }))
    .then((report) => {
      journal.recordReport(report);
      return report;
    });

  return {
    id: rootId,
    task: input.task,
    result,
    abort: (reason) => spawned.abort(reason),
  };
}

export type BranchSettleOutcome =
  | { ok: true; set: AlternateTakeSet }
  | { ok: false; reason: string };

/** A branch launched against an in-flight turn, awaiting that turn's end. */
export interface PendingBranch {
  readonly id: string;
  readonly task: string;
  readonly handle: Promise<SteerBranchHandle>;
}

/**
 * The shared both-sides settle both backends run (detached) at turn end:
 * await the branch head, compare against the finished live turn, persist the
 * takes set, and broadcast the terminal branch_status. A dead live turn
 * (`turnId` null / empty answer) aborts the branch instead. Never throws.
 */
export async function settlePendingBranch(
  deps: {
    sql: SqlExecutor;
    sessionId: string;
    broadcast: (event: BranchStatusEvent) => void;
  },
  entry: PendingBranch,
  turnId: string | null,
  liveText: string,
): Promise<void> {
  const fail = (message: string) => deps.broadcast({
    type: 'branch_status', status: 'error', branchId: entry.id, task: entry.task, message,
  });
  let handle: SteerBranchHandle;
  try {
    handle = await entry.handle;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return;
  }
  if (!turnId || !liveText.trim()) {
    await handle.abort('the live turn did not complete').catch(() => {});
    fail('the live turn did not complete, so there is nothing to compare against');
    return;
  }
  const report = await handle.result;
  const outcome = settleBranchIntoTakes(deps.sql, {
    task: entry.task, report, turnId, sessionId: deps.sessionId, liveText,
  });
  if (outcome.ok) {
    deps.broadcast({
      type: 'branch_status', status: 'settled', branchId: entry.id, task: entry.task,
      takeSetId: outcome.set.id, turnId,
    });
  } else {
    fail(outcome.reason);
  }
}

/**
 * Settle every branch launched during the just-finished turn, draining the
 * pending list as it goes.
 *
 * Detached per branch: a slow head must never hold up the turn queue that is
 * already free to take the next message. Draining is the reason this is one
 * function rather than a loop at each call site — a branch left in the list
 * would be settled a second time against the NEXT turn's answer.
 */
export function settlePendingBranches(
  deps: {
    sql: SqlExecutor;
    sessionId: string;
    broadcast: (event: BranchStatusEvent) => void;
  },
  pending: PendingBranch[],
  turnId: string | null,
  liveText: string,
): void {
  for (const entry of pending.splice(0)) {
    void settlePendingBranch(deps, entry, turnId, liveText);
  }
}

/**
 * Settle a finished branch against the finished live turn: persist the pair
 * as a branch-sourced AlternateTakeSet claimed on the live turn's assistant
 * message. Honest failures (errored branch, interrupted live turn, identical
 * answers) yield `{ ok: false, reason }` and write NO takes set.
 */
export function settleBranchIntoTakes(
  sql: SqlExecutor,
  input: {
    task: string;
    report: HeadReport;
    /** The live turn's assistant message id, or null when it never completed. */
    turnId: string | null;
    sessionId: string;
    /** The live turn's full answer text. */
    liveText: string;
    now?: number;
  },
): BranchSettleOutcome {
  if (input.report.status !== 'completed') {
    return {
      ok: false,
      reason: input.report.errorMessage
        ?? `the branch ended with status "${input.report.status}"`,
    };
  }
  if (!input.report.summary.trim()) {
    return { ok: false, reason: 'the branch produced no answer' };
  }
  if (!input.turnId || !input.liveText.trim()) {
    return { ok: false, reason: 'the live turn did not complete, so there is nothing to compare against' };
  }
  const set = recordBranchTakeSet(sql, {
    task: input.task,
    turnId: input.turnId,
    sessionId: input.sessionId,
    liveText: input.liveText,
    branchText: input.report.summary,
    now: input.now,
  });
  if (!set) {
    return { ok: false, reason: 'the branch reached the same answer as the live turn' };
  }
  return { ok: true, set };
}
