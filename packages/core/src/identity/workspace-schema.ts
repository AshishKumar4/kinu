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

import type { RawSqlExec, SqlExec, SqlExecutor } from '../types/primitives';
import { initMemoryChunkTables } from '@kinu/agent-utils/memory';
import { initAllTables, migrateWorkspaceStorage, tableExists } from './schema';
import { reconcileColumns } from './columns';
import { initAgentConfigTable } from '../config/store';
import { initCraftScoreTables } from '../craft/schemas';
import { initCurriculumTable } from '../curriculum/proposer';
import { initEventsHubTables } from '../events/hub/schema';
import { initRunEventTables } from '../events/recorder';
import { initGepaTables } from '../evolution/gepa/persistence';
import { initTurnOutcomeTables } from '../evolution/outcomes';
import { initReplayTables } from '../evolution/replay';
import { initImportedExperienceTable } from '../experience/imports';
import { initHeadsTables } from '../heads/schema';
import { initBackgroundJobsTable } from '../jobs/store';
import { initDeferredApprovalsTable } from '../safety/deferred-approval';
import { initPlanReviewTable } from '../plans/review';
import { initSearchTables, SEARCH_NODES_POST_RELEASE_COLUMNS } from '../mcts/schemas';
import { initAlternateTakesTable } from '../mcts/takes';
import { initMctsSearchTable } from '../mcts/search-store';
import { initFactsTable } from '../memory/facts';
import { initScaffoldTables } from '../scaffold/schemas';
import { initShadowTables } from '../scaffold/shadow';
import { initTaskListTable } from '../tasks/store';
import { initExplorationRecordsTable } from '../strategy/records';
import { initSwarmNodeRecords } from '../strategy/swarm-resume';

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
 * index. The tables are read by `@kinu/compaction`'s stores; the DDL lives
 * here because a workspace's table set is one list, and that package sits
 * above core in the dependency graph.
 */
