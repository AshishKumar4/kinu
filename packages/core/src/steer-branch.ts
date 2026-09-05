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
 * OrchestratorAgent.branchTurn() over SubordinateAgent facets in head mode.
 */

import type { SqlExecutor } from './types/primitives';
import type { HeadInput, HeadReport, HeadRunHeadView, SerializedMessage } from './heads/types';
import { headStatusUnsettled, storedHeadReportStatus } from './heads/types';
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

  const result = (async (): Promise<HeadReport> => {
    let report: HeadReport;
    try {
      report = await raceWithTimeout(spawned, undefined);
    } catch (cause) {
      report = {
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
        errorMessage: renderThrownChain({ cause }),
      };
    }
    journal.recordReport(report);
    return report;
  })();

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
  /** The settlement's durable identity, for a caller that OWES this comparison.
   *  The live path needs it as much as a replay does: an unkeyed write here and a
   *  keyed one on recovery are two take sets for one branch. */
  settlementKey?: string,
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
    // abort does. The detached settle owner records an abort rejection: a head
    // that refuses to abort is a branch still burning tokens, which a discarded
    // rejection would hide.
    fail('the live turn did not complete, so there is nothing to compare against');
    await handle.abort('the live turn did not complete');
    return;
  }
  const report = await handle.result;
  const settlement = {
    task: entry.task, report, turnId, sessionId: deps.sessionId, liveText,
  };
  const outcome = settleBranchIntoTakes(
    deps.sql,
    settlementKey === undefined ? settlement : { ...settlement, settlementKey },
  );
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
 * Settle a finished branch against the finished live turn: persist the pair
 * as a branch-sourced AlternateTakeSet claimed on the live turn's assistant
 * message. Honest failures (errored branch, interrupted live turn, identical
 * answers) yield `{ ok: false, reason }` and write NO takes set.
 */
/**
 * The three fields the take comparison actually reads.
 *
 * Named because a RECOVERY settles a branch from the head journal's own view —
 * the only record of a head whose live handle died with its isolate — and a
 * signature demanding a whole `HeadReport` forced that caller to invent the
 * fields it does not have. `HeadReport` satisfies this, so the live path is
 * unchanged.
 */
export type BranchOutcome = Pick<HeadReport, 'status' | 'summary' | 'errorMessage'>;

/**
 * Read a branch head's journal row as the outcome a settlement needs, or null
 * while that row is still claiming to execute.
 *
 * THE COLD PATH'S ONLY READING OF A STORED STATUS, and it exists because both
 * backends wrote their own. A cold replay settles a branch from the journal —
 * the sole record of a head whose live handle died with its isolate — and it has
 * to decide two things from one `TEXT` column: whether the comparison is still
 * owed, and which terminal status to report when it is not. Both copies decided
 * the first with a hand-written list and the second with `status === 'completed'
 * ? 'completed' : 'errored'`, so a head that blew its budget was reported as
 * having thrown, and the two backends had already drifted on how they carry
 * `errorMessage`.
 *
 * Null means OWED and never means "settled": the two unsettled statuses are the
 * only ones a later activation can still change, and neither is permanent — the
 * resume gate re-drives the run, or `abandonRunning` settles it `aborted`. A
 * status this journal never writes is reported `errored` rather than owed, so a
 * corrupt row cannot wedge a settlement forever.
 */
export function branchOutcomeFromJournal(
  head: Pick<HeadRunHeadView, 'status' | 'summary' | 'errorMessage'>,
): BranchOutcome | null {
  if (headStatusUnsettled(head.status)) return null;
  const summary = head.summary ?? '';
  const status = storedHeadReportStatus(head.status);
  if (status === null) {
    return {
      status: 'errored',
      summary,
      errorMessage: head.errorMessage
        ?? `the branch head's journal row carries an unrecognized status "${head.status}"`,
    };
  }
  return head.errorMessage === null
    ? { status, summary }
    : { status, summary, errorMessage: head.errorMessage };
}

export function settleBranchIntoTakes(
  sql: SqlExecutor,
  input: {
    task: string;
    report: BranchOutcome;
    /** The live turn's assistant message id, or null when it never completed. */
    turnId: string | null;
    sessionId: string;
    /** The live turn's full answer text. */
    liveText: string;
    /** The settlement's durable identity, for a caller that OWES this comparison
     *  and may run it again. With it the take set is written once: a replay finds
     *  the set its first attempt produced instead of minting a second. */
    settlementKey?: string;
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
  const settlement = {
    task: input.task,
    turnId: input.turnId,
    sessionId: input.sessionId,
    liveText: input.liveText,
    branchText: input.report.summary,
    now: input.now,
  };
  const set = recordBranchTakeSet(
    sql,
    input.settlementKey === undefined
      ? settlement
      : { ...settlement, settlementKey: input.settlementKey },
  );
  if (!set) {
    return { ok: false, reason: 'the branch reached the same answer as the live turn' };
  }
  return { ok: true, set };
}
