/**
 * SQLite-backed durable fiber for Linux CLI.
 * Same FiberCtx contract as CF Agent.runFiber.
 *
 * Architecture reference: docs/ARCHITECTURE.md — "Backends and the AgentRuntime contract"
 *
 * On SIGTERM: the fiber row persists in SQLite. On restart, query the `fibers`
 * table for orphaned rows (equivalent to Agent.onFiberRecovered).
 */

import type { Schedule, FiberCtx, RawSqlExec, SqlExecutor } from '@proteus/core';

export function initFiberTable(execRaw: RawSqlExec): void {
  execRaw(`
    CREATE TABLE IF NOT EXISTS fibers (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      snapshot   TEXT,
      created_at INTEGER NOT NULL
    )
  `);
}

export function createLinuxFiber(sql: SqlExecutor): Schedule['fiber'] {
  return async function fiber<T>(
    name: string,
    fn: (ctx: FiberCtx) => Promise<T>,
  ): Promise<T> {
    const id = crypto.randomUUID();
    sql`INSERT INTO fibers (id, name, snapshot, created_at)
        VALUES (${id}, ${name}, ${null}, ${Date.now()})`;

    const stash = (data: unknown): void => {
      sql`UPDATE fibers SET snapshot = ${JSON.stringify(data)} WHERE id = ${id}`;
    };

    try {
      return await fn({ stash, snapshot: null });
    } finally {
      sql`DELETE FROM fibers WHERE id = ${id}`;
    }
  };
}

/** Detect orphaned fibers from previous crashed run */
export function detectOrphanedFibers(
  sql: SqlExecutor,
): Array<{ id: string; name: string; snapshot: unknown }> {
  const rows = sql<{ id: string; name: string; snapshot: string | null }>`
    SELECT id, name, snapshot FROM fibers
  `;
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    snapshot: r.snapshot ? JSON.parse(r.snapshot) : null,
  }));
}
