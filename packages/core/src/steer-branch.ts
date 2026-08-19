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

import type { SqlExecutor } from './types/primitives';
import type { HeadInput, HeadReport, SerializedMessage } from './heads/types';
import { raceWithTimeout, type HeadRuntime } from './heads/controller';
import type { HeadJournal } from './heads/journal';
import { recordBranchTakeSet, type AlternateTakeSet } from './mcts/takes';
import { nanoid } from './utils/nanoid';
import { renderThrownChain } from './obs/index';

/** A branch is one head answering one redirect: depth 1, so it answers rather
 *  than splitting further. Like any head it runs until it is done — the settle
 *  is detached, so a branch that takes its time holds up nothing. */
export const BRANCH_HEAD_BUDGET = {
  maxDepth: 1,
} as const;

export const BRANCH_RATIONALE =
  'User redirected mid-turn — running the redirect as a parallel branch of the live turn.';

/** The progress event both backends broadcast (web chip, TUI status segment).
 *  Compatible with BroadcastEvent's `{ type: string; … }` shape. */
export type BranchStatusEvent =
  | { type: 'branch_status'; status: 'running'; branchId: string; task: string }
  | { type: 'branch_status'; status: 'settled'; branchId: string; task: string; takeSetId: string; turnId: string }
  | { type: 'branch_status'; status: 'error'; branchId: string; task: string; message: string };

/** The id prefix that marks a journaled run as a user redirect rather than an
 *  agent fork. This module is its only writer, so the prefix and the predicate
 *  that reads it stay together. */
export const STEER_BRANCH_RUN_ID_PREFIX = 'branch-';

export function newBranchId(): string {
  return `${STEER_BRANCH_RUN_ID_PREFIX}${nanoid(8)}`;
}

/** Whether a head-run root id belongs to Steer-as-Branch. The fork-run read
 *  model asks this so a mid-turn redirect never lists as a fork the agent
 *  chose to make. */
export function isSteerBranchRunId(rootId: string): boolean {
  return rootId.startsWith(STEER_BRANCH_RUN_ID_PREFIX);
}

/** The single head a Steer-as-Branch run spawns, addressed from the run id
 *  alone — what a chat chip holding a branchId needs to open that head's
 *  transcript. Three call sites (the spawn, the chip, the tests) must agree on
 *  it, so it is a name rather than a repeated template. */
export function branchHeadId(rootId: string): string {
  return `${rootId}-head`;
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
 * Spawn + run the redirect as a single head. Journaled like any head run (its
 * trace shows up on the Exploration surface). Throws only when the runtime cannot
 * spawn at all.
 */
export async function startBranchHead(
  runtime: HeadRuntime,
  journal: HeadJournal,
  input: BranchStartInput,
): Promise<SteerBranchHandle> {
  const rootId = input.id ?? newBranchId();
  const spawnedAt = Date.now();
  const headInput: HeadInput = {
    // DERIVED from the run id, not random: a branch run has exactly one head
    // and `rootId` is already unique, so the surface that holds a branchId can
    // read that head's transcript (getNodeTranscript) without first listing the
    // run to discover a random id.
    id: branchHeadId(rootId),
    rootId,
    parentId: null,
    depth: 0,
    task: input.task,
    mode: 'build',
    rationale: BRANCH_RATIONALE,
    inheritedContext: input.inheritedContext,
    budget: { ...BRANCH_HEAD_BUDGET, spawnedAt },
    model: input.model,
    mergeStrategy: 'best_of',
  };
  journal.recordSplit(rootId, BRANCH_RATIONALE, spawnedAt);
  journal.insertSpawn(headInput);
  const spawned = await runtime.spawnHead(headInput);

  const result = raceWithTimeout(spawned, undefined)
    .catch((err): HeadReport => ({
      id: headInput.id,
      status: 'budget_exceeded',
      summary: 'Branch was aborted before producing an answer.',
      evidence: [], decisions: [], artifactRefs: [], fileChanges: [],
      childHeadIds: [], toolCalls: [], stepCount: 0,
      // Aborted before it produced anything, so nothing was reported. `{}`
      // rather than zeros: the branch may have spent real tokens first, and
      // recording it as free is a claim nobody measured.
      usage: {},
      wallClockMs: Date.now() - spawnedAt,
      errorMessage: renderThrownChain({ cause: err }),
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
 * (`turnId` null / empty answer) aborts the branch instead.
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
    fail(renderThrownChain({ cause: err }));
    return;
  }
  if (!turnId || !liveText.trim()) {
    // Broadcast before aborting, so the terminal status lands whatever the
    // abort does, and the abort itself is then left unguarded: a head that
    // refuses to abort is a branch still burning tokens, which is exactly the
    // failure the discarded rejection used to hide.
    fail('the live turn did not complete, so there is nothing to compare against');
    await handle.abort('the live turn did not complete');
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
