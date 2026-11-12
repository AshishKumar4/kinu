import { AgentDeliveries, deliveryMetadata, type EventLog, type SqlExecutor } from '@kinu.run/core';

/** One-time repair of leases the old Stop left after retiring an admitted queued input (2026-11-12, L28).
 *  Remove this file, its facet probe and marker once deployed workspaces have reconciled. */
export async function reconcileStoppedEventLeases(host: {
  readonly sql: SqlExecutor;
  readonly done: () => boolean;
  readonly finish: () => void;
  readonly actors: () => readonly string[];
  readonly log: (actorId: string) => EventLog;
  readonly held: (actorId: string, ids: readonly string[]) => Promise<readonly string[]>;
  readonly transaction: <A>(body: () => A) => A;
}): Promise<void> {
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
