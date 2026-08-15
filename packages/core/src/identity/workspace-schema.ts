/**
 * The workspace schema — the one answer to "which tables a workspace has".
 *
 * It used to be four answers. `ensureSchema` on the orchestrator DO, a second
 * `ensureSchema` on the subordinate DO, an eleven-call block in the CLI
 * session constructor, and `openWorkspaceCLI` each named their own subset, and
 * the subsets disagreed: `craft_scores` was never created by any local path
 * except `proteus create`, so every EMA read on a workspace opened any other
 * way silently no-opped; `imported_experience` was never created on cf, so the
 * `experience` tool's import action hard-errored in production. Neither is a
 * platform difference — both are a list someone forgot to copy.
 *
 * So the list lives here once, and each composition root calls
 * {@link initWorkspaceSchema}. Tables that genuinely belong to one root only
 * (the subordinate roster, the workspace capability token, webhook rate
 * windows) stay at that root and are declared per-root in
 * `conformance/manifest.ts`, which observes the real `sqlite_master` after
 * this has run and fails on any disagreement in either direction.
 *
 * Everything here is `CREATE TABLE IF NOT EXISTS` (or an idempotent repair),
 * so calling it on an existing workspace only ever adds what is missing.
 */

import type { RawSqlExec, SqlExec, SqlExecutor } from '../types/primitives.js';
import { initAllTables, migrateWorkspaceStorage } from './schema.js';
import { initAgentConfigTable } from '../config/store.js';
import { initCraftScoreTables } from '../craft/schemas.js';
import { initCurriculumTable } from '../curriculum/proposer.js';
import { initEventsHubTables } from '../events/hub/schema.js';
import { initRunEventTables } from '../events/recorder.js';
import { initGepaTables } from '../evolution/gepa/persistence.js';
import { initTurnOutcomeTables } from '../evolution/outcomes.js';
import { initImportedExperienceTable } from '../experience/imports.js';
import { initHeadsTables } from '../heads/schema.js';
import { initBackgroundJobsTable } from '../jobs/store.js';
import { initDeferredApprovalsTable } from '../safety/deferred-approval.js';
import { initPlanReviewTable } from '../plans/review.js';
import { initSearchTables } from '../mcts/schemas.js';
import { initMctsSearchTable } from '../mcts/search-store.js';
import { initFactsTable } from '../memory/facts.js';
import { initScaffoldTables } from '../scaffold/schemas.js';
import { initShadowTables } from '../scaffold/shadow.js';
import { initTaskListTable } from '../tasks/store.js';

/**
 * The three SQL handles onto one workspace database.
 *
 * Three rather than one because the initializers genuinely need three shapes:
 * DDL takes {@link RawSqlExec}, the migrations read literal queries through
 * {@link SqlExecutor}, and the events hub inspects `PRAGMA table_info` /
 * `sqlite_master` results through {@link SqlExec}. Every backend already holds
 * all three; passing them together is what keeps them pointed at one database.
 */
export interface WorkspaceSchemaSql {
  readonly execRaw: RawSqlExec;
  readonly sql: SqlExecutor;
  readonly exec: SqlExec;
}

/**
 * Compaction's replayable plan snapshot, measured trigger signal and archive
 * index. The tables are read by `@proteus/compaction`'s stores; the DDL lives
 * here because a workspace's table set is one list, and that package sits
 * above core in the dependency graph.
 */
function initCompactionStateTables(execRaw: RawSqlExec): void {
  execRaw(`
    CREATE TABLE IF NOT EXISTS compaction_state (
      session_key        TEXT PRIMARY KEY,
      plan_json          TEXT,
      last_prompt_tokens INTEGER,
      measured_at_length INTEGER,
      force_compaction   INTEGER
    )
  `);
  // Tables created before overflow recovery existed lack the flag column —
  // ADD COLUMN is idempotent-by-catch (SQLite errors on a duplicate column).
  try {
    execRaw(`ALTER TABLE compaction_state ADD COLUMN force_compaction INTEGER`);
  } catch { /* column already exists */ }
  execRaw(`
    CREATE TABLE IF NOT EXISTS compaction_archive (
      session_key     TEXT NOT NULL,
      range_hash      TEXT NOT NULL,
      path            TEXT NOT NULL,
      start_turn      INTEGER NOT NULL,
      end_turn        INTEGER NOT NULL,
      user_turns      INTEGER NOT NULL,
      assistant_turns INTEGER NOT NULL,
      first_user_ask  TEXT NOT NULL,
      PRIMARY KEY (session_key, range_hash)
    )
  `);
}

/**
 * Repair workspaces written against schemas that predate the current stores.
 *
 * These are destructive-on-purpose (an incompatible cache table is dropped and
 * rebuilt empty), which is why they run before the CREATE pass rather than
 * inside the individual initializers. Only the cf orchestrator did this; a
 * local workspace of the same vintage — or one forked down from the cloud —
 * hit the same incompatibility with no repair.
 */
