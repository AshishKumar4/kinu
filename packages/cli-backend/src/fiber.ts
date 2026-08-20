/**
 * SQLite-backed durable fiber for Linux CLI.
 * Same FiberCtx contract as CF Agent.runFiber.
 *
 * Architecture reference: docs/ARCHITECTURE.md — "Backends and the AgentRuntime contract"
 *
 * On SIGTERM: the fiber row persists in SQLite. On restart, query the `fibers`
 * table for orphaned rows (equivalent to Agent.onFiberRecovered).
 */

import { decodeJsonValue, parseJsonValue } from '@kinu/core';
import type { Schedule, FiberCtx, JsonValue, RawSqlExec, SqlExecutor } from '@kinu/core';

export interface OrphanedFiber {
  id: string;
  name: string;
  snapshot: JsonValue | null;
}

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
    void sql`INSERT INTO fibers (id, name, snapshot, created_at)
        VALUES (${id}, ${name}, ${null}, ${Date.now()})`;

    const stash: FiberCtx['stash'] = (data): void => {
      const snapshot = decodeJsonValue({ value: data });
      void sql`UPDATE fibers SET snapshot = ${JSON.stringify(snapshot)} WHERE id = ${id}`;
    };

    try {
      return await fn({ stash, snapshot: null });
    } finally {
      void sql`DELETE FROM fibers WHERE id = ${id}`;
    }
  };
}

/** Detect orphaned fibers from previous crashed run */
export function detectOrphanedFibers(
  sql: SqlExecutor,
): OrphanedFiber[] {
  const rows = sql<{ id: string; name: string; snapshot: string | null }>`
    SELECT id, name, snapshot FROM fibers
  `;
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    snapshot: r.snapshot ? parseJsonValue(r.snapshot) : null,
  }));
}
