/**
 * The workspace schema — the one answer to "which tables a workspace has".
 *
 * It used to be four answers. `ensureSchema` on the orchestrator DO, a second
 * `ensureSchema` on the subordinate DO, an eleven-call block in the CLI
 * session constructor, and `openWorkspaceCLI` each named their own subset, and
 * the subsets disagreed: crafted-tool quality was never created by every local path
 * except `kinu create`, so every EMA read on a workspace opened any other
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
 * Everything here is `CREATE TABLE IF NOT EXISTS`, so calling it on an existing
 * workspace only ever adds what is missing.
 */

import type { RawSqlExec, SqlExec, SqlExecutor } from '../types/primitives';
import { initMemoryChunkTables } from '@kinu.run/agent-utils/memory';
import { initAllTables } from './schema';
import { initEffectTombstoneTable } from './effect-tombstones';
import { initAgentConfigTable } from '../config/store';
import { initCurriculumTable } from '../curriculum/proposer';
import { initEventsHubTables } from '../events/hub/schema';
import { initRunEventTables } from '../events/recorder';
import { initGepaTables } from '../evolution/gepa/persistence';
import { initTurnOutcomeTables } from '../evolution/outcomes';
import { initReplayTables } from '../evolution/replay';
import { initRefinementTables } from '../evolution/refinement';
import { initImportedExperienceTable } from '../experience/imports';
import { initHeadsTables } from '../heads/schema';
import { initBackgroundJobsTable } from '../jobs/store';
import { initToolEffectClaimTable } from '../tools/effect-claim';
import { initDeferredApprovalsTable } from '../safety/deferred-approval';
import { initInstructionApprovalsTable } from '../safety/instruction-trust';
import { initPlanReviewTable } from '../plans/review';
import { initSearchTables } from '../mcts/schemas';
import { initAlternateTakesTable } from '../mcts/takes';
import { initMctsSearchTable } from '../mcts/search-store';
import { initFactsTable } from '../memory/facts';
import { initScaffoldTables } from '../scaffold/schemas';
import { initShadowTables } from '../scaffold/shadow';
import { initTaskListTable } from '../tasks/store';
import { initPromptSectionTables } from '../prompting/section-store';
import { initExplorationRecordsTable } from '../strategy/records';
import { initSwarmNodeRecords } from '../strategy/swarm-resume';

/**
 * The three SQL handles onto one workspace database.
 *
 * Three rather than one because the initializers genuinely need three shapes:
 * DDL takes {@link RawSqlExec}, the CHECK-derived tables read their own stored
 * definition through {@link SqlExecutor}, and the events hub inspects
 * `PRAGMA table_info` / `sqlite_master` results through {@link SqlExec}. Every
 * backend already holds all three; passing them together is what keeps them
 * pointed at one database.
 */
export interface WorkspaceSchemaSql {
  readonly execRaw: RawSqlExec;
  readonly sql: SqlExecutor;
  readonly exec: SqlExec;
}

/**
 * Compaction's replayable plan snapshot, measured trigger signal and archive
 * index. The tables are read by `@kinu.run/compaction`'s stores; the DDL lives
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
 * Create every table a workspace has, on any backend. Idempotent: safe on
 * every boot and on every open.
 */
