import { initCompactionStateTable } from '@proteus/compaction';
import {
  initActorTables,
  initBackgroundJobsTable,
  initCraftScoreTables,
  initEventsHubTables,
  initFactsTable,
  initHeadsTables,
  initRunEventTables,
  initScaffoldTables,
  initSearchTables,
  initTurnOutcomeTables,
  type SqlExecutor,
} from '@proteus/core';

/** Structural subset shared by Cloudflare Durable Object SQLite and tests. */
export interface ActorSchemaSqlStorage {
  exec(query: string, ...bindings: unknown[]): {
    toArray(): Array<Record<string, unknown>>;
  };
}

/** Initialize the durable tables required by ActorAgent itself. Workspace-only
 * concerns (identity, fork lineage, webhooks, roster, curriculum, GEPA,
 * product changes, and UI feedback) remain with OrchestratorAgent. */
export function ensureActorSchema(
  storageSql: ActorSchemaSqlStorage,
  sql: SqlExecutor,
): void {
  const execRaw = (ddl: string): void => { storageSql.exec(ddl); };

  initActorTables(execRaw);
  // These subsystem initializers own schema upgrades beyond the unified base
  // DDL and must still run on every activation.
  initSearchTables(execRaw);
  initScaffoldTables(execRaw);
  initCraftScoreTables(execRaw);
  initTurnOutcomeTables(execRaw, sql);
  initEventsHubTables(storageSql);
  initHeadsTables(execRaw);
  initRunEventTables(execRaw);
  initFactsTable(execRaw);
  initBackgroundJobsTable(execRaw);
  initCompactionStateTable(execRaw);

  execRaw(`CREATE TABLE IF NOT EXISTS agent_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
}