function repairLegacyTables(execRaw: RawSqlExec, sql: SqlExecutor): void {
  try {
    // memory_chunks: the 3-column flat schema against MemoryStore's 7-column FTS5 one.
    const mcCols = sql<{ name: string }>`PRAGMA table_info(memory_chunks)`;
    if (mcCols.length > 0 && !mcCols.some((c) => c.name === 'start_line')) {
      execRaw('DROP TABLE IF EXISTS memory_chunks');
      execRaw('DROP TABLE IF EXISTS memory_chunks_fts');
    }
    // search_nodes: columns added after the table's first release.
    const snCols = sql<{ name: string }>`PRAGMA table_info(search_nodes)`;
    if (snCols.length > 0 && !snCols.some((c) => c.name === 'code_used')) {
      execRaw('ALTER TABLE search_nodes ADD COLUMN code_used TEXT');
    }
    if (snCols.length > 0 && !snCols.some((c) => c.name === 'root_id')) {
      execRaw('ALTER TABLE search_nodes ADD COLUMN root_id TEXT');
    }
  } catch { /* the tables do not exist yet — nothing to repair */ }
}

/**
 * product_change -> release. The lane kept its behaviour and lost its name, so
 * the rows must survive: approvals and deployment records are precisely the
 * audit trail an owner would least want silently discarded. Renaming without
 * this would leave CREATE TABLE IF NOT EXISTS quietly minting empty tables
 * beside the populated originals — nothing would crash, and the history would
 * simply stop being visible.
 *
 * Guarded both ways so it is a no-op on a fresh workspace and on one already
 * migrated, and safe to run on every boot.
 */
const RELEASE_TABLE_RENAMES: ReadonlyArray<readonly [from: string, to: string]> = [
  ['product_source_bindings', 'release_sources'],
  ['product_change_requests', 'release_changes'],
  ['product_change_checks', 'release_checks'],
  ['product_change_approvals', 'release_approvals'],
  ['product_deployments', 'release_deployments'],
];

function renameReleaseTables(execRaw: RawSqlExec, sql: SqlExecutor): void {
  for (const [from, to] of RELEASE_TABLE_RENAMES) {
    try {
      const old = sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table' AND name=${from}`;
      if (old.length === 0) continue;
      const already = sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table' AND name=${to}`;
      if (already.length > 0) continue;
      execRaw(`ALTER TABLE ${from} RENAME TO ${to}`);
    } catch { /* a backend without sqlite_master, or a concurrent boot won the race */ }
  }
}

/**
 * Create and migrate every table a workspace has, on any backend. Idempotent:
 * safe on every boot, on every open, and on a workspace created years ago.
 */
export function initWorkspaceSchema(db: WorkspaceSchemaSql): void {
  const { execRaw, sql, exec } = db;

  repairLegacyTables(execRaw, sql);
  renameReleaseTables(execRaw, sql);

  initAllTables(execRaw);
  // Pre-current-schema storage (legacy identity table, agent_soul, TEXT-bound
  // SOUL.md rows) — repaired here so every read path stays a pure read.
  migrateWorkspaceStorage(sql);

  initSearchTables(execRaw);
  initScaffoldTables(execRaw);
  initCraftScoreTables(execRaw);
  // The R3 outcome ledger, including its take_pick CHECK-widening rebuild.
  // Must run here rather than only in the lazy EvolutionEngine constructor: a
  // freshly-woken actor can serve pickAlternateTake → recordTurnOutcome before
  // any turn constructs the engine, and the legacy CHECK rejects the insert.
  initTurnOutcomeTables(execRaw, sql);
  // agent_log + reply_channels + triggers + peer_outbox, their partial indexes
  // and views. Spec: docs/ARCHITECTURE.md — "Events and ingress".
  initEventsHubTables(exec);
  // Branching-heads journal: head_journal, head_evidence, head_merge_results.
  initHeadsTables(execRaw);
  // Scaffold shadow-rollout ledger (scaffold_evaluations + its status column).
  initShadowTables(execRaw);
  // The durable per-run event log the frontends replay.
  initRunEventTables(execRaw);
  // agent_facts world model — keyed JSON facts with confidence and recency.
  initFactsTable(execRaw);
  // Voyager curriculum proposed-tasks queue.
  initCurriculumTable(execRaw);
  // GEPA run + candidate history (gepa_runs, gepa_candidates,
  // gepa_pareto_membership), written by the evolution control plane.
  initGepaTables(execRaw);
  // Background-job registry — work auto-detached past the 30s threshold.
  initBackgroundJobsTable(execRaw);
  // Gated actions parked on the owner while nobody was there to decide, and
  // their standing decisions. Durable because the wait is a night, not a
  // prompt window.
  initDeferredApprovalsTable(execRaw);
  // Plan revisions and reviewer state outlive both the submitting turn and DO
  // eviction; the Outputs surface always reads this one authoritative stream.
  initPlanReviewTable(execRaw);
  // The agent's own task list, written by the `tasks` tool.
  initTaskListTable(execRaw);
  // Durable MCTS search checkpoints: an evicted fork(settle=mcts) resumes here.
  initMctsSearchTable(execRaw);
  // Experience-import staging ledger, settled by the shared EvolutionEngine on
  // every root — not only where the `experience` tool happens to be wired.
  initImportedExperienceTable(execRaw);
  initCompactionStateTables(execRaw);
  // Typed key/value config: model spec, reasoning effort, always-active skills.
  initAgentConfigTable(execRaw);
}
