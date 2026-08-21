/**
 * Start-of-life reconciliation for the fork journal.
 *
 * `head_journal.status = 'running'` records "spawned, and no report recorded".
 * Nothing keeps a head alive across a process exit, a DO eviction, or an
 * operator cancel that settles the fork's background job without the
 * controller ever reaching `recordReport` — so at the start of an activation
 * that status is false for every row still carrying it. Because nothing else
 * ever wrote it, the row was permanent, and `HeadJournal.listLive()` fed
 * "N of M heads running" into the dynamic-context block of every model step
 * for the life of the workspace, while `background_jobs` said
 * `cancelled by operator`.
 *
 * Both halves of that are fixed here and only here: the journal is settled
 * (`HeadJournal.abandonRunning`), and the agent is TOLD, because a fork
 * silently vanishing from the roster is not the same as the agent learning it
 * is gone — it had already read that the fork was in flight, and a state
 * ledger that goes quiet does not retract anything.
 *
 * The telling rides the ONE delivery seam (`SignalDeliverer`): a step boundary
 * when a turn is running, a queued turn when the agent is idle. There is no
 * second notification path, and nothing here picks a mechanism.
 */

import type { RunEventInput } from '../events/types';
import type { SignalDeliverer } from '../types/signals';
import type { AbandonedHeadRun, HeadJournal } from './journal';
import * as v from 'valibot';
import { diagnostics, toKinuError } from '../obs/index';

/** What this reconciliation needs of the run-event recorder: find the run a
 *  fork was dispatched from, find the runs a dead activation left open, and
 *  append to either. Structural so core's heads layer does not depend on the
 *  recorder class. */
export interface RunEventLedger {
  runForHeadSplit(rootId: string): string | null;
  unterminatedRuns(): string[];
  emit(runId: string, input: RunEventInput): void;
}

/**
 * What `run_end.reason` records on a run this reconciliation closed.
 *
 * A turn's run is closed by `closeTurnRun`, in the turn's own frame, so nothing
 * writes a terminal row when the platform destroys that frame — and the ledger
 * then cannot tell a turn that is running from one that was killed. Measured on
 * the owner's workspace: six `run_start` rows against three `run_end`, the
 * missing ones including the turn that dispatched the search this whole
 * reconciliation is about. That is the durable face of "why will it not give up
 * its turn".
 *
 * `interrupted` and not `evicted`: the same argument {@link
 * FORK_INTERRUPTED_REASON} makes. This ledger cannot distinguish a DO eviction
 * from a process exit from a crash, and naming one would be a guess written into
 * durable history. `reason` is otherwise the turn's own status, so this reads
 * beside those without pretending to be one.
 */
export const RUN_INTERRUPTED_REASON = 'interrupted';

/**
 * The resume gate both backends hand {@link reconcileInterruptedForks}: re-drive
 * the durable jobs a dead activation left behind, and name the fork runs those
 * re-drives will re-enter.
 *
 * WHY IT IS THE JOB SWEEP AND NOT A LIVENESS PROBE. There is nothing to probe: an
 * activation that has just started owns no fork, and the only thing that can
 * continue one is a durable job row. So "can this run be continued" is exactly
 * "was its job re-driven", which the sweep answers by reclaiming under a fresh
 * lease. A job past its resume-attempt cap is failed there rather than re-driven,
 * so it is absent from the result and its run is refused here — which is what
 * makes this terminate instead of protecting a dead root forever.
 *
 * THE JOIN IS THE TASK, because that is the key every re-entry already uses:
 * `MctsSearchStore.findRunningSwarms` and `HeadJournal.findResumableRun` are both
 * task-keyed, and a durable job row carries the tool input rather than a root id.
 * Reading the task out of that input is therefore reading the same key the resumed
 * run will look itself up by, not a second addressing scheme.
 */
export function jobRedriveResumeGate(deps: {
  /** The job sweep — `BackgroundJobRunner.recoverOrphans`. */
  readonly recoverOrphans: () => Promise<readonly { readonly id: string }[]>;
  /** The tool input a job row stored, as JSON text or null. */
  readonly inputOf: (jobId: string) => string | null;
  /** Roots this task's re-entries would adopt, from the stores that own them. */
  readonly rootsForTask: (task: string) => readonly string[];
}): (roots: readonly string[]) => Promise<readonly string[]> {
  return async (offered) => {
    const redriven = await deps.recoverOrphans();
    if (redriven.length === 0) return [];
    const offeredRoots = new Set(offered);
    const claimed = new Set<string>();
    for (const job of redriven) {
      for (const root of deps.rootsForTask(taskOf(deps.inputOf(job.id)))) {
        // Only what this reconciliation actually offered: a re-drive of some other
        // task's job must not vouch for a root nobody asked about.
        if (offeredRoots.has(root)) claimed.add(root);
      }
    }
    return [...claimed];
  };
}

/**
 * The one field of a stored tool input this gate reads.
 *
 * Deliberately just the task, and deliberately loose about the rest: a job row is
 * durable HISTORY, so a row written by any past shape of the tool has to stay
 * readable here. A row this cannot read names no task, so its run is refused and
 * retired — the same outcome as a row naming a task nothing is searching for.
 */
