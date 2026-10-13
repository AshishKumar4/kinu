// In-memory SQL fixture: bun:sqlite behind the product's `SqlExecutor` adapter.
import { Effect } from 'effect';
import { Database } from 'bun:sqlite';
import { bindActorHandle, type ActorHandle, type SqlExecutor } from '@kinu.run/core';
import { wrapDatabase } from '@kinu.run/core/identity';

export type TestSql = ReturnType<typeof wrapDatabase> & { readonly db: Database; close(): void };

/** A `SqlExecutor` over an existing database, e.g. a real actor's harness database. */
export function sqlOver(db: Database): SqlExecutor {
  return wrapDatabase(db).sql;
}

/** A fresh, isolated in-memory database + sql template tag. */
export function createTestSql(): TestSql {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');

  return { ...wrapDatabase(db), db, close: () => db.close() };
}

/** A real {@link ActorHandle} via `bindActorHandle`, so stores' `assertCurrent()` checks can fail; `live` makes it revocable. */
export function testActorHandle(
  sql: SqlExecutor,
  opts: { readonly actorId?: string; readonly live?: () => boolean } = {},
): ActorHandle {
  const actorId = opts.actorId ?? 'actor-test';

  return bindActorHandle(sql, {
    actorId,
    workspaceId: 'ws-test',
    parentActorId: null,
    name: actorId,
    storageKey: `agent:${actorId}`,
  }, () => (opts.live?.() === false ? Effect.die(new Error(`actor ${actorId} is no longer bound`)) : Effect.void));
}
