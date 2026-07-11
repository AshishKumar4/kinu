/**
 * Unified schema — ALL workspace tables in one place.
 * Idempotent: every statement uses IF NOT EXISTS.
 *
 * This is the single source of truth for what constitutes a workspace:
 * ~20 tables in one SQLite file = one workspace (the container that owns the
 * file plane, sessions, evolution state, and its default orchestrator agent).
 */

import { VFS_SCHEMA_DDL } from '@proteus/agent-utils/vfs';
import type { RawSqlExec } from '../types/primitives.js';

const DDL = [
  // ── Workspace identity — the ownership root ────────────────────
  // Renamed from agent_identity with no back-compat migration by design —
  // the project is pre-production and the DB is recreated on deploy
  // (owner decision 2026-06-13).
  `CREATE TABLE IF NOT EXISTS workspace_identity (
    id         TEXT NOT NULL,
    name       TEXT NOT NULL,
    owner_user_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,

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

  // ── Fork lineage — single-row table populated when this workspace is a
  // fork. Empty otherwise. Written once by forkWorkspaceStorage and read by
  // the getForkLineage RPC for the UI lineage chip.
  `CREATE TABLE IF NOT EXISTS fork_lineage (
    id                            INTEGER PRIMARY KEY,
    source_workspace_id           TEXT    NOT NULL,
    source_workspace_name         TEXT    NOT NULL,
    source_message_id             TEXT    NOT NULL,
    source_message_created_at     INTEGER NOT NULL,
    forked_at                     INTEGER NOT NULL
  )`,
];

/** Initialize all workspace tables. Idempotent — safe to call on every startup. */
export function initAllTables(execRaw: RawSqlExec): void {
  for (const ddl of DDL) execRaw(ddl);
}