const ResumableJobInputSchema = v.looseObject({ task: v.optional(v.string()) });

/** The task a stored tool input names, or the empty string. */
function taskOf(input: string | null): string {
  if (input === null) return '';
  try {
    const parsed = v.safeParse(ResumableJobInputSchema, JSON.parse(input));
    return parsed.success ? parsed.output.task ?? '' : '';
  } catch (err) {
    diagnostics.failure('head.resume_gate_input_unreadable', toKinuError({
      doing: 'reading the task out of a stored background-job input',
      cause: err,
      otherwise: 'io',
    }));
    return '';
  }
}

/**
 * Every fork run a re-drive of this task would adopt, from the two stores that
 * hold one.
 *
 * Both lookups already exist and both are the ones the resumed run itself uses:
 * a swarm re-enters through `findRunningSwarms` (newest wins, older rows
 * superseded — so every row it names is a row this task's re-drive accounts for),
 * and a branching-heads fork reclaims through `findResumableRun`. Asking them here
 * rather than restating their rules is what keeps the gate and the re-entry from
 * disagreeing about which run a job owns.
 */
export function resumableForkRoots(stores: {
  readonly ledger: { findRunningSwarms(task: string): readonly { readonly rootId: string }[] };
  readonly journal: Pick<HeadJournal, 'findResumableRun'>;
}, task: string): readonly string[] {
  if (task === '') return [];
  const roots = stores.ledger.findRunningSwarms(task).map((row) => row.rootId);
  const heads = stores.journal.findResumableRun(task);
  return heads === null ? roots : [...roots, heads];
}

/** The `kinuEvent` name for an interrupted fork — the queued turn's
 *  provenance, and what makes the chat render it as an event card. */
export const FORK_INTERRUPTED_SIGNAL = 'fork_interrupted';

/**
 * What `error_message` records on a head this reconciliation settled.
 *
 * Two observations and no cause. `running` meant "spawned, and no report
 * recorded"; the reconciliation runs before anything can resume a fork, so at
 * that instant nothing exists that could produce one. The journal cannot
 * distinguish an operator cancel from a process exit from a DO eviction — this
 * file's own header names all three — and it must not pick one.
 *
 * It previously read "settled at start of life, having outlived the activation
 * that spawned it", which named a mechanism: a head that ran past its owner.
 * That is false for the operator cancel, and the phrasing reads as a thrown
 * runtime error rather than what it is — a bookkeeping entry, written by the
 * routine that retires stale rows. It was reported as a crash on that basis.
 */
export const FORK_INTERRUPTED_REASON =
  'no executor: spawned, never reported, and retired when a later activation '
  + 'found nothing left that could run it';

/** How many runs the wake names before it summarizes. A resumed workspace with
 *  a long-abandoned history should still read as one short paragraph. */
const MAX_NAMED_RUNS = 4;

function describeRun(run: AbandonedHeadRun): string {
  const why = run.rationale ? ` (${run.rationale})` : '';
  return `${run.rootId}${why}: ${run.abandoned} of ${run.total} heads`;
}

/** The wake text. States what is true now, what the agent may have read
 *  earlier, and what it can do — the report is gone, so re-forking is the way
 *  to get that work, and continuing without it is the other way. */
