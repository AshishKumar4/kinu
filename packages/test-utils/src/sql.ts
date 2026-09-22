// In-memory SQL fixture: bun:sqlite behind the `SqlExecutor` template tag.
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { bindActorHandle, type ActorHandle, type SqlExecutor, type SqlValue } from '@kinu.run/core';

export interface TestSql {
  sql: SqlExecutor;
  execRaw: (ddl: string) => void;
  db: Database;
  close(): void;
}

/** A `SqlExecutor` over an existing database, e.g. a real actor's harness database. */
export function sqlOver(db: Database): SqlExecutor {
  return function <T = unknown>(
    strings: TemplateStringsArray,
    ...values: SqlValue[]
  ): T[] {
    const q = strings.reduce((acc, s, i) => acc + s + (i < values.length ? '?' : ''), '');

    // bun:sqlite binds TypedArrays, not ArrayBuffers (the canonical VFS BLOB type).
    const bound: SQLQueryBindings[] = values.map((value) => (
      value instanceof ArrayBuffer ? new Uint8Array(value) : value
    ));

    return db.prepare<T, SQLQueryBindings[]>(q).all(...bound);
  };
}

/** A fresh, isolated in-memory database + sql template tag. */
export function createTestSql(): TestSql {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');

  return {
    sql: sqlOver(db),
    execRaw: (ddl: string) => { db.exec(ddl); },
    db,
    close: () => db.close(),
  };
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
  }, () => {
    if (opts.live?.() === false) throw new Error(`actor ${actorId} is no longer bound`);
  });
}
