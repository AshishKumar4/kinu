/**
 * The delegation runner: spends each pending assignment row as the whole input of one turn.
 * `markConsumed` must run before the `await` so a concurrent sweep cannot run a row twice.
 * A failed run leaves its lease open; `unbindStale` re-pends it after the grace.
 */

import type { EventLog } from '../events/hub/log';
import type { SubordinateInheritedContext } from '../types/subordinates';
import type { WorkMode } from '../types/turn';
import { nanoid } from '../utils/nanoid';

export interface AdmittedAssignment {
  /** The parent's brief, verbatim: the turn's input, not a summary. */
  readonly body: string;
  /** The trusted Plan/Build mode the assignment was admitted under. */
  readonly mode: WorkMode;
  /** The row's id: the relay's dedupe key, stable across re-delivery. */
  readonly sequenceId: string;
  /** The synthetic turn this row is bound to. A runner must open its turn with this id:
   *  `subordinateTurnContext(log, turnId)` reads the birth context from it. */
  readonly turnId: string;
  readonly inheritedContext?: SubordinateInheritedContext;
  /** A pane message's own id: the streamed answer closes the request it opened. */
  readonly messageId?: string;
}

export interface DrainAssignmentsOptions {
  /** The sweep's instant, used for the stale-lease cutoff. */
  readonly now: number;
  /** The most assignments this call may consume: a budget over the whole sweep. */
  readonly budget: number;
  /** How long a bound-but-unfinished delivery waits before it counts as stale. */
  readonly staleMs: number;
  /** Run one assignment as one turn. Resolving means the turn happened. */
  run(task: AdmittedAssignment): Promise<void>;
  /** Called per failed run, at failure time, with the thrown value. */
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
