import { AgentDeliveries, deliveryMetadata } from './deliveries';
import { PendingSendStore, signalCardId } from '../orchestrator/inbox';
import { PROGRAMMATIC_MESSAGE_ID_PREFIX } from '../utils/ui-message';
import { answersForDrainTurns } from '../identity/conversation-store';
import type { ActorHandle } from '../identity/actor-handle';
import type { SessionTranscriptReader } from '../session/transcript';
import type { EventLog } from '../events/hub/log';
import type { SqlExecutor } from '../types/primitives';

export const STOPPED_EVENT_LEASES_REPAIR = 'stopped-event-leases-2026-11-12';

export interface StoppedEventLeaseHost {
  readonly sql: SqlExecutor;
  readonly done: () => boolean;
  readonly finish: () => void;
  readonly actors: () => readonly string[];
  readonly log: (actorId: string) => EventLog;
  readonly held: (actorId: string, ids: readonly string[]) => Promise<readonly string[]>;
  readonly transaction: <A>(body: () => A) => A;
}

/** Evidence an event input reached its recipient or still waits there; independent of its age. */
export async function heldEventDeliveries(
  sql: SqlExecutor, actor: ActorHandle, transcript: SessionTranscriptReader, ids: readonly string[],
): Promise<readonly string[]> {
  const pending = new PendingSendStore(sql, actor.actorId);
  const entries = transcript.holding(ids.flatMap((id) => [`${PROGRAMMATIC_MESSAGE_ID_PREFIX}${id}`, signalCardId(id)]));

  const runs = new Set(sql<{ id: string }>`SELECT json_extract(payload, '$.turn.metadata.drainTurnId') AS id
    FROM run_events WHERE actor_id = ${actor.actorId} AND type = 'run_start'
    AND json_extract(payload, '$.turn.metadata.drainTurnId') IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`.map((row) => row.id));

  const answered = new Set((await answersForDrainTurns(transcript, ids)).keys());

  return ids.filter((id) => answered.has(id) || pending.hasTurn(id) || runs.has(id) || entries.has(`${PROGRAMMATIC_MESSAGE_ID_PREFIX}${id}`) || entries.has(signalCardId(id)));
}

/** One-time repair of leases the old Stop left after retiring an admitted queued input (2026-11-12, L28).
 *  Remove this file, its facet probe and both adapters' markers once deployed workspaces have reconciled. */
export async function reconcileStoppedEventLeases(host: StoppedEventLeaseHost): Promise<void> {
  if (host.done()) return;
  const deliveries = new AgentDeliveries(host.sql);

  for (const actor of host.actors()) {
    const log = host.log(actor);

    const owed = () => new Set(deliveries.unpaid(actor).flatMap((delivery) => {
      const id = deliveryMetadata(delivery)?.drainTurnId;

      return typeof id === 'string' ? [id] : [];
    }));

    const unpaid = owed();
    const candidates = log.openDrainLeases().filter((id) => !unpaid.has(id));

    if (candidates.length === 0) continue;
    const held = new Set(await host.held(actor, candidates));

    host.transaction(() => {
      const pending = owed();
      const open = new Set(log.openDrainLeases());

      for (const id of candidates) {
        if (held.has(id) || pending.has(id) || !open.has(id)) continue;

        for (const event of log.query({ turn_id: id, limit: Number.MAX_SAFE_INTEGER })) log.dismiss(event.id, 'stopped input no longer held by its agent', 'system');
      }
    });
  }

  host.finish();
}
