// In-memory SQL fixture — bun:sqlite + template-tag wrapper that matches the
// `SqlExecutor` signature used throughout @proteus/core.
//
// Tests previously each defined this setup inline; centralising it kills ~120
// lines of duplication across unit-facts / unit-curriculum / unit-sleep-time /
// unit-eval / etc.
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type { SqlExecutor, SqlValue } from '@proteus/core';

export interface TestSql {
  /** Tagged-template SQL — matches `SqlExecutor` shape from @proteus/core. */
  sql: SqlExecutor;
  /** Raw DDL executor — for schema setup. */
  execRaw: (ddl: string) => void;
  /** The underlying Bun database (useful for direct introspection in tests). */
  db: Database;
  /** Closes the in-memory database. Optional; the GC will do it eventually. */
  close(): void;
}

/**
 * A tagged-template `SqlExecutor` over a database the caller already has.
 *
 * Separate from {@link createTestSql} because a test that drives a REAL actor gets its
 * database from the actor's harness, and writing through a second connection would be
 * writing to a different store. The tag itself is the same one, so a fixture and a
 * harness-backed test bind values identically.
 */
export function sqlOver(db: Database): SqlExecutor {
  // Convert a template literal into `?`-bound prepared statement.
  // Returns rows as a typed array — Tagged-template form matches the
  // SqlExecutor signature: `sql<Row>\`SELECT ...\``.
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

/** Build a fresh in-memory database + sql template tag. Each test that calls
 *  this gets an isolated database. */
export function createTestSql(): TestSql {
  const db = new Database(':memory:');
  return {
    sql: sqlOver(db),
    execRaw: (ddl: string) => { db.exec(ddl); },
    db,
    close: () => db.close(),
  };
}
