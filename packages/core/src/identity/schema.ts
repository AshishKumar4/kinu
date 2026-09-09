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

  // ── Durable fibers (CLI equivalent of cf_agents_runs) ──────────
  // ACTOR-SCOPED: a fiber is a lane of ONE actor's work, and its name is minted
  // per lane ('advisor-lane', 'reactor', …) — so every actor in a workspace
  // presents the same fiber names, and a shared table would let a subordinate's
  // recovery sweep resume the root's lane.
  `CREATE TABLE IF NOT EXISTS fibers (
    actor_id   TEXT NOT NULL,
    id         TEXT NOT NULL,
    name       TEXT NOT NULL,
    snapshot   TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fibers_actor_name ON fibers(actor_id, name)`,


  // ── Conversation messages (simplified session tree) ────────────
  // ACTOR-SCOPED, in the primary key. A shared host holds several issued
  // actors in one database and a message id is minted per actor, so without the
  // actor in the key one actor's transcript is another's ancestry: the
  // recursive walks in identity/conversation-store.ts climb `parent_id` to
  // `id`, and an id that resolved in the wrong actor's rows would splice two
  // conversations into one chain. Both indexes lead with the actor for the same
  // reason — a session listing and a parent walk are per-actor questions.
  `CREATE TABLE IF NOT EXISTS messages (
    actor_id   TEXT NOT NULL,
    id         TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT 'default',
    parent_id  TEXT,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    metadata   TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (actor_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(actor_id, session_id, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_msg_parent ON messages(actor_id, parent_id)`,

  // ── Memory chunks — schema owned by MemoryStore (agent-utils) ──
  // NOT created here. MemoryStore.ensureSchema() creates the table
  // with its own schema (id TEXT, path, start_line, end_line, hash,
  // text, updated_at) plus FTS5 virtual table. Creating the table
  // here with a different schema would cause a conflict.
  //
  // For CLI (which uses inline memory, not MemoryStore), the test
  // helpers create their own simplified schema.

  // ── Evolution event log ────────────────────────────────────────
  // ACTOR-SCOPED: each actor evolves its own scaffold, prompt and facts, and
  // the timeline read model renders THIS actor's history.
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

  // ── Executor output log ────────────────────────────────────────
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

  // ── Activity log — real-time turn-level tracing ────────────────
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
  // NOT actor-local, and deliberately so — the one table in this function that
  // is not. `crafted_tools` is keyed `name TEXT PRIMARY KEY` and holds ONE
  // catalog per workspace: PRODUCT-SPEC.md:371 admits crafted tools as
  // additional tools whose availability "is intersected with the actor's role",
  // so eligibility is a filter on the tool SURFACE, not a predicate on storage.
  // Scoping the rows would give each actor a private catalog and silently
  // change what crafting means. It is created here because every actor's
  // runtime reads the catalog and no arm of the boot is guaranteed to have run
  // the full workspace schema first.
  initCraftedToolsTables(sql);
  // The `state.*` sandbox namespace: what an execute_tools program saved for
  // the next one. Actor-local: a program's saved state belongs to the actor
  // that ran it.
  initCodemodeStateTable(execRaw);
}

export function initWorkspaceOwnershipTables(execRaw: RawSqlExec): void {
  execRaw(WORKSPACE_IDENTITY_DDL);
  execRaw(FORK_LINEAGE_DDL);
  execRaw(FORK_TRANSFER_DDL);
  execRaw(FORK_STAGED_FILES_DDL);
}

/** Initialize a workspace ownership root and its actor state. */
export function initAllTables(execRaw: RawSqlExec, sql: SqlExecutor): void {
  initWorkspaceOwnershipTables(execRaw);
  initActorTables(execRaw, sql);
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
/**
 * The `fibers` table and its index, alone.
 *
 * ONE OWNER PER TABLE. A second, UNSCOPED copy of this DDL lets whichever
 * `CREATE TABLE IF NOT EXISTS` runs first decide the shape, and neither
 * outcome says so: when the unscoped copy wins its unscoped writes are
 * self-consistent and nothing complains, and when the workspace schema wins
 * every unscoped insert violates `actor_id NOT NULL` — a runtime failure that
 * typechecks clean. Exported for the same reason
 * `initAgentConfigTable` and `initScaffoldTables` are: a runtime can be built
 * without running the whole workspace schema, and it must then reach the
 * canonical DDL rather than carry a copy of it.
 */
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

