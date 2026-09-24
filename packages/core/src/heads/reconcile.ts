/**
 * Start-of-life reconciliation for the fork journal. A `running` row is stale at activation start:
 * it is settled (`HeadJournal.abandonRunning`) and the agent is told through the one inbox (`AgentInbox`).
 */

import type { RunEventInput } from '../events/types';
import type { MctsSearchStore } from '../mcts/search-store';
import type { AgentInbox } from '../types/signals';
import type { AbandonedHeadRun, HeadJournal } from './journal';
import * as v from 'valibot';
import { diagnostics, toKinuError, tolerate } from '../obs/index';
import { parseJsonValue } from '../utils/json';

/** Structural so core's heads layer does not depend on the recorder class. */
export interface RunEventLedger {
  runForHeadSplit(rootId: string): string | null;
  unterminatedRuns(window?: number, startedBefore?: number): string[];
  emit(runId: string, input: RunEventInput): void;
}

/** `interrupted`, not `evicted`: the ledger cannot tell eviction from exit or crash. */
const RUN_INTERRUPTED_REASON = 'interrupted';

/**
 * The resume gate: re-drive durable jobs a dead activation left and name the fork runs they re-enter.
 * Joined on the task, the key `findRunningSwarms` and `findResumableRun` already use. A job is never
 * given up on an interruption count (`BackgroundJobRunner.recoverJob`).
 */
export function jobRedriveResumeGate(deps: {
  /** `BackgroundJobRunner.recoverOrphans`. */
  readonly recoverOrphans: () => Promise<readonly { readonly id: string }[]>;
  readonly inputOf: (jobId: string) => string | null;
  readonly rootsForTask: (task: string) => readonly string[];
}): (roots: readonly string[]) => Promise<readonly string[]> {
  return async (offered) => {
    const redriven = await deps.recoverOrphans();

    if (redriven.length === 0) return [];
    const offeredRoots = new Set(offered);
    const claimed = new Set<string>();

    for (const job of redriven) {
      for (const root of deps.rootsForTask(taskOf(deps.inputOf(job.id)))) {
        // A re-drive of another task's job must not vouch for a root nobody asked about.
        if (offeredRoots.has(root)) claimed.add(root);
      }
    }

    return [...claimed];
  };
}

/** Only the task, loosely: job rows are durable history written by any past tool shape. */
const ResumableJobInputSchema = v.looseObject({ task: v.optional(v.string()) });

/** Malformed JSON reads as no task; any other failure rethrows rather than dropping the job from the gate. */
function taskOf(input: string | null): string {
  if (input === null) return '';
  const raw = tolerate(() => parseJsonValue(input), 'malformed-input');

  if (raw === undefined) {
    diagnostics.failure('head.resume_gate_input_unreadable', toKinuError({
      doing: 'reading the task out of a stored background-job input',
      cause: new Error('the stored input is not JSON'),
      otherwise: 'bad_input',
    }));

    return '';
  }

  const parsed = v.safeParse(ResumableJobInputSchema, raw);

  return parsed.success ? parsed.output.task ?? '' : '';
}

/** Uses the same lookups the resumed run does, so the gate and the re-entry agree on which run a job owns. */
export function resumableForkRoots(stores: {
  readonly ledger: { findRunningSwarms(task: string): readonly { readonly rootId: string }[] };
  readonly journal: Pick<HeadJournal, 'findResumableRun'>;
}, task: string): readonly string[] {
  if (task === '') return [];
  const roots = stores.ledger.findRunningSwarms(task).map((row) => row.rootId);
  const heads = stores.journal.findResumableRun(task);

  return heads === null ? roots : [...roots, heads];
}

/** Also what makes the chat render it as an event card. */
export const FORK_INTERRUPTED_SIGNAL = 'fork_interrupted';

/** Describes bookkeeping only: it must not name a mechanism or imply the head outlived its owner. */
export const FORK_INTERRUPTED_REASON =
  'no executor: spawned, never reported, and retired when a later activation '
  + 'found nothing left that could run it';

