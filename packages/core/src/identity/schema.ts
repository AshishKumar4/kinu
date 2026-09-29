/** Identity and actor DDL; `state/workspace-schema.ts` composes every table. */

import type { RawSqlExec, SqlExecutor } from '../types/primitives';

export const WORKSPACE_IDENTITY_DDL =
  `CREATE TABLE IF NOT EXISTS workspace_identity (
    -- One row per database: a second identity is refused, not arbitrated by readers.
    singleton  INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
    id         TEXT NOT NULL,
    name       TEXT NOT NULL,
    owner_user_id TEXT NOT NULL DEFAULT '',
    -- The one line a read-only listing needs. Maintained by writeSoul and
    -- nothing else, so it cannot drift from SOUL.md (identity/soul.ts).
    mission    TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`;

/** The owner's soul; SOUL.md is resealed from it. */
export const WORKSPACE_SOUL_DDL = `CREATE TABLE IF NOT EXISTS workspace_soul (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    markdown TEXT NOT NULL
  )`;

const ACTOR_DDL = [
  // mcts/schemas.ts and scaffold/schemas.ts own their DDL (initActorTables runs it): one owner per table.

  // Actor-scoped: fiber names ('advisor-lane', 'reactor', …) repeat across actors.
  `CREATE TABLE IF NOT EXISTS fibers (
    actor_id   TEXT NOT NULL,
    id         TEXT NOT NULL,
    name       TEXT NOT NULL,
    snapshot   TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fibers_actor_name ON fibers(actor_id, name)`,

  // memory_chunks is owned by MemoryStore (agent-utils), not created here.
  `CREATE TABLE IF NOT EXISTS evolution_events (
    actor_id   TEXT NOT NULL,
    id         TEXT NOT NULL DEFAULT (lower(hex(randomblob(9)))),
    type       TEXT NOT NULL,
    message    TEXT NOT NULL,
    data       TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (actor_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_evolution_events_actor
     ON evolution_events(actor_id, created_at DESC, id DESC)`,

  `CREATE TABLE IF NOT EXISTS executor_output (
    actor_id   TEXT NOT NULL,
    id         TEXT NOT NULL DEFAULT (lower(hex(randomblob(9)))),
    executor   TEXT NOT NULL,
    command    TEXT NOT NULL,
    stdout     TEXT,
    stderr     TEXT,
    exit_code  INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (actor_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_executor_output_actor
     ON executor_output(actor_id, created_at DESC, id DESC)`,

  `CREATE TABLE IF NOT EXISTS activity_log (
    actor_id   TEXT NOT NULL,
    id         TEXT NOT NULL DEFAULT (lower(hex(randomblob(9)))),
    event      TEXT NOT NULL,
    detail     TEXT,
    elapsed_ms INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (actor_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_activity_log_created
     ON activity_log(actor_id, created_at DESC, id DESC)`,
];

// Single row, present only on a fork; written once, when the fork's transfer publishes.
const FORK_LINEAGE_DDL = `CREATE TABLE IF NOT EXISTS fork_lineage (
    id                            INTEGER PRIMARY KEY,
    source_workspace_id           TEXT    NOT NULL,
    source_workspace_name         TEXT    NOT NULL,
    source_message_id             TEXT    NOT NULL,
    source_message_created_at     INTEGER NOT NULL,
    forked_at                     INTEGER NOT NULL
  )`;

/** A second `begin` replaces the unpublished fork transfer. */
const FORK_TRANSFER_DDL = `CREATE TABLE IF NOT EXISTS fork_transfer (
    id                              INTEGER PRIMARY KEY CHECK (id = 1),
    head_declared                   INTEGER NOT NULL DEFAULT 0,
    head_source_id                  TEXT    NOT NULL DEFAULT '',
    head_source_name                TEXT    NOT NULL DEFAULT '',
    head_cut_message_id             TEXT    NOT NULL DEFAULT '',
    head_cut_created_at             INTEGER NOT NULL DEFAULT 0,
    mission                         TEXT    NOT NULL DEFAULT '',
    staged_agent_config             INTEGER NOT NULL DEFAULT 0,
    staged_crafted_tools            INTEGER NOT NULL DEFAULT 0,
    staged_memory_chunks            INTEGER NOT NULL DEFAULT 0,
    staged_session_messages         INTEGER NOT NULL DEFAULT 0,
    staged_conversation_entries     INTEGER NOT NULL DEFAULT 0,
    staged_conversation_entry_parts INTEGER NOT NULL DEFAULT 0,
    staged_context_members          INTEGER NOT NULL DEFAULT 0,
    transfer_id                     TEXT,
    expected_seq                    INTEGER NOT NULL DEFAULT 0,
    section_cursor                  INTEGER NOT NULL DEFAULT 0,
    stream                          TEXT    NOT NULL DEFAULT '',
    import_path                     TEXT,
    want_agent_config               INTEGER NOT NULL DEFAULT 0,
    want_crafted_tools              INTEGER NOT NULL DEFAULT 0,
    want_memory_chunks              INTEGER NOT NULL DEFAULT 0,
    want_session_messages           INTEGER NOT NULL DEFAULT 0,
    want_conversation_entries       INTEGER NOT NULL DEFAULT 0,
    want_conversation_entry_parts   INTEGER NOT NULL DEFAULT 0,
    want_context_members            INTEGER NOT NULL DEFAULT 0,
    want_files                      INTEGER NOT NULL DEFAULT 0,
    published                       INTEGER NOT NULL DEFAULT 0
  )`;

/** What an unpublished transfer placed (SOUL.md and each import's destination); a replacement `begin` removes exactly these. */
const FORK_STAGED_FILES_DDL = `CREATE TABLE IF NOT EXISTS fork_staged_files (
    path TEXT PRIMARY KEY
  )`;

export function initActorDdl(execRaw: RawSqlExec): void {
  for (const ddl of ACTOR_DDL) execRaw(ddl);
}

export function initWorkspaceOwnershipTables(execRaw: RawSqlExec): void {
  execRaw(WORKSPACE_IDENTITY_DDL);
  execRaw(WORKSPACE_SOUL_DDL);
  execRaw(FORK_LINEAGE_DDL);
  execRaw(FORK_TRANSFER_DDL);
  execRaw(FORK_STAGED_FILES_DDL);
}

/** The canonical `fibers` DDL, for runtimes built without the whole workspace schema. */
export function initFiberTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS fibers (
    actor_id   TEXT NOT NULL,
    id         TEXT NOT NULL,
    name       TEXT NOT NULL,
    snapshot   TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, id)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_fibers_actor_name ON fibers(actor_id, name)`);
}

/** Absence as a value: a catch cannot tell a missing table from other SQL errors. */
export function tableExists(sql: SqlExecutor, table: string): boolean {
  return sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}
  `.length > 0;
}

/** A vocabulary quoted for a DDL CHECK, so the CHECK derives from the same list as the type. */
export function sqlCheckList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(',');
}

