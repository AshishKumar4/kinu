// One schema, one path: each initializer the entry point owns runs alone and its tables must exist
// after `initWorkspaceSchema`. The actor tier must be a subset of the root tier.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  initActorStateSchema, initWorkspaceSchema, type WorkspaceSchemaSql,
} from '../src/state/workspace-schema';
import { wrapDatabase } from '../src/identity/inline-primitives';
import { normalizeObservedTables } from '../src/conformance';
import { initMemoryChunkTables } from '@kinu.run/agent-utils/memory';
import { initWorkspaceOwnershipTables } from '../src/identity/schema';
import { initWorkspaceActorTable } from '../src/identity/workspace-actors';
import { initEffectTombstoneTable } from '../src/identity/effect-tombstones';
import { initAgentConfigTable } from '../src/config/store';
import { initCurriculumTable } from '../src/curriculum/proposer';
import { initEventsHubTables } from '../src/events/hub/schema';
import { initRunEventTables } from '../src/events/recorder';
import { initActorClaimTables } from '../src/orchestrator/actor-claims';
import { initGepaTables } from '../src/evolution/gepa/persistence';
import { initLessonTables } from '../src/evolution/lessons';
import { initTurnRatingTables } from '../src/evolution/ratings';
import { initRefinementTables } from '../src/evolution/refinement';
import { initImportedExperienceTable } from '../src/experience/imports';
import { initHeadsTables } from '../src/heads/schema';
import { initBackgroundJobsTable } from '../src/jobs/store';
import { initToolEffectClaimTable } from '../src/tools/effect-claim';
import { initDeferredApprovalsTable } from '../src/safety/deferred-approval';
import { initInstructionApprovalsTable } from '../src/safety/instruction-trust';
import { initPlanReviewTable } from '../src/plans/review';
import { initAlternateTakesTable } from '../src/mcts/takes';
import { initMctsSearchTable } from '../src/mcts/search-store';
import { initSearchTables } from '../src/mcts/schemas';
import { initScaffoldTables } from '../src/scaffold/schemas';
import { initFactsTable } from '../src/memory/facts';
import { initTaskListTable } from '../src/tools/task-store';
import { initArtifactTables, initTrialTables } from '../src/evolution/artifact-schema';
import { initExplorationRecordsTable } from '../src/strategy/records';
import { initSwarmNodeRecords } from '../src/strategy/swarm-resume';
import { initCodemodeStateTable } from '../src/identity/program-state';
import { makeSqlExec } from './helpers';

/** Initializers the entry point owns, each wrapped in the call its module exposes (`execRaw`, `sql`, `exec`). */
const OWNED = {
  initWorkspaceOwnershipTables: (db) => initWorkspaceOwnershipTables(db.execRaw),
  initWorkspaceActorTable: (db) => initWorkspaceActorTable(db.execRaw),
  initSearchTables: (db) => initSearchTables(db.execRaw),
  initScaffoldTables: (db) => initScaffoldTables(db.execRaw),
  initCodemodeStateTable: (db) => initCodemodeStateTable(db.execRaw),
  initAlternateTakesTable: (db) => initAlternateTakesTable(db.execRaw),
  initExplorationRecordsTable: (db) => initExplorationRecordsTable(db.execRaw),
  initSwarmNodeRecords: (db) => initSwarmNodeRecords(db.execRaw),
  initLessonTables: (db) => initLessonTables(db.execRaw),
  initTurnRatingTables: (db) => initTurnRatingTables(db.execRaw),
  initRefinementTables: (db) => initRefinementTables(db.execRaw),
  initEventsHubTables: (db) => initEventsHubTables(db.exec),
  initHeadsTables: (db) => initHeadsTables(db.execRaw),
  initRunEventTables: (db) => initRunEventTables(db.execRaw),
  initActorClaimTables: (db) => initActorClaimTables(db.execRaw),
  initFactsTable: (db) => initFactsTable(db.execRaw),
  initCurriculumTable: (db) => initCurriculumTable(db.execRaw),
  initGepaTables: (db) => initGepaTables(db.execRaw),
  initBackgroundJobsTable: (db) => initBackgroundJobsTable(db.execRaw),
  initToolEffectClaimTable: (db) => initToolEffectClaimTable(db.execRaw),
  initEffectTombstoneTable: (db) => initEffectTombstoneTable(db.execRaw),
  initDeferredApprovalsTable: (db) => initDeferredApprovalsTable(db.execRaw),
  initPlanReviewTable: (db) => initPlanReviewTable(db.execRaw),
  initInstructionApprovalsTable: (db) => initInstructionApprovalsTable(db.execRaw),
  initTaskListTable: (db) => initTaskListTable(db.execRaw),
  initMctsSearchTable: (db) => initMctsSearchTable(db.execRaw),
  initImportedExperienceTable: (db) => initImportedExperienceTable(db.execRaw),
  initArtifactTables: (db) => initArtifactTables(db.execRaw),
  initTrialTables: (db) => initTrialTables(db.execRaw),
  initAgentConfigTable: (db) => initAgentConfigTable(db.execRaw),
  initMemoryChunkTables: (db) => initMemoryChunkTables(db.sql),
} satisfies Record<string, (db: WorkspaceSchemaSql) => void>;

