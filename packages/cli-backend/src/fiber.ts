/**
 * SQLite-backed durable fiber for Linux CLI.
 * Same FiberCtx contract as CF Agent.runFiber.
 *
 * Architecture reference: docs/ARCHITECTURE.md — "Backends and the AgentRuntime contract"
 *
 * On SIGTERM: the fiber row persists in SQLite. On restart, query the `fibers`
 * table for orphaned rows (equivalent to Agent.onFiberRecovered).
 *
 * ACTOR-SCOPED. A fiber is a lane of ONE actor's work and its name is minted per
 * lane, so every actor in a workspace presents the same fiber names and an
 * unscoped sweep would let a subordinate's recovery resume the root's lane. The
 * `fibers` DDL belongs to core's identity/schema.ts — one owner per table.
 */

import { decodeJsonValue, parseJsonValue } from '@kinu.run/core';
import type { ActorHandle, Schedule, FiberCtx, JsonValue, SqlExecutor } from '@kinu.run/core';

export interface OrphanedFiber {
  id: string;
  name: string;
  snapshot: JsonValue | null;
}

export function createLinuxFiber(sql: SqlExecutor, actor: ActorHandle): Schedule['fiber'] {
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
      // Deliberately NOT re-authorized: this deletes only the row this call
      // inserted, and a retirement mid-fiber must not turn cleanup into a
      // throw that replaces the body's own result or error.
      void sql`DELETE FROM fibers WHERE actor_id = ${actorId} AND id = ${id}`;
    }
  };
}

/** Orphans from a previous crashed run — THIS actor's lanes only. */
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
