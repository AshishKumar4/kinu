/**
 * Unified schema — ALL workspace tables in one place.
 * Idempotent: every statement uses IF NOT EXISTS.
 *
 * This is the single source of truth for what constitutes a workspace:
 * About twenty tables in one SQLite file make one workspace: the file plane,
 * one conversation per agent, evolution state, and the default orchestrator.
 */

import { initSearchTables } from '../mcts/schemas';
import { initCraftedToolsTables } from '@kinu.run/agent-utils/stores';
import { initScaffoldTables } from '../scaffold/schemas';
import { initCodemodeStateTable } from '../tools/state-codemode';
import { initViewTables } from '../views/store';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';

export const WORKSPACE_IDENTITY_DDL =
  // ── Workspace identity — the ownership root ────────────────────
  `CREATE TABLE IF NOT EXISTS workspace_identity (
    id         TEXT NOT NULL,
    name       TEXT NOT NULL,
    owner_user_id TEXT NOT NULL DEFAULT '',
    -- The one line a read-only listing needs. Maintained by writeSoul and
    -- nothing else, so it cannot drift from SOUL.md (identity/soul.ts).
    mission    TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`;

/** Durable state owned by every full-loop actor, including facet actors. */
const ACTOR_DDL = [
  // ── MCTS search tree ───────────────────────────────────────────
  // Canonical DDL owned by mcts/schemas.ts (initSearchTables, run below). A
  // second copy here drifted once and left a live workspace without a column
  // every reader named.

  // ── Scaffold management + task history ─────────────────────────
  // Canonical DDL owned by scaffold/schemas.ts (initScaffoldTables, run below),
  // for the same reason: one owner per table.

  // ── Agent-authored views ───────────────────────────────────────
  // Canonical DDL owned by views/store.ts (initViewTables, run below), for the
  // same reason the scaffold tables are: one owner per table.

  // ── Durable fibers (CLI equivalent of cf_agents_runs) ──────────
  `CREATE TABLE IF NOT EXISTS fibers (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    snapshot   TEXT,
    created_at INTEGER NOT NULL
  )`,


  // ── Conversation messages (simplified session tree) ────────────
  `CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL DEFAULT 'default',
    parent_id  TEXT,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    metadata   TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_msg_parent ON messages(parent_id)`,

  // ── Memory chunks — schema owned by MemoryStore (agent-utils) ──
  // NOT created here. MemoryStore.ensureSchema() creates the table
  // with its own schema (id TEXT, path, start_line, end_line, hash,
  // text, updated_at) plus FTS5 virtual table. Creating the table
  // here with a different schema would cause a conflict.
  //
  // For CLI (which uses inline memory, not MemoryStore), the test
  // helpers create their own simplified schema.

  // ── Evolution event log ────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS evolution_events (
    id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(9)))),
    type       TEXT NOT NULL,
    message    TEXT NOT NULL,
    data       TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,

  // ── Executor output log ────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS executor_output (
    id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(9)))),
    executor   TEXT NOT NULL,
    command    TEXT NOT NULL,
    stdout     TEXT,
    stderr     TEXT,
    exit_code  INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,

  // ── Activity log — real-time turn-level tracing ────────────────
  `CREATE TABLE IF NOT EXISTS activity_log (
    id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(9)))),
    event      TEXT NOT NULL,
    detail     TEXT,
    elapsed_ms INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at DESC, id DESC)`,
];

// ── Fork lineage — single-row table populated when this workspace is a
// fork. Empty otherwise. Written once by forkWorkspaceStorage and read by
// the getForkLineage RPC for the UI lineage chip.
const FORK_LINEAGE_DDL = `CREATE TABLE IF NOT EXISTS fork_lineage (
    id                            INTEGER PRIMARY KEY,
    source_workspace_id           TEXT    NOT NULL,
    source_workspace_name         TEXT    NOT NULL,
    source_message_id             TEXT    NOT NULL,
    source_message_created_at     INTEGER NOT NULL,
    forked_at                     INTEGER NOT NULL
  )`;

/**
 * Fork transfer staging — the state of the ONE unpublished fork transfer this
 * workspace is receiving. Empty on every workspace that is not mid-fork.
 *
 * A single row, because a target receives one transfer at a time: a second
 * `begin` replaces the first rather than racing it. Its columns are what
 * `identity/fork-staging.ts`'s `ForkStagingState` reads and writes; the reason
 * they are a TABLE rather than instance fields is written down there.
 */