/** The surface a workspace root has and an actor scope does not. */
const ROOT_ONLY_TABLES = [
  'agent_figures', 'agent_open_turns', 'ephemeral_slates', 'fork_lineage', 'fork_staged_files', 'fork_transfer', 'fork_transfer_counts',
  'slate_file_manifest', 'slate_live_share_users', 'slate_live_shares', 'slate_publications',
  'slate_share_users', 'slate_shares', 'slate_state', 'slate_versions',
  'slate_viewer_requests', 'slates', 'workspace_actors', 'workspace_identity',
];

/** The three dialects initWorkspaceSchema takes and its transaction, over one bun:sqlite handle; core may not import cli-backend. */
function schemaSql(db: InstanceType<typeof Database>): WorkspaceSchemaSql {
  return { ...wrapDatabase(db), exec: makeSqlExec(db) };
}

/** The real table set, with SQLite bookkeeping and FTS5 shadow tables folded away. */
function tablesOf(db: InstanceType<typeof Database>): Set<string> {
  return normalizeObservedTables(db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type = 'table'`,
  ).all().map((row) => row.name));
}

/** Every table with its columns: a second run that altered a column leaves the table set identical. */
function declaredColumns(db: InstanceType<typeof Database>) {
  return [...tablesOf(db)].sort().map((table) => ({
    table,
    columns: db.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all().map((row) => row.name),
  }));
}

function initialized(init: (db: WorkspaceSchemaSql) => void): Set<string> {
  const db = new Database(':memory:');

  try {
    init(schemaSql(db));

    return tablesOf(db);
  } finally {
    db.close();
  }
}

describe('workspace schema is the only path', () => {
  const workspaceTier = initialized(initWorkspaceSchema);
  const actorTier = initialized(initActorStateSchema);

  test('the entry point creates every table the initializers it owns create', () => {
    // Read as tables, so an initializer reached through another initializer still counts.
    const missing = Object.entries(OWNED)
      .map(([name, init]) => ({
        name,
        absent: [...initialized(init)].filter((table) => !workspaceTier.has(table)).sort(),
      }))
      .filter((row) => row.absent.length > 0);

    expect(missing).toEqual([]);
  });

  test('every owned initializer really creates tables (guards the guard)', () => {
    // An initializer that creates nothing makes its row above free.
    expect(Object.keys(OWNED).length).toBeGreaterThanOrEqual(30);

    const empty = Object.entries(OWNED)
      .filter(([, init]) => initialized(init).size === 0)
      .map(([name]) => name);

    expect(empty).toEqual([]);
  });

  test('an actor scope is the workspace tier minus the root\'s own surface', () => {
    // Both directions: actor-only tables would vanish when opened as a facet; root-only tables would
    // give a subordinate an ownership surface.
    expect([...actorTier].filter((table) => !workspaceTier.has(table))).toEqual([]);
    expect([...workspaceTier].filter((table) => !actorTier.has(table)).sort())
      .toEqual(ROOT_ONLY_TABLES);
  });

  test('the schema creates memory_note_chunks and its FTS index', () => {
    // Created by the schema, not by MemoryStore: a fork target or archive restore would otherwise have
    // readers and no table.
    const db = new Database(':memory:');
    initWorkspaceSchema(schemaSql(db));

    const rows = db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE name IN ('memory_note_chunks', 'memory_note_chunks_fts') ORDER BY name`,
    ).all();

    expect(rows).toEqual([{ name: 'memory_note_chunks' }, { name: 'memory_note_chunks_fts' }]);
    db.close();
  });

  test('both entry points are safe on a workspace that already has a schema', () => {
    // Idempotent: it runs on every boot and open, so a second run must change no column.
    const db = new Database(':memory:');
    const sql = schemaSql(db);
    initWorkspaceSchema(sql);
    const first = declaredColumns(db);

    initWorkspaceSchema(sql);
    expect(declaredColumns(db)).toEqual(first);

    // Opening an actor's state inside a booted workspace must add nothing.
    initActorStateSchema(sql);
    expect(declaredColumns(db)).toEqual(first);
    db.close();
  });

  test('a schema run that fails partway leaves no table behind', () => {
    // One transaction: a new workspace whose genesis stops mid-way must not open with some initializers' tables.
    const db = new Database(':memory:');
    const sql = schemaSql(db);
    let statements = 0;

    const failing: WorkspaceSchemaSql = {
      ...sql,
      execRaw: (ddl) => {
        statements++;

        if (statements === 50) throw new Error('the disk filled mid-genesis');
        sql.execRaw(ddl);
      },
    };

    expect(() => initWorkspaceSchema(failing)).toThrow('the disk filled mid-genesis');
    expect([...tablesOf(db)]).toEqual([]);
    db.close();
  });
});
