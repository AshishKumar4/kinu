/**
 * SQLite-backed durable fiber for Linux CLI; same FiberCtx contract as CF Agent.runFiber.
 * Actor-scoped: fiber names repeat across actors, so every query filters by actor_id.
 */

import { decodeJsonValue, parseJsonValue } from '../utils/json';
import { type ActorHandle } from '../identity/actor-handle';
import { type Schedule, type FiberCtx, type SqlExecutor } from '../types/primitives';
import { type JsonValue } from '../utils/json';

export interface OrphanedFiber {
  id: string;
  name: string;
  snapshot: JsonValue | null;
}

export function createSqlFiber(sql: SqlExecutor, actor: ActorHandle): Schedule['fiber'] {
  const actorId = actor.actorId;
  const authorize = actor.assertCurrent;

  return async function fiber<T>(
    name: string,
    fn: (ctx: FiberCtx) => Promise<T>,
  ): Promise<T> {
    authorize();
    const id = crypto.randomUUID();
    void sql`INSERT INTO fibers (actor_id, id, name, snapshot, created_at)
        VALUES (${actorId}, ${id}, ${name}, ${null}, ${Date.now()})`;

    const stash: FiberCtx['stash'] = (data): void => {
      authorize();
      const snapshot = decodeJsonValue({ value: data });
      void sql`UPDATE fibers SET snapshot = ${JSON.stringify(snapshot)}
          WHERE actor_id = ${actorId} AND id = ${id}`;
    };

    try {
      return await fn({ stash, snapshot: null });
    } finally {
      // Not re-authorized: a mid-fiber retirement must not turn cleanup into a throw.
      void sql`DELETE FROM fibers WHERE actor_id = ${actorId} AND id = ${id}`;
    }
  };
}

/** A fiber its host holds: a refused start reaches `onStartFailed`, never a rejection. Neither callback may reject. */
export type HeldFiber = (
  name: string,
  fn: (ctx: FiberCtx) => Promise<void>,
  onStartFailed: (failure: { readonly cause: unknown }) => Promise<void>,
) => void;

export function heldFiber(fiber: Schedule['fiber']): HeldFiber {
  return (name, fn, onStartFailed) => {
    new Promise<void>((resolve) => { resolve(fiber(name, fn)); }).then(undefined, async (...refused: [unknown]) => onStartFailed({ cause: refused[0] }));
  };
}

/** Orphans from a previous crashed run, this actor's lanes only. */
export function detectOrphanedFibers(sql: SqlExecutor, actor: ActorHandle): OrphanedFiber[] {
  actor.assertCurrent();

  const rows = sql<{ id: string; name: string; snapshot: string | null }>`
    SELECT id, name, snapshot FROM fibers WHERE actor_id = ${actor.actorId}
  `;

  return rows.map(r => ({
    id: r.id,
    name: r.name,
    snapshot: r.snapshot ? parseJsonValue(r.snapshot) : null,
  }));
}