function initCompactionStateTables(execRaw: RawSqlExec, sql: SqlExecutor): void {
  execRaw(`
    CREATE TABLE IF NOT EXISTS compaction_state (
      session_key        TEXT PRIMARY KEY,
      plan_json          TEXT,
      last_prompt_tokens INTEGER,
      measured_at_length INTEGER,
      force_compaction   INTEGER
    )
  `);
  // Tables created before overflow recovery existed lack the flag column.
  reconcileColumns(sql, execRaw, 'compaction_state', { force_compaction: 'INTEGER' });
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
 *
 * Every step asks before it acts and nothing here is guarded by a catch: a
 * destructive repair that reports success because the failure was swallowed is
 * strictly worse than a boot that stops and says which statement failed.
 */
function repairLegacyTables(execRaw: RawSqlExec, sql: SqlExecutor): void {
  // memory_chunks: the 3-column flat schema against MemoryStore's 7-column FTS5 one.
  const mcCols = sql<{ name: string }>`PRAGMA table_info(memory_chunks)`;
  if (mcCols.length > 0 && !mcCols.some((c) => c.name === 'start_line')) {
    // The FTS shadow goes first, and neither drop is guarded. `memory_chunks_fts`
    // is an external-content FTS5 index over `memory_chunks`, and `CREATE VIRTUAL
    // TABLE IF NOT EXISTS` is a no-op on one that still exists — so dropping the
    // content table first and then failing on the shadow leaves a stale index
    // over a rebuilt table, and every memory search returns nothing, forever,
    // with no error anywhere. In this order a failure leaves the pair exactly as
    // repairable as it was, and the next boot retries it.
    execRaw('DROP TABLE IF EXISTS memory_chunks_fts');
    execRaw('DROP TABLE IF EXISTS memory_chunks');
  }
  // search_nodes must gain its post-release columns BEFORE the unified CREATE pass, which builds
  // `idx_sn_root_status` over `root_id` and fails outright on a table that predates it. The column
  // list is not repeated here — it comes from mcts/schemas.ts, which owns the table's DDL and
  // reconciles the same list for the standalone `initSearchTables` path. Guarded on the table
  // existing rather than on the ALTER failing: this runs before the CREATE pass, so a fresh
  // workspace legitimately has no such table yet, and `reconcileColumns` rejects an absent one.
  if (tableExists(sql, 'search_nodes')) {
    reconcileColumns(sql, execRaw, 'search_nodes', SEARCH_NODES_POST_RELEASE_COLUMNS);
  }
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
    const old = sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table' AND name=${from}`;
    if (old.length === 0) continue;
    const already = sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table' AND name=${to}`;
    if (already.length > 0) continue;
    execRaw(`ALTER TABLE ${from} RENAME TO ${to}`);
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

  initAllTables(execRaw, sql);
  // Pre-current-schema storage (legacy identity table, agent_soul, TEXT-bound
  // SOUL.md rows) — repaired here so every read path stays a pure read.
  migrateWorkspaceStorage(sql, execRaw);

  initSearchTables(execRaw, sql);
  // Alternate-Takes sets: durable per-workspace, written by MCTS convergence
  // and by heads settlement, read by /takes and the orchestrator listing.
  // Created here rather than by "the first MCTS run" so a reader that finds no
  // table is a fault, not an empty result nobody can tell from no takes.
  initAlternateTakesTable(execRaw, sql);
  // The exploration leaderboard, and the identity columns a workspace created
  // before them is missing. Created here rather than only by the first swarm run
  // for the same reason as the takes above: the orchestrator's record RPCs read
  // it, and `no such table` on a workspace that has merely never searched is a
  // fault dressed as an empty leaderboard.
  initExplorationRecordsTable(execRaw, sql);
  // The per-node content a swarm RE-ENTRY reads. Created on every root rather than only
  // by the first swarm run, for the same reason the two above are: the conformance
  // harness observes `sqlite_master` on a workspace that has never searched, and a
  // table only a search creates would be a declared capability nothing could measure.
  initSwarmNodeRecords(execRaw);
  initScaffoldTables(execRaw, sql);
  initCraftScoreTables(execRaw);
  // The R3 outcome ledger, including its take_pick CHECK-widening rebuild.
  // Must run here rather than only in the lazy EvolutionEngine constructor: a
  // freshly-woken actor can serve pickAlternateTake → recordTurnOutcome before
  // any turn constructs the engine, and the legacy CHECK rejects the insert.
  initTurnOutcomeTables(execRaw, sql);
  // replay_evals, read by buildChangelog on every changelog view. Created here
  // rather than only by the lazy EvolutionEngine, for the same reason as the
  // outcome ledger above: the read path runs before anything constructs the
  // engine, and a read that cannot reach the table has to say so, not shrug.
  initReplayTables(execRaw, sql);
  // agent_log + reply_channels + triggers + peer_outbox, their partial indexes
  // and views. Spec: docs/ARCHITECTURE.md — "Events and ingress".
  initEventsHubTables(exec);
  // Branching-heads journal: head_journal, head_evidence, head_merge_results.
  initHeadsTables(execRaw, sql);
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
  initBackgroundJobsTable(execRaw, sql);
  // Gated actions parked on the owner while nobody was there to decide, and
  // their standing decisions. Durable because the wait is a night, not a
  // prompt window.
  initDeferredApprovalsTable(execRaw, sql);
  // Plan revisions and reviewer state outlive both the submitting turn and DO
  // eviction; the Outputs surface always reads this one authoritative stream.
  initPlanReviewTable(execRaw);
  // The agent's own task list, written by the `tasks` tool.
  initTaskListTable(execRaw);
  // Durable tree-search checkpoints: an evicted search resumes here, and both search
  // engines record what they ran with here.
  initMctsSearchTable(execRaw, sql);
  // Experience-import staging ledger, settled by the shared EvolutionEngine on
  // every root — not only where the `experience` tool happens to be wired.
  initImportedExperienceTable(execRaw);
  initCompactionStateTables(execRaw, sql);
  // Typed key/value config: model spec, reasoning effort, always-active skills.
  initAgentConfigTable(execRaw);
  // memory_chunks + its FTS5 index. Every composition root that builds a
  // MemoryStore also calls ensureSchema(), but a workspace opened by a path
  // that does not (a fork target, an archive restore) still has readers — the
  // same hole `craft_scores` had. The DDL stays owned by agent-utils.
  initMemoryChunkTables(sql);
}
