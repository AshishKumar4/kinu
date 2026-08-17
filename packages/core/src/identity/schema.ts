/**
 * Unified schema — ALL workspace tables in one place.
 * Idempotent: every statement uses IF NOT EXISTS.
 *
 * This is the single source of truth for what constitutes a workspace:
 * ~20 tables in one SQLite file = one workspace (the container that owns the
 * file plane, sessions, evolution state, and its default orchestrator agent).
 */

import { reconcileColumns } from './columns.js';
import { initSearchTables } from '../mcts/schemas.js';
import { initScaffoldTables } from '../scaffold/schemas.js';
import { initViewTables } from '../views/store.js';
import type { RawSqlExec, SqlExecutor } from '../types/primitives.js';

export const WORKSPACE_IDENTITY_DDL =
  // ── Workspace identity — the ownership root ────────────────────
  // Renamed from agent_identity; hosted deployments are recreated rather than
  // migrated (owner decision 2026-06-13), but a local ~/.proteus workspace is
  // a file that outlives the rename, so migrateWorkspaceStorage adopts the
  // legacy row.
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
  // Canonical DDL owned by mcts/schemas.ts (initSearchTables, run below): it
  // carries the guarded ALTERs that add code_used, code_language and root_id
  // to workspaces created before those columns, and a second copy here is
  // exactly what let `code_language` go missing on a live workspace.

  // ── Scaffold management + task history ─────────────────────────
  // Canonical DDL owned by scaffold/schemas.ts (initScaffoldTables, run below):
  // it carries the shadow-rollout `status` and DGM `parent_version` columns plus
  // their in-place migration, and a second copy here would silently drift again.

  // ── Agent-authored views ───────────────────────────────────────
  // Canonical DDL owned by views/store.ts (initViewTables, run below), for the
  // same reason the scaffold tables are: one owner per table.

  // ── CraftStore quality tracking ────────────────────────────────
  `CREATE TABLE IF NOT EXISTS craft_scores (
    tool_name    TEXT PRIMARY KEY,
    score        REAL NOT NULL DEFAULT 0.5,
    uses         INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    created_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,

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

  // ── CraftStore tools ───────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS crafted_tools (
    name        TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    params      TEXT,
    code        TEXT NOT NULL DEFAULT '',
    scope       TEXT NOT NULL DEFAULT 'local',
    created_at  INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT 0
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

/** Initialize state local to one full-loop actor without materializing a
 * workspace ownership root or independent fork lineage. */
export function initActorTables(execRaw: RawSqlExec, sql: SqlExecutor): void {
  for (const ddl of ACTOR_DDL) execRaw(ddl);
  // Table creation first, reconciliation second, in the same call: both
  // helpers CREATE their own tables before asking `pragma_table_info` which
  // columns are missing. Dropping either call does not degrade to a no-op —
  // `reconcileColumns` throws on an absent table — so an actor without these
  // would fail at open, not run without search or scaffold state.
  initSearchTables(execRaw, sql);
  initScaffoldTables(execRaw, sql);
  initViewTables(execRaw);
}

/** Initialize all workspace tables. Idempotent — safe to call on every startup. */
export function initAllTables(execRaw: RawSqlExec, sql: SqlExecutor): void {
  execRaw(WORKSPACE_IDENTITY_DDL);
  // `mission` was added after this table shipped. `CREATE TABLE IF NOT EXISTS` is a
  // no-op on a workspace that predates it, while summarizeSoul writes it on every
  // fork — so the column is reconciled here, at the table's own DDL, by asking
  // `pragma_table_info` rather than by adding it and swallowing the failure.
  reconcileColumns(sql, execRaw, 'workspace_identity', { mission: `TEXT NOT NULL DEFAULT ''` });
  initActorTables(execRaw, sql);
  execRaw(FORK_LINEAGE_DDL);
}

/**
 * Bring a workspace created against an older schema up to the current one.
 * Idempotent, and it writes — every workspace-open path runs it right after
 * initAllTables, which is what keeps the read paths (`proteus list`,
 * `proteus status`, both of which open the database readonly) pure reads.
 */
export function migrateWorkspaceStorage(sql: SqlExecutor, execRaw: RawSqlExec): void {
  adoptLegacyAgentIdentity(sql);
  adoptLegacyForkLineage(sql, execRaw);
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

/** Move the pre-rename `agent_identity` row (identical columns) into
 *  workspace_identity. Without it an older local workspace loses its id, name
 *  and creation date, and openWorkspace rejects it as having no identity. */
function adoptLegacyAgentIdentity(sql: SqlExecutor): void {
  if (!tableExists(sql, 'agent_identity')) return;

  const claimed = sql<{ c: number }>`SELECT COUNT(*) AS c FROM workspace_identity`[0]?.c ?? 0;
  // `SELECT *`: owner_user_id was added to agent_identity after its first
  // release, so the oldest workspaces do not carry the column.
  const legacy = claimed === 0
    ? sql<{ id: string; name: string; owner_user_id?: string; created_at: number }>`
        SELECT * FROM agent_identity LIMIT 1
      `[0]
    : undefined;
  if (legacy) {
    void sql`INSERT INTO workspace_identity (id, name, owner_user_id, created_at)
        VALUES (${legacy.id}, ${legacy.name}, ${legacy.owner_user_id ?? ''}, ${legacy.created_at})`;
  }
  void sql`DROP TABLE agent_identity`;
}

/** Carry a pre-rename fork's lineage across the agent→workspace rename.
 *  `source_agent_id`/`source_agent_name` became `source_workspace_id`/
 *  `source_workspace_name`; the columns were renamed rather than added, so
 *  adding the new ones is not enough — the values live in the old ones, and
 *  readForkLineage selects the new names. Same reason as the identity
 *  adoption above: a local ~/.proteus workspace outlives the rename. */
function adoptLegacyForkLineage(sql: SqlExecutor, execRaw: RawSqlExec): void {
  const legacy = sql<{ name: string }>`
    SELECT name FROM pragma_table_info('fork_lineage') WHERE name = 'source_agent_id'
  `;
  if (legacy.length === 0) return;

  const rows = sql<{
    source_agent_id: string; source_agent_name: string;
    source_message_id: string; source_message_created_at: number; forked_at: number;
  }>`SELECT source_agent_id, source_agent_name, source_message_id,
            source_message_created_at, forked_at
     FROM fork_lineage ORDER BY id LIMIT 1`;
  void sql`DROP TABLE fork_lineage`;
  execRaw(FORK_LINEAGE_DDL);
  const row = rows[0];
  if (row) {
    void sql`INSERT INTO fork_lineage (source_workspace_id, source_workspace_name,
        source_message_id, source_message_created_at, forked_at)
      VALUES (${row.source_agent_id}, ${row.source_agent_name}, ${row.source_message_id},
        ${row.source_message_created_at}, ${row.forked_at})`;
  }
}
