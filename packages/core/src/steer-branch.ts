/**
 * Steer-as-Branch: a mid-turn redirect runs as one head over a snapshot of the live turn's input, in parallel.
 * When both finish, the pair settles as an Alternate Takes set claimed against the live turn.
 */

import type { SqlExecutor } from './types/primitives';
import type { HeadInput, HeadReport, HeadRunHeadView, SerializedMessage } from './heads/types';
import { forkMission, headStatusUnsettled, storedHeadReportStatus } from './heads/types';
import type { HeadRuntime } from './heads/controller';
import type { HeadJournal } from './heads/journal';
import { recordBranchTakeSet, type AlternateTakeSet } from './mcts/takes';
import { nanoid } from './utils/nanoid';
import { renderThrownChain } from './obs/index';
import { defaultLoopOrigin } from './scaffold/loop-origin';
import type { ActorHandle } from './identity/actor-handle';

/** Depth 1: the branch answers rather than splitting further. */
export const BRANCH_HEAD_BUDGET = {
  maxDepth: 1,
} as const;

export const BRANCH_RATIONALE =
  'User redirected mid-turn — running the redirect as a parallel branch of the live turn.';

export type BranchStatusEvent =
  | { type: 'branch_status'; status: 'running'; branchId: string; task: string }
  | { type: 'branch_status'; status: 'settled'; branchId: string; task: string; takeSetId: string; turnId: string }
  | { type: 'branch_status'; status: 'error'; branchId: string; task: string; message: string };

/** Marks a journaled run as a user redirect rather than an agent fork. */
export const STEER_BRANCH_RUN_ID_PREFIX = 'branch-';

export function newBranchId(): string {
  return `${STEER_BRANCH_RUN_ID_PREFIX}${nanoid(8)}`;
}

export function isSteerBranchRunId(rootId: string): boolean {
  return rootId.startsWith(STEER_BRANCH_RUN_ID_PREFIX);
}

/** Derived from the run id so a chip holding a branchId can open the head's transcript without listing the run. */
export function branchHeadId(rootId: string): string {
  return `${rootId}-head`;
}

export interface BranchStartInput {
  task: string;
  /** Already capped by the backend's readInheritedContext. */
  inheritedContext: SerializedMessage[];
  /** The live turn's mission scope (`MissionGovernor.scope`), read when the owner branches. */
  missionLabels: readonly string[];
  id?: string;
  model?: string;
}

export interface SteerBranchHandle {
  readonly id: string;
  readonly task: string;
  /** Never rejects: a throw resolves errored, or aborted after this handle's abort. */
  readonly result: Promise<HeadReport>;
  abort(reason: string): Promise<void>;
}

/** Throws only when the runtime cannot spawn at all. */
export async function startBranchHead(
  runtime: HeadRuntime,
  journal: HeadJournal,
  input: BranchStartInput,
): Promise<SteerBranchHandle> {
  const rootId = input.id ?? newBranchId();
  const spawnedAt = Date.now();

  const headInput: HeadInput = {
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
    loop: defaultLoopOrigin('head'),
    ...forkMission(input.missionLabels),
  };

  journal.recordSplit(rootId, BRANCH_RATIONALE, spawnedAt);
  journal.insertSpawn(headInput);
  const spawned = await runtime.spawnHead(headInput);
  const stop = new AbortController();

  const result = (async (): Promise<HeadReport> => {
    let report: HeadReport;

    try {
      report = await spawned.run();
    } catch (cause) {
      report = {
        id: headInput.id,
        status: stop.signal.aborted ? 'aborted' : 'errored',
        summary: stop.signal.aborted
          ? `Branch was aborted: ${renderThrownChain({ cause: stop.signal.reason })}`
          : 'Branch failed before producing an answer.',
        evidence: [], decisions: [], artifactRefs: [], fileChanges: [],
        childHeadIds: [], toolCalls: [], stepCount: 0,
        // `{}` rather than zeros: the branch may have spent unreported tokens.
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
    abort: (reason) => {
      // First, so the run's throw sees it.
      stop.abort(new Error(reason));

      return spawned.abort(reason);
    },
  };
}

export type BranchSettleOutcome =
  | { ok: true; set: AlternateTakeSet }
  | { ok: false; reason: string };

export interface PendingBranch {
  readonly id: string;
  readonly task: string;
  readonly handle: Promise<SteerBranchHandle>;
}

export interface BranchSettleDeps {
  sql: SqlExecutor;
  actor: ActorHandle;
  sessionId: string;
  broadcast: (event: BranchStatusEvent) => void;
}

export interface BranchSettlement {
  readonly entry: PendingBranch;
  /** Null when the live turn never completed; the branch is aborted instead. */
  readonly turnId: string | null;
  readonly liveText: string;
  /** Needed on the live path too: unkeyed here plus keyed on recovery would be two take sets for one branch. */
  readonly settlementKey?: string;
}

/** Detached turn-end settle for both backends; a dead live turn aborts the branch instead. */
export async function settlePendingBranch(
  deps: BranchSettleDeps, pending: BranchSettlement,
): Promise<BranchSettleOutcome> {
  const { entry, turnId, liveText, settlementKey } = pending;

  const fail = (reason: string): BranchSettleOutcome => {
    deps.broadcast({
      type: 'branch_status', status: 'error', branchId: entry.id, task: entry.task, message: reason,
    });

    return { ok: false, reason };
  };

  let handle: SteerBranchHandle;

  try {
    handle = await entry.handle;
  } catch (err) {
    return fail(renderThrownChain({ cause: err }));
  }

  if (!turnId || !liveText.trim()) {
    // Broadcast first so the terminal status lands whatever the abort does; an abort rejection propagates.
    const failed = fail('the live turn did not complete, so there is nothing to compare against');
    await handle.abort('the live turn did not complete');

    return failed;
  }

  const report = await handle.result;

  const settlement = {
    task: entry.task, report, turnId, sessionId: deps.sessionId, liveText,
  };

  const outcome = settleBranchIntoTakes(
    deps.sql,
    deps.actor,
    settlementKey === undefined ? settlement : { ...settlement, settlementKey },
  );

  if (!outcome.ok) return fail(outcome.reason);

  deps.broadcast({
    type: 'branch_status', status: 'settled', branchId: entry.id, task: entry.task,
    takeSetId: outcome.set.id, turnId,
  });

  return outcome;
}

/** Narrow so a recovery can settle from the head journal's view, which lacks a full `HeadReport`. */
export type BranchOutcome = Pick<HeadReport, 'status' | 'summary' | 'errorMessage'>;

/**
 * The cold path's only reading of a stored head status. Null means the comparison is still owed.
 * An unknown status reports `errored` rather than owed, so a corrupt row cannot wedge a settlement forever.
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
  /** The steered actor; required because every actor's rows share one database. */
  actor: ActorHandle,
  input: {
    task: string;
    report: BranchOutcome;
    /** Null when the live turn never completed. */
    turnId: string | null;
    sessionId: string;
    liveText: string;
    /** With it a replay finds its first attempt's take set instead of minting a second. */
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
    actor,
    input.settlementKey === undefined
      ? settlement
      : { ...settlement, settlementKey: input.settlementKey },
  );

  if (!set) {
    return { ok: false, reason: 'the branch reached the same answer as the live turn' };
  }

  return { ok: true, set };
}