const MAX_NAMED_RUNS = 4;

function describeRun(run: AbandonedHeadRun): string {
  const why = run.rationale ? ` (${run.rationale})` : '';

  return `${run.rootId}${why}: ${run.abandoned} of ${run.total} heads`;
}

function forkInterruptedWake(runs: readonly AbandonedHeadRun[]): string {
  const named = runs.slice(0, MAX_NAMED_RUNS).map(describeRun);
  const rest = runs.length - named.length;
  const roster = rest > 0 ? [...named, `and ${rest} more`] : named;
  const heads = runs.reduce((n, run) => n + run.abandoned, 0);

  return (
    `${heads} head(s) across ${runs.length} fork run(s) were still marked running from an ` +
    `activation that has ended, so nothing is executing them and no report will arrive. ` +
    `They are now recorded as aborted: ${roster.join('; ')}. ` +
    `Earlier steps may have shown these as in flight — that is no longer true. ` +
    `Re-fork the work you still need, or continue without it and say what is missing.`
  );
}

/**
 * Call once per activation. Order: mark stale rows `interrupted` (non-terminal), offer their roots to
 * the resume gate, then retire (`aborted`) every unfinished run the gate did not claim. Retirement is
 * driven by the gate's answer alone, not by whether this activation marked anything; a gate that
 * could not answer protects everything. Returns the retired runs.
 */
export async function reconcileInterruptedForks(deps: {
  readonly journal: Pick<HeadJournal, 'markInterrupted' | 'unfinishedRoots' | 'abandonRunning'>;
  readonly inbox: AgentInbox;
  /** When present, `mcts_search_runs` rows the gate did not claim are closed `failed` beside the journal sweep. */
  readonly search?: Pick<MctsSearchStore, 'runningSwarmRoots' | 'closeUnclaimed'>;
  /** Absent: no durable resume path, so every interrupted run is refused. */
  readonly resume?: (roots: readonly string[]) => Promise<readonly string[]>;
  /** Each retired run gets `head_abandoned` appended to the run that carried its `head_split`. */
  readonly runEvents?: RunEventLedger;
  /** Runs a turn loop in this activation re-opened; open on purpose. Asked at the sweep, never captured. */
  readonly liveRuns?: () => readonly string[];
  readonly logActivity?: (event: string, detail?: string) => void;
  /** This activation's start; both sweeps' bound. */
  readonly now?: number;
}): Promise<readonly AbandonedHeadRun[]> {
  const startedAt = deps.now ?? Date.now();
  // First and unconditionally: a killed turn leaves its run open whether or not it forked.
  closeUnterminatedRuns(deps.runEvents, startedAt, new Set(deps.liveRuns?.() ?? []), deps.logActivity);
  const interrupted = deps.journal.markInterrupted({ spawnedBefore: startedAt }, startedAt);

  if (interrupted.length > 0) {
    deps.logActivity?.(
      'fork_runs_interrupted',
      interrupted.map((run) => `${run.rootId} (${run.abandoned}/${run.total})`).join(', '),
    );
  }

  // The gate is called once, over every unfinished root, including ones an earlier activation marked.
  // It also sweeps orphan job rows, so it runs even with no roots; a second call would reclaim a job
  // from the executor the first call started.
  const offeredRoots = new Set(deps.journal.unfinishedRoots(startedAt));

  for (const root of deps.search?.runningSwarmRoots(startedAt) ?? []) offeredRoots.add(root);
  const outcome = await resumeOutcome(deps.resume, [...offeredRoots]);

  // A gate that could not answer protects everything.
  if (outcome.kind === 'gate-failed') return [];

  // The ledger's half: close every running swarm row the gate did not claim.
  if (deps.search) {
    const closed = deps.search.closeUnclaimed(outcome.claimed, startedAt);

    if (closed.length > 0) deps.logActivity?.('swarm_runs_closed', closed.join(', '));
  }

  // The journal's half, on the same answer; not gated on this activation having marked anything.
  const runs = deps.journal.abandonRunning(
    FORK_INTERRUPTED_REASON,
    { spawnedBefore: startedAt, exceptRoots: [...outcome.claimed] },
    startedAt,
  );

  if (runs.length === 0) return runs;
  deps.logActivity?.(
    'fork_runs_abandoned',
    runs.map((run) => `${run.rootId} (${run.abandoned}/${run.total})`).join(', '),
  );
  recordAbandonedRuns(deps.runEvents, runs);
  await deps.inbox.send({
    kind: FORK_INTERRUPTED_SIGNAL,
    text: forkInterruptedWake(runs),
    // Keyed on the retired run set: the carrier is at-least-once, so replays must collide.
    idempotencyKey: `fork-interrupted:${runs.map((run) => run.rootId).sort().join(',')}`,
    metadata: {
      runs: runs.map((run) => run.rootId),
      heads: runs.reduce((n, run) => n + run.abandoned, 0),
    },
  });

  return runs;
}

