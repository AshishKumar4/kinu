/**
 * THE delegation runner: run the assignments an actor's log already holds.
 *
 * An assignment is not an external event a reactor reacts to — `wakesADrain`
 * states that rule and excludes `subordinate_task` from every drain because of
 * it. This is the other side of the same rule: the one loop that takes those
 * rows and spends each as the whole input of one turn. Both backends drive it,
 * so "one row, one runner" is a property of the code rather than a coincidence
 * of two sweeps that happened to agree.
 *
 * The invariants live here and nowhere else:
 *
 * THE DOUBLE-EXECUTION GUARD IS `markConsumed` BEFORE THE `await`. It is
 * synchronous, so it is atomic with respect to the event loop: the row leaves
 * the pending set before this frame yields, and a concurrent or re-woken sweep
 * reading `pending()` cannot see it. Every other ordering runs the turn twice —
 * which for a delegated task means two answers to one `agents.ask`.
 *
 * A FAILED RUN LEAVES ITS LEASE OPEN, deliberately. `unbindStale` at the top
 * re-pends it once the grace has passed, so the work is retried on a later
 * frame rather than stranded; closing the lease on failure would drop the task
 * silently, and re-pending it immediately would spin. The grace is non-zero
 * because a Durable Object activation may be racing its own predecessor, which
 * is the case `unbindStale` requires callers to state.
 */

import type { EventLog } from '../events/hub/log';
import type { SubordinateInheritedContext } from '../types/subordinates';
import type { WorkMode } from '../types/turn';
import { nanoid } from '../utils/nanoid';

/** One admitted assignment, as its runner receives it. */
export interface AdmittedAssignment {
  /** The parent's brief, VERBATIM. This is the turn's input, not a summary of
   *  it: a runner that wraps or digests it is the defect this module names. */
  readonly body: string;
  /** The trusted Plan/Build mode the assignment was admitted under. */
  readonly mode: WorkMode;
  /** The row's own id, and therefore the relay's dedupe key: it is stable
   *  across a re-delivery, so a report a recovered sequence replays is
   *  recognised as the one the parent already holds rather than counted as a
   *  second answer. */
  readonly sequenceId: string;
  /** The synthetic turn this row is now bound to. A runner that opens the turn
   *  on the actor's OWN conversation splices the birth context by naming this
   *  id — `subordinateTurnContext(log, turnId)` reads the rows bound to it — so
   *  a runner that mints its own id gets a child born from nothing. */
  readonly turnId: string;
  readonly inheritedContext?: SubordinateInheritedContext;
  /** A pane message's own id: the streamed answer closes the request it opened. */
  readonly messageId?: string;
}

export interface DrainAssignmentsOptions {
  /** The sweep's instant, used for the stale-lease cutoff. */
  readonly now: number;
  /** The most assignments this call may consume. The caller owns the ceiling
   *  because it is a budget over a whole sweep, not over one actor. */
  readonly budget: number;
  /** How long a bound-but-unfinished delivery is left alone before it counts as
   *  a dead process's leftovers. */
  readonly staleMs: number;
  /** Run one assignment as one turn. Resolving means the turn happened. */
  run(task: AdmittedAssignment): Promise<void>;
  /** One run threw, as the thrown value the caller's own `toKinuError` reads. A
   *  seam rather than a returned list, so the caller's diagnostics event fires
   *  at the moment of the failure and carries its own fields — a collected list
   *  would reorder every per-actor log line behind the whole sweep. */
  onFailure(thrown: { readonly cause: unknown }): void;
}

export async function drainAssignments(
  log: EventLog,
  opts: DrainAssignmentsOptions,
): Promise<{ consumed: number; truncated: boolean }> {
  log.unbindStale(opts.staleMs, opts.now);

  let remaining = opts.budget;
  let consumed = 0;
  let truncated = false;

  for (const event of log.pending({ variant: 'subordinate_task', limit: opts.budget })) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    if (event.variant !== 'subordinate_task') continue;

    if (event.payload_visibility !== 'full' && event.payload_visibility !== 'redact') continue;
    const turnId = `evt-${nanoid()}`;
    log.markConsumed(event.id, turnId, 0);
    remaining -= 1;
    consumed += 1;

    try {
      await opts.run({
        body: event.payload.body,
        mode: event.payload.kinu_mode,
        sequenceId: event.id,
        turnId,
        inheritedContext: event.payload.inherited_context,
        messageId: event.payload.message_id,
      });
      log.markTurnCompleted(turnId);
    } catch (cause) {
      opts.onFailure({ cause });
    }
  }

  return { consumed, truncated };
}
