/**
 * Unified schema — ALL workspace tables in one place.
 * Idempotent: every statement uses IF NOT EXISTS.
 *
 * This is the single source of truth for what constitutes a workspace:
 * ~20 tables in one SQLite file = one workspace (the container that owns the
 * file plane, sessions, evolution state, and its default orchestrator agent).
 */

import { VFS_SCHEMA_DDL } from '@proteus/agent-utils/vfs';
import { migrateSoulStorage } from './soul.js';
import type { RawSqlExec, SqlExecutor } from '../types/primitives.js';

const WORKSPACE_IDENTITY_DDL =
  // ── Workspace identity — the ownership root ────────────────────
  // Renamed from agent_identity; hosted deployments are recreated rather than
  // migrated (owner decision 2026-06-13), but a local ~/.proteus workspace is
  // a file that outlives the rename, so migrateWorkspaceStorage adopts the
  // legacy row.
  `CREATE TABLE IF NOT EXISTS workspace_identity (
    id         TEXT NOT NULL,
    name       TEXT NOT NULL,
    owner_user_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`;

/** Durable state owned by every full-loop actor, including facet actors. */
const ACTOR_DDL = [
  // ── MCTS search tree ───────────────────────────────────────────
  // BUG-1 FIX: value defaults to 0, NOT 0.5
  `CREATE TABLE IF NOT EXISTS search_nodes (
    id               TEXT PRIMARY KEY,
    parent_id        TEXT REFERENCES search_nodes(id) ON DELETE CASCADE,
    task             TEXT NOT NULL,
    action           TEXT NOT NULL DEFAULT '',
    observation      TEXT NOT NULL DEFAULT '',
    code_used        TEXT,
    visits           INTEGER NOT NULL DEFAULT 0,
    value            REAL NOT NULL DEFAULT 0,
    depth            INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'open'
                     CHECK(status IN ('open','terminal','failed','pruned')),
    msg_id           TEXT,
    branch_agent_key TEXT,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sn_parent ON search_nodes(parent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sn_status_value ON search_nodes(status, value DESC)`,

  // ── Scaffold management ────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS scaffold_versions (
    version        INTEGER PRIMARY KEY,
    written_at     INTEGER NOT NULL,
    rationale      TEXT NOT NULL,
    canary_score   REAL,
    baseline_score REAL
  )`,

  `CREATE TABLE IF NOT EXISTS scaffold_regression_fixtures (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(9)))),
    task              TEXT NOT NULL,
    expected_keywords TEXT NOT NULL,
    created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,

  // ── Task history (for calibration + error monitoring) ──────────
  `CREATE TABLE IF NOT EXISTS task_history (
    id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(9)))),
    task             TEXT NOT NULL,
    scaffold_version INTEGER NOT NULL DEFAULT 0,
    outcome          TEXT NOT NULL DEFAULT 'success'
                     CHECK(outcome IN ('success','error','timeout')),
    score            REAL,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,

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

  // ── Virtual filesystem — canonical DDL owned by SqliteFS (agent-utils) ──
  ...VFS_SCHEMA_DDL,

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

  // ── Full conversation history (CoreMessage as JSON for LLM context) ──
  // Each row is one ModelMessage (user, assistant with tool_call parts,
  // or tool with tool_result parts). Stored as JSON for full fidelity.
  `CREATE TABLE IF NOT EXISTS conversation_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL DEFAULT 'default',
    role       TEXT NOT NULL,
    message    TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_convhist_session ON conversation_history(session_id)`,

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

const DDL = [WORKSPACE_IDENTITY_DDL, ...ACTOR_DDL, FORK_LINEAGE_DDL];

/** Initialize state local to one full-loop actor without materializing a
 * workspace ownership root or independent fork lineage. */
export function initActorTables(execRaw: RawSqlExec): void {
  for (const ddl of ACTOR_DDL) execRaw(ddl);
}

/** Initialize all workspace tables. Idempotent — safe to call on every startup. */
export function initAllTables(execRaw: RawSqlExec): void {
  for (const ddl of DDL) execRaw(ddl);
}

/**
 * Bring a workspace created against an older schema up to the current one.
 * Idempotent, and it writes — every workspace-open path runs it right after
 * initAllTables, which is what keeps the read paths (`proteus list`,
 * `proteus status`, both of which open the database readonly) pure reads.
 */
export function migrateWorkspaceStorage(sql: SqlExecutor): void {
  adoptLegacyAgentIdentity(sql);
  migrateSoulStorage(sql);
}

/** Move the pre-rename `agent_identity` row (identical columns) into
 *  workspace_identity. Without it an older local workspace loses its id, name
 *  and creation date, and openWorkspace rejects it as having no identity. */
function adoptLegacyAgentIdentity(sql: SqlExecutor): void {
  const legacyTable = sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_identity'
  `;
  if (legacyTable.length === 0) return;

  const claimed = sql<{ c: number }>`SELECT COUNT(*) AS c FROM workspace_identity`[0]?.c ?? 0;
  // `SELECT *`: owner_user_id was added to agent_identity after its first
  // release, so the oldest workspaces do not carry the column.
  const legacy = claimed === 0
    ? sql<{ id: string; name: string; owner_user_id?: string; created_at: number }>`
        SELECT * FROM agent_identity LIMIT 1
      `[0]
    : undefined;
  if (legacy) {
    sql`INSERT INTO workspace_identity (id, name, owner_user_id, created_at)
        VALUES (${legacy.id}, ${legacy.name}, ${legacy.owner_user_id ?? ''}, ${legacy.created_at})`;
  }
  sql`DROP TABLE agent_identity`;
}