/** Best-effort and never fatal: a ledger failure must not lose the fork reconciliation. The failure is logged with cause. */
function closeUnterminatedRuns(
  ledger: RunEventLedger | undefined,
  startedBefore: number,
  liveRuns: ReadonlySet<string>,
  logActivity: ((event: string, detail?: string) => void) | undefined,
): void {
  if (!ledger) return;

  try {
    const open = ledger.unterminatedRuns(undefined, startedBefore).filter((runId) => !liveRuns.has(runId));

    if (open.length === 0) return;

    for (const runId of open) {
      ledger.emit(runId, { type: 'run_end', reason: RUN_INTERRUPTED_REASON });
    }

    logActivity?.('runs_closed_interrupted', open.join(', '));
  } catch (err) {
    diagnostics.failure('run.interrupted_close_failed', toKinuError({
      doing: 'closing runs a dead activation left unterminated',
      cause: err,
      otherwise: 'io',
    }));
  }
}

/** `answered` (claimed roots), `absent` (no resume path: refuse all), or `gate-failed` (protect every root). */
type ResumeOutcome =
  | { readonly kind: 'answered' | 'absent'; readonly claimed: ReadonlySet<string> }
  | { readonly kind: 'gate-failed' };

async function resumeOutcome(
  resume: ((roots: readonly string[]) => Promise<readonly string[]>) | undefined,
  roots: readonly string[],
): Promise<ResumeOutcome> {
  if (!resume) return { kind: 'absent', claimed: new Set<string>() };

  try {
    return { kind: 'answered', claimed: new Set(await resume(roots)) };
  } catch (err) {
    diagnostics.failure('head.resume_gate_failed', toKinuError({
      doing: 'offering interrupted fork runs to the resume gate',
      cause: err,
      otherwise: 'io',
    }), { runs: roots.length, protected: roots.length });

    return { kind: 'gate-failed' };
  }
}


/** Best-effort per run; a fork with no recorded split is skipped. */
function recordAbandonedRuns(
  ledger: RunEventLedger | undefined,
  runs: readonly AbandonedHeadRun[],
): void {
  if (!ledger) return;

  for (const run of runs) {
    try {
      const runId = ledger.runForHeadSplit(run.rootId);

      if (!runId) continue;
      ledger.emit(runId, {
        type: 'head_abandoned',
        rootId: run.rootId,
        headCount: run.total,
        abandoned: run.abandoned,
        rationale: run.rationale,
        reason: FORK_INTERRUPTED_REASON,
      });
    } catch (err) {
      diagnostics.failure(
        'head.abandonment_record_failed',
        toKinuError({ doing: 'record an abandoned fork', cause: err, otherwise: 'io' }),
        { rootId: run.rootId },
      );
    }
  }
}