export function initWorkspaceSchema(db: WorkspaceSchemaSql): void {
  const { execRaw, sql, exec } = db;

  initAllTables(execRaw, sql);
  initSearchTables(execRaw);
  // Alternate-Takes sets: durable per-workspace, written by MCTS convergence
  // and by heads settlement, read by /takes and the orchestrator listing.
  // Created here rather than by "the first MCTS run" so a reader that finds no
  // table is a fault, not an empty result nobody can tell from no takes.
  initAlternateTakesTable(execRaw);
  // The exploration leaderboard. Created here rather than only by the first swarm run
  // for the same reason as the takes above: the orchestrator's record RPCs read
  // it, and `no such table` on a workspace that has merely never searched is a
  // fault dressed as an empty leaderboard.
  initExplorationRecordsTable(execRaw);
  // The per-node content a swarm RE-ENTRY reads. Created on every root rather than only
  // by the first swarm run, for the same reason the two above are: the conformance
  // harness observes `sqlite_master` on a workspace that has never searched, and a
  // table only a search creates would be a declared capability nothing could measure.
  initSwarmNodeRecords(execRaw);
  initScaffoldTables(execRaw);
  // The R3 outcome ledger.
  // Must run here rather than only in the lazy EvolutionEngine constructor: a
  // freshly-woken actor can serve pickAlternateTake → recordTurnOutcome before
  // any turn constructs the engine.
  initTurnOutcomeTables(execRaw);
  // replay_evals, read by buildChangelog on every changelog view. Created here
  // rather than only by the lazy EvolutionEngine, for the same reason as the
  // outcome ledger above: the read path runs before anything constructs the
  // engine, and a read that cannot reach the table has to say so, not shrug.
  initReplayTables(execRaw);
  // refinement_requests, read by buildChangelog on every changelog view and by
  // the `/refine` status line. Same reason as the two ledgers above: the read
  // path runs before anything constructs the engine.
  initRefinementTables(execRaw);
  // agent_log + reply_channels + triggers, their partial indexes and views.
  // Spec: docs/ARCHITECTURE.md — "Events and ingress".
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
  // GEPA run + candidate history (gepa_runs, gepa_candidates), written by
  // the evolution control plane. The Pareto front is derived at read time.
  initGepaTables(execRaw);
  // Background-job registry — work auto-detached past the 30s threshold.
  initBackgroundJobsTable(execRaw);
  // The once-only boundary in front of a tool whose effects leave the process:
  // one row per claimed call, written before the effect and completed after it.
  // Created on every root because the wrapper runs on every root — a workspace
  // whose table were missing would fail the first claimed tool call it makes.
  initToolEffectClaimTable(execRaw);
  // The other half of once-only: the record that a keyed effect already ran,
  // kept after the row that ran it was retired. Created here rather than by any
  // one consumer because four unrelated subsystems read it and each one's own
  // rows are swept on a different schedule.
  initEffectTombstoneTable(execRaw);
  // Gated actions parked on the owner while nobody was there to decide, and
  // their standing decisions. Durable because the wait is a night, not a
  // prompt window.
  initDeferredApprovalsTable(execRaw);
  // Plan revisions and reviewer state outlive both the submitting turn and DO
  // eviction; the Outputs surface always reads this one authoritative stream.
  initPlanReviewTable(execRaw);
  // Owner decisions about which workspace instruction bytes may hold system
  // placement (KINU-N028). Created on every root because the prompt builder
  // classifies AGENTS.md and skills on every turn everywhere — a reader that
  // found no table would be a fault, not an empty result, and failing that read
  // open is exactly the bug.
  initInstructionApprovalsTable(execRaw);
  // The agent's own task list, written by the `tasks` tool.
  initTaskListTable(execRaw);
  // Durable tree-search checkpoints: an evicted search resumes here, and both search
  // engines record what they ran with here.
  initMctsSearchTable(execRaw);
  // Experience-import staging ledger, settled by the shared EvolutionEngine on
  // every root — not only where the `experience` tool happens to be wired.
  initImportedExperienceTable(execRaw);
  // Evolved prompt sections: proposed replacements and their shadow trials.
  // Created on every root because `buildSystemPromptSync` reads the promoted
  // rows on every turn everywhere — a table only the optimiser creates would
  // make the prompt builder's own read a `no such table` on a workspace that
  // has merely never optimised.
  initPromptSectionTables(execRaw);
  initCompactionStateTables(execRaw);
  execRaw(`CREATE TABLE IF NOT EXISTS slate_content (
    digest TEXT PRIMARY KEY, size INTEGER NOT NULL, hint TEXT
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS slate_content_chunks (
    digest TEXT NOT NULL REFERENCES slate_content(digest), offset INTEGER NOT NULL, bytes BLOB NOT NULL,
    PRIMARY KEY (digest, offset)
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS slates (
    id TEXT NOT NULL, workspace_id TEXT NOT NULL, revision INTEGER NOT NULL, bytes BLOB NOT NULL,
    PRIMARY KEY (id, revision)
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS slate_versions (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, slate_id TEXT NOT NULL, parent_id TEXT, bytes BLOB NOT NULL
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS slate_publications (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, slate_id TEXT NOT NULL, parent_id TEXT, bytes BLOB NOT NULL
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS slate_deployments (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, slate_id TEXT NOT NULL, parent_id TEXT, bytes BLOB NOT NULL
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS slate_resources (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, slate_id TEXT NOT NULL, parent_id TEXT, bytes BLOB NOT NULL
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS slate_previews (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, slate_id TEXT NOT NULL, parent_id TEXT, bytes BLOB NOT NULL
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS slate_deployment_reservations (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, slate_id TEXT NOT NULL, parent_id TEXT UNIQUE, bytes BLOB NOT NULL
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS slate_resource_reservations (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, slate_id TEXT NOT NULL, parent_id TEXT, bytes BLOB NOT NULL
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS slate_invocations (
    id TEXT PRIMARY KEY, slate_id TEXT NOT NULL, request TEXT NOT NULL, attempt INTEGER NOT NULL,
    owner_epoch TEXT NOT NULL, state TEXT NOT NULL
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS slate_receipts (
    id TEXT PRIMARY KEY, invocation_id TEXT NOT NULL REFERENCES slate_invocations(id),
    attempt INTEGER NOT NULL, outcome TEXT NOT NULL, error TEXT, finished_at INTEGER NOT NULL,
    UNIQUE (invocation_id, attempt)
  )`);
  // Typed key/value config: model spec, reasoning effort, always-active skills.
  initAgentConfigTable(execRaw);
  // memory_chunks + its FTS5 index. Every composition root that builds a
  // MemoryStore also calls ensureSchema(), but a workspace opened by a path
  // that does not (a fork target, an archive restore) still has readers — the
  // same hole an unindexed memory plane had. The DDL stays owned by agent-utils.
  initMemoryChunkTables(sql);
}