export function forkInterruptedWake(runs: readonly AbandonedHeadRun[]): string {
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
 * Reconcile the fork journal at the start of an activation: cure the roster's
 * claim first, then retire only what nothing can continue.
 *
 * Call once per activation. Every `running` row at that instant was spawned by an
 * earlier one, and nothing carries a head across a process exit or a DO eviction,
 * so the status is stale by construction — the same argument
 * `BackgroundJobRunner.recoverOrphans` makes for its own registry, and the reason
 * neither needs a liveness handshake.
 *
 * THREE STEPS, and the order is the whole point.
 *
 *  1. MARK. Every stale row becomes `interrupted` (`HeadJournal.markInterrupted`).
 *     That is a non-terminal state: the roster stops asserting the fork is in
 *     flight, which is what this reconciliation exists for, and the run stays
 *     re-enterable, which is what it used to destroy.
 *  2. OFFER. The roots just marked go to the resume gate, which re-drives whatever
 *     durable work can continue them and returns the ones it CLAIMED.
 *  3. RETIRE THE REST. Only a run the gate refused is settled `aborted` and only
 *     that run reaches the agent as a card.
 *
 * WHY IT IS NOT ONE STEP ANY MORE. It used to retire everything, unconditionally,
 * as the first thing an activation did — and it argued that a resume needed no
 * ordering because the sweep was bounded to rows spawned before `now`. That bound
 * protects a resume's OWN fresh heads and nothing else. It does not protect the
 * rows a re-entry re-expands FROM, which are by definition the dead activation's.
 * So on the owner's workspace five heads of a live search were retired with "no
 * executor: ... nothing left that could run it" while the durable job that could
 * re-enter them was still re-drivable, and the agent, told its work was gone,
 * re-forked by hand. The sweep was unconditional and the re-drive was conditional,
 * so the sweep won every eviction. The order is now this function's, not the
 * platform's.
 *
 * Returns the runs it RETIRED — the ones the gate refused. A claimed run is left
 * `interrupted` for the re-entry to take over, and if that re-entry never lands,
 * the next activation offers it again and retires it when the gate has no job left
 * to re-drive. Empty is the clean-start case and delivers nothing.
 */
export async function reconcileInterruptedForks(deps: {
  readonly journal: Pick<HeadJournal, 'markInterrupted' | 'abandonRunning'>;
  readonly signals: SignalDeliverer;
  /**
   * The resume gate: re-drive what can continue these roots, and name the ones
   * claimed. Absent means a caller with no durable resume path at all, and then
   * every interrupted run is refused — which is this reconciliation's old
   * behaviour, correct for exactly that caller.
   */
  readonly resume?: (roots: readonly string[]) => Promise<readonly string[]>;
  /** The durable run-event ledger, when the caller has one. Each retired run
   *  gets its terminal `head_abandoned` appended to the run that carried its
   *  `head_split` — the same retraction the roster gets, on the plane the
   *  Timeline and every delegation-cost query read. */
  readonly runEvents?: RunEventLedger;
  readonly logActivity?: (event: string, detail?: string) => void;
  /** This activation's start, and both sweeps' own bound. Injected for a test that
   *  needs the two sides of it. */
  readonly now?: number;
}): Promise<readonly AbandonedHeadRun[]> {
  const startedAt = deps.now ?? Date.now();
  // FIRST, and unconditionally: a killed turn leaves its run open whether or not
  // it had forked anything, so this cannot sit behind the fork sweep's early
  // return. Both are the same act — writing the terminal row a destroyed frame
  // could not.
  closeUnterminatedRuns(deps.runEvents, deps.logActivity);
  const interrupted = deps.journal.markInterrupted({ spawnedBefore: startedAt }, startedAt);
  if (interrupted.length === 0) return [];
  deps.logActivity?.(
    'fork_runs_interrupted',
    interrupted.map((run) => `${run.rootId} (${run.abandoned}/${run.total})`).join(', '),
  );
  const claimed = await claimedRoots(deps.resume, interrupted);
  const runs = deps.journal.abandonRunning(
    FORK_INTERRUPTED_REASON,
    { spawnedBefore: startedAt, exceptRoots: claimed },
    startedAt,
  );
  if (runs.length === 0) return runs;
  deps.logActivity?.(
    'fork_runs_abandoned',
    runs.map((run) => `${run.rootId} (${run.abandoned}/${run.total})`).join(', '),
  );
  recordAbandonedRuns(deps.runEvents, runs);
  await deps.signals.deliver({
    kind: FORK_INTERRUPTED_SIGNAL,
    text: forkInterruptedWake(runs),
    metadata: {
      runs: runs.map((run) => run.rootId),
      heads: runs.reduce((n, run) => n + run.abandoned, 0),
    },
  });
  return runs;
}

/**
 * Close every run a dead activation left open, with a terminal `run_end`.
 *
 * The same start-of-life argument the fork journal makes: an activation that has
 * just started is executing none of these, so each one was left by an earlier
 * one. Without this the ledger holds a `run_start` with no terminal row forever,
 * and no reader — the Timeline, a spend query, a post-hoc investigation — can
 * tell it from a turn still in flight.
 *
 * Best-effort as a whole and never fatal: this is a bookkeeping write, and losing
 * the fork reconciliation beneath it because the ledger threw would trade a
 * misleading row for a lying roster. The failure is named, with a cause, so the
 * gap is visible in production rather than inferred later from a row count.
 */
function closeUnterminatedRuns(
  ledger: RunEventLedger | undefined,
  logActivity: ((event: string, detail?: string) => void) | undefined,
): void {
  if (!ledger) return;
  try {
    const open = ledger.unterminatedRuns();
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

/**
 * What the resume gate claimed, or nothing.
 *
 * A THROWING GATE CLAIMS NOTHING, and the failure is named rather than swallowed.
 * Retiring on a gate failure is the safe direction — the alternative is leaving a
 * run `interrupted` with no card and no re-entry, which is the silence this whole
 * ticket is about — but it is a DEGRADED reading of the truth, so it must appear in
 * production's own evidence rather than only in the retirement card.
 */
async function claimedRoots(
  resume: ((roots: readonly string[]) => Promise<readonly string[]>) | undefined,
  interrupted: readonly AbandonedHeadRun[],
): Promise<readonly string[]> {
  if (!resume) return [];
  const roots = interrupted.map((run) => run.rootId);
  try {
    return await resume(roots);
  } catch (err) {
    diagnostics.failure('head.resume_gate_failed', toKinuError({
      doing: 'offering interrupted fork runs to the resume gate',
      cause: err,
      otherwise: 'io',
    }), { runs: roots.length });
    return [];
  }
}

/** Close each dead fork's span in the run-event ledger.
 *
 *  Best-effort per run and never fatal: the journal is already settled by the
 *  time this runs, and losing the agent's wake because a ledger write threw
 *  would trade the record this module exists for against a secondary copy of
 *  it. A fork with no recorded split has no run to close and is skipped. */
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