const FORK_TRANSFER_DDL = `CREATE TABLE IF NOT EXISTS fork_transfer (
    id                       INTEGER PRIMARY KEY CHECK (id = 1),
    head_declared            INTEGER NOT NULL DEFAULT 0,
    head_source_id           TEXT    NOT NULL DEFAULT '',
    head_source_name         TEXT    NOT NULL DEFAULT '',
    head_cut_message_id      TEXT    NOT NULL DEFAULT '',
    head_cut_created_at      INTEGER NOT NULL DEFAULT 0,
    mission                  TEXT    NOT NULL DEFAULT '',
    pane_table_created       INTEGER NOT NULL DEFAULT 0,
    staged_agent_config      INTEGER NOT NULL DEFAULT 0,
    staged_crafted_tools     INTEGER NOT NULL DEFAULT 0,
    staged_memory_chunks     INTEGER NOT NULL DEFAULT 0,
    staged_pane_messages     INTEGER NOT NULL DEFAULT 0,
    staged_messages          INTEGER NOT NULL DEFAULT 0,
    staged_files             INTEGER NOT NULL DEFAULT 0,
    transfer_id              TEXT,
    expected_seq             INTEGER NOT NULL DEFAULT 0,
    section_cursor           INTEGER NOT NULL DEFAULT 0,
    stream                   TEXT    NOT NULL DEFAULT '',
    file_path                TEXT,
    file_bytes               INTEGER NOT NULL DEFAULT 0,
    want_agent_config        INTEGER NOT NULL DEFAULT 0,
    want_crafted_tools       INTEGER NOT NULL DEFAULT 0,
    want_memory_chunks       INTEGER NOT NULL DEFAULT 0,
    want_pane_messages       INTEGER NOT NULL DEFAULT 0,
    want_messages            INTEGER NOT NULL DEFAULT 0,
    want_files               INTEGER NOT NULL DEFAULT 0,
    published                INTEGER NOT NULL DEFAULT 0
  )`;

/** The files an unpublished transfer has already published into the target's
 *  plane. A replacement `begin` removes exactly these paths, so an abandoned
 *  attempt cannot leave a file behind — and the list survives the activation
 *  that wrote it, which is the whole point of it being a table. */
const FORK_STAGED_FILES_DDL = `CREATE TABLE IF NOT EXISTS fork_staged_files (
    path TEXT PRIMARY KEY
  )`;

/** Initialize state local to one full-loop actor without materializing a
 * workspace ownership root or independent fork lineage. */
export function initActorTables(execRaw: RawSqlExec, sql: SqlExecutor): void {
  for (const ddl of ACTOR_DDL) execRaw(ddl);
  initSearchTables(execRaw);
  initScaffoldTables(execRaw);
  initCraftedToolsTables(sql);
  initViewTables(execRaw);
  // The `state.*` sandbox namespace: what an execute_tools program saved for
  // the next one. Actor-local for the same reason `agent_views` is.
  initCodemodeStateTable(execRaw);
}

/** Initialize all workspace tables. Idempotent — safe to call on every startup. */
export function initAllTables(execRaw: RawSqlExec, sql: SqlExecutor): void {
  execRaw(WORKSPACE_IDENTITY_DDL);
  initActorTables(execRaw, sql);
  execRaw(FORK_LINEAGE_DDL);
  execRaw(FORK_TRANSFER_DDL);
  execRaw(FORK_STAGED_FILES_DDL);
}

/**
 * Whether a table exists in this workspace database.
 *
 * Exists so "the table is absent" is a VALUE a caller can branch on rather
 * than an exception it has to catch. A `catch` around a query cannot tell a
 * missing table from a syntax error, a locked database or a constraint
 * violation, and conflating them is how `workspace_capability` stayed invisible
 * for months. Portable across both backends — DO SQLite and bun:sqlite both
 * expose `sqlite_master`.
 */
export function tableExists(sql: SqlExecutor, table: string): boolean {
  return sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}
  `.length > 0;
}

/** The quoted, comma-joined form of a declared vocabulary for a DDL CHECK
 *  constraint, so a table's CHECK derives from the same list its type does. */
export function sqlCheckList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(',');
}

