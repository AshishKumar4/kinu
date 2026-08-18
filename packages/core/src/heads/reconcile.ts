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

import type { RunEventInput } from '../events/types.js';
import type { SignalDeliverer } from '../types/signals.js';
import type { AbandonedHeadRun, HeadJournal } from './journal.js';

/** What this reconciliation needs of the run-event recorder: find the run a
 *  fork was dispatched from, and append to it. Structural so core's heads layer
 *  does not depend on the recorder class. */
export interface RunEventLedger {
  runForHeadSplit(rootId: string): string | null;
  emit(runId: string, input: RunEventInput): void;
}

/** The `proteusEvent` name for an interrupted fork — the queued turn's
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
 * Settle the journal's interrupted runs and tell the agent about them.
 *
 * Call once at the start of an activation, BEFORE anything can resume a fork:
 * at that instant no head can be running, so every `running` row is stale by
 * construction — the same argument `BackgroundJobRunner.recoverOrphans` makes
 * for its own registry, and the reason neither needs a liveness handshake.
 *
 * Returns the runs it settled so the caller can log what it reconciled; the
 * empty array is the clean-start case and delivers nothing.
 */
export async function reconcileInterruptedForks(deps: {
  readonly journal: Pick<HeadJournal, 'abandonRunning'>;
  readonly signals: SignalDeliverer;
  /** The durable run-event ledger, when the caller has one. Each settled run
   *  gets its terminal `head_abandoned` appended to the run that carried its
   *  `head_split` — the same retraction the roster gets, on the plane the
   *  Timeline and every delegation-cost query read. */
  readonly runEvents?: RunEventLedger;
  readonly logActivity?: (event: string, detail?: string) => void;
}): Promise<readonly AbandonedHeadRun[]> {
  const runs = deps.journal.abandonRunning(FORK_INTERRUPTED_REASON);
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
      console.warn(
        `[proteus] could not record the abandonment of fork ${run.rootId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
