// The one table list every composition root creates, in one idempotent transaction. Root-only tables are
// declared in `conformance/manifest.ts`, which checks `sqlite_master` against this.

import type { RawSqlExec, SqlExec, SqlExecutor, Storage } from '../types/primitives';
import { initMemoryChunkTables } from '@kinu.run/agent-utils/memory';
import { initActorTables, initWorkspaceOwnershipTables } from '../identity/schema';
import { initSlateShareTables } from '../slates/shares';
import { initSlateLiveShareTables } from '../slates/live-shares';
import { initWorkspaceActorTable } from '../identity/workspace-actors';
import { initEffectTombstoneTable } from '../identity/effect-tombstones';
import { initAgentConfigTable } from '../config/store';
import { initCurriculumTable } from '../curriculum/proposer';
import { initEventsHubTables } from '../events/hub/schema';
import { initRunEventTables } from '../events/recorder';
import { initActorClaimTables } from '../orchestrator/actor-claims';
import { initGepaTables } from '../evolution/gepa/persistence';
import { initTurnOutcomeTables } from '../evolution/outcomes';
import { initReplayTables } from '../evolution/replay';
import { initRefinementTables } from '../evolution/refinement';
import { initImportedExperienceTable } from '../experience/imports';
import { initHeadsTables } from '../heads/schema';
import { initBackgroundJobsTable } from '../jobs/store';
import { initToolEffectClaimTable } from '../tools/effect-claim';
import { initDeferredApprovalsTable } from '../safety/deferred-approval';
import { initDeviceConsentRequestsTable } from '../safety/device-consent';
import { initInstructionApprovalsTable } from '../safety/instruction-trust';
import { initPlanReviewTable } from '../plans/review';
import { initAlternateTakesTable } from '../mcts/takes';
import { initMctsSearchTable } from '../mcts/search-store';
import { initFactsTable } from '../memory/facts';
import { initShadowTables } from '../scaffold/shadow';
import { initTaskListTable } from '../tasks/store';
import { initPromptSectionTables } from '../prompting/section-store';
import { initSlateStateTable } from '../slates/state';
import { initExplorationRecordsTable } from '../strategy/records';
import { initSwarmNodeRecords } from '../strategy/swarm-resume';
import { initAgentDataTables } from '../tools/db-codemode';
import { initCacheWarmTable } from '../providers/cache-warming';

/** Three handle shapes onto one database; initializers need each. */
export interface WorkspaceSchemaSql {
  readonly execRaw: RawSqlExec;
  readonly sql: SqlExecutor;
  readonly exec: SqlExec;
  readonly transactionSync: Storage['transactionSync'];
}

// Read by `@kinu.run/compaction`. Actor-keyed: two actors can present the same session key.
function initCompactionStateTables(execRaw: RawSqlExec): void {
  execRaw(`
    CREATE TABLE IF NOT EXISTS compaction_state (
      actor_id           TEXT NOT NULL,
      session_key        TEXT NOT NULL,
      plan_json          TEXT,
      last_prompt_tokens INTEGER,
      measured_at_length INTEGER,
      force_compaction   INTEGER,
      PRIMARY KEY (actor_id, session_key)
    )
  `);
  execRaw(`
    CREATE TABLE IF NOT EXISTS compaction_archive (
      actor_id        TEXT NOT NULL,
      session_key     TEXT NOT NULL,
      range_hash      TEXT NOT NULL,
      path            TEXT NOT NULL,
      start_turn      INTEGER NOT NULL,
      end_turn        INTEGER NOT NULL,
      user_turns      INTEGER NOT NULL,
      assistant_turns INTEGER NOT NULL,
      first_user_ask  TEXT NOT NULL,
      PRIMARY KEY (actor_id, session_key, range_hash)
    )
  `);
}

export function initWorkspaceSchema(db: WorkspaceSchemaSql): void {
  db.transactionSync(() => { createWorkspaceTables(db); });
}

function createWorkspaceTables(db: WorkspaceSchemaSql): void {
  const { execRaw } = db;
  initWorkspaceOwnershipTables(execRaw);
  initWorkspaceActorTable(execRaw);
  initActorStateSchema(db);
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
  initSlateStateTable(execRaw);
  initSlateShareTables(execRaw);
  initSlateLiveShareTables(execRaw);
}

export function initActorStateSchema(db: WorkspaceSchemaSql): void {
  const { execRaw, sql, exec } = db;
  initActorTables(execRaw, sql);
  // On every root, not lazily by a first writer: a missing table is a fault, not an empty read.
  initAlternateTakesTable(execRaw);
  initExplorationRecordsTable(execRaw);
  initSwarmNodeRecords(execRaw);
  // A woken actor can record outcomes before any turn constructs EvolutionEngine.
  initTurnOutcomeTables(execRaw);
  initReplayTables(execRaw);
  initRefinementTables(execRaw);
  // Spec: docs/ARCHITECTURE.md, "Events and ingress".
  initEventsHubTables(exec);
  initHeadsTables(execRaw);
  initShadowTables(execRaw);
  initRunEventTables(execRaw);
  initActorClaimTables(execRaw);
  initFactsTable(execRaw);
  initCurriculumTable(execRaw);
  initGepaTables(execRaw);
  initBackgroundJobsTable(execRaw);
  initToolEffectClaimTable(execRaw);
  initEffectTombstoneTable(execRaw);
  initDeferredApprovalsTable(execRaw);
  initDeviceConsentRequestsTable(execRaw);
  initPlanReviewTable(execRaw);
  // KINU-N028. A missing table must not fail open.
  initInstructionApprovalsTable(execRaw);
  initTaskListTable(execRaw);
  initMctsSearchTable(execRaw);
  initImportedExperienceTable(execRaw);
  initPromptSectionTables(execRaw);
  initCompactionStateTables(execRaw);
  initAgentConfigTable(execRaw);
  // Durable, not in-memory: a DO hibernates soon after going idle.
  initCacheWarmTable(execRaw);
  initAgentDataTables(execRaw);
  // Also here for paths that never build a MemoryStore (fork target, archive restore).
  initMemoryChunkTables(sql);
}
