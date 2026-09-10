// One schema, one path — asserted by RUNNING it.
//
// `initWorkspaceSchema` only prevents the "which tables does a workspace have"
// defect class while it is the ONLY answer. The previous attempt at this
// deduplication — `cf-backend/src/actor-schema.ts` — was correct code that
// nothing called: it was written, never wired, and deleted months later with
// the four divergent copies still in place. Deduplication without enforcement
// does nothing.
//
// WHAT ENFORCES IT HERE. Every initializer the entry point owns is run ALONE on
// its own empty database, and its tables must already be present after the
// entry point ran: an initializer that left the shared list fails by name. The
// invariant is taken over the DDL, not over the entry point's source text,
// because a source-text form goes red for a spelling rather than for a defect:
// `initSearchTables`, `initScaffoldTables` and `initCraftedToolsTables` sit one
// level down inside `initActorTables`, so a regex over the entry point's own
// body does not see three names it still reaches, while every table they own is
// created. A gate that reads call names measures the call names; this one
// measures the schema.
//
// The two tiers are the second half. `initWorkspaceSchema` boots a workspace
// ROOT; `initActorStateSchema` opens one ACTOR's state inside a database that
// is not its own root (`cli-backend/src/open.ts` for a facet,
// `cf-backend/src/subordinate-agent.ts` for a subordinate, whose own comment
// says it has no ownership row and no root publication tables). What must hold
// is that the actor tier is a SUBSET: an actor opened anywhere has every table
// its readers need, and the difference is exactly the root's own surface.
//
// WHAT IS NOT HERE. Whether each composition root reaches one of these two
// entry points at boot is observed where the roots actually boot, against
// `conformance/manifest.ts`: `packages/cf-backend/tests/conformance.test.ts` and
// `packages/cli/tests/conformance.test.ts` read the real `sqlite_master` of a
// booted root and fail on any disagreement in either direction. Restating that
// here as a scan for initializer NAMES in each root's source is how this file
// came to fail on a call that moved.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  initActorStateSchema, initWorkspaceSchema, type WorkspaceSchemaSql,
} from '../src/state/workspace-schema';
import { wrapDatabase } from '../src/identity/create';
import { normalizeObservedTables } from '../src/conformance';
import { initMemoryChunkTables } from '@kinu.run/agent-utils/memory';
import { initActorTables, initWorkspaceOwnershipTables } from '../src/identity/schema';
import { initWorkspaceActorTable } from '../src/identity/workspace-actors';
import { initEffectTombstoneTable } from '../src/identity/effect-tombstones';
import { initAgentConfigTable } from '../src/config/store';
import { initCurriculumTable } from '../src/curriculum/proposer';
import { initEventsHubTables } from '../src/events/hub/schema';
import { initRunEventTables } from '../src/events/recorder';
import { initActorClaimTables } from '../src/orchestrator/actor-claims';
import { initGepaTables } from '../src/evolution/gepa/persistence';
import { initTurnOutcomeTables } from '../src/evolution/outcomes';
import { initReplayTables } from '../src/evolution/replay';
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
import { initShadowTables } from '../src/scaffold/shadow';
import { initTaskListTable } from '../src/tasks/store';
import { initPromptSectionTables } from '../src/prompting/section-store';
import { initExplorationRecordsTable } from '../src/strategy/records';
import { initSwarmNodeRecords } from '../src/strategy/swarm-resume';
import { initCodemodeStateTable } from '../src/identity/program-state';
import { makeSqlExec } from './helpers';

/**
 * The initializers the shared entry point owns, each wrapped in the call its
 * owner module actually exposes — DDL takes `execRaw`, the CHECK-derived
 * tables read their own stored definition through `sql`, and the events hub
 * inspects results through `exec`, so a thunk per initializer rather than one
 * uniform signature.
 *
 * A NEW initializer added to the entry point is simply unmeasured here until
 * it is added; the direction that matters is the other one, which is a
 * regression: an initializer that stops being reached fails below by name.
 */
const OWNED = {
  initWorkspaceOwnershipTables: (db) => initWorkspaceOwnershipTables(db.execRaw),
  initWorkspaceActorTable: (db) => initWorkspaceActorTable(db.execRaw),
  initActorTables: (db) => initActorTables(db.execRaw, db.sql),
  initSearchTables: (db) => initSearchTables(db.execRaw),
  initScaffoldTables: (db) => initScaffoldTables(db.execRaw),
  initCodemodeStateTable: (db) => initCodemodeStateTable(db.execRaw),
  initAlternateTakesTable: (db) => initAlternateTakesTable(db.execRaw),
  initExplorationRecordsTable: (db) => initExplorationRecordsTable(db.execRaw),
  initSwarmNodeRecords: (db) => initSwarmNodeRecords(db.execRaw),
  initTurnOutcomeTables: (db) => initTurnOutcomeTables(db.execRaw),
  initReplayTables: (db) => initReplayTables(db.execRaw),
  initRefinementTables: (db) => initRefinementTables(db.execRaw),
  initEventsHubTables: (db) => initEventsHubTables(db.exec),
  initHeadsTables: (db) => initHeadsTables(db.execRaw),
  initShadowTables: (db) => initShadowTables(db.execRaw),
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
  initPromptSectionTables: (db) => initPromptSectionTables(db.execRaw),
  initAgentConfigTable: (db) => initAgentConfigTable(db.execRaw),
  initMemoryChunkTables: (db) => initMemoryChunkTables(db.sql),
} satisfies Record<string, (db: WorkspaceSchemaSql) => void>;

/**
 * The surface a workspace ROOT has and an actor scope does not: the ownership
 * row and its fork lineage, the actor DIRECTORY (a subordinate binds its one
 * actor from its own identity row instead — `conformance/manifest.ts` states
 * that per root), and the root's slate publication tables.
 */
const ROOT_ONLY_TABLES = [
  'fork_lineage', 'fork_staged_files', 'fork_transfer',
  'slate_content', 'slate_content_chunks', 'slate_deployment_reservations',
  'slate_deployments', 'slate_invocations', 'slate_previews', 'slate_publications',
  'slate_receipts', 'slate_resource_reservations', 'slate_resources', 'slate_versions',
  'slates', 'workspace_actors', 'workspace_identity',
];

/** The three dialects initWorkspaceSchema takes, over one bun:sqlite handle.
 *  Built here rather than imported from cli-backend, which core may not reach. */
function schemaSql(db: InstanceType<typeof Database>): WorkspaceSchemaSql {
  const wrapped = wrapDatabase(db);
  return { execRaw: wrapped.execRaw, sql: wrapped.sql, exec: makeSqlExec(db) };
}

/** The workspace's real table set, with SQLite's own bookkeeping and the FTS5
 *  shadow tables folded away — the same normalization the conformance observer
 *  applies to a booted root. */
function tablesOf(db: InstanceType<typeof Database>): Set<string> {
  return normalizeObservedTables(db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type = 'table'`,
  ).all().map((row) => row.name));
}

/** Every table with the columns it declares — what an idempotence claim is
 *  really about, since a second run that silently altered a column would leave
 *  the table set identical. */
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
    // The floor: one entry point owns it, not a table list re-declared at each
    // root. Read as tables, so an initializer reached through another
    // initializer still counts — and an initializer that quietly left the
    // shared set is named here with the tables it took with it.
    const missing = Object.entries(OWNED)
      .map(([name, init]) => ({
        name,
        absent: [...initialized(init)].filter((table) => !workspaceTier.has(table)).sort(),
      }))
      .filter((row) => row.absent.length > 0);
    expect(missing).toEqual([]);
  });

  test('every owned initializer really creates tables (guards the guard)', () => {
    // An initializer that creates nothing makes its row above free, and a
    // truncated map would make every row free.
    expect(Object.keys(OWNED).length).toBeGreaterThanOrEqual(30);
    const empty = Object.entries(OWNED)
      .filter(([, init]) => initialized(init).size === 0)
      .map(([name]) => name);
    expect(empty).toEqual([]);
  });

  test('an actor scope is the workspace tier minus the root\'s own surface', () => {
    // Both directions. A table the actor tier has and the root does not would
    // mean an actor opened in its own workspace loses a table it has when it is
    // opened as a facet; a root-only table drifting into the actor tier would
    // give a subordinate an ownership surface it must not have.
    expect([...actorTier].filter((table) => !workspaceTier.has(table))).toEqual([]);
    expect([...workspaceTier].filter((table) => !actorTier.has(table)).sort())
      .toEqual(ROOT_ONLY_TABLES);
  });

  test('the schema creates memory_chunks and its FTS index', () => {
    // Created by the schema itself, not by whichever path constructs a
    // MemoryStore: a workspace opened any other way (a fork target, an archive
    // restore) would have readers and no table, and a reader that swallows
    // "no such table" makes it indistinguishable from "indexed nothing" — the
    // same hole an unindexed memory plane leaves. Named separately from the
    // floor above because the FTS index is a VIRTUAL table the normalization
    // folds its shadows away from.
    const db = new Database(':memory:');
    initWorkspaceSchema(schemaSql(db));
    const rows = db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE name IN ('memory_chunks', 'memory_chunks_fts') ORDER BY name`,
    ).all();
    expect(rows).toEqual([{ name: 'memory_chunks' }, { name: 'memory_chunks_fts' }]);
    db.close();
  });

  test('both entry points are safe on a workspace that already has a schema', () => {
    // The module's own claim: idempotent, so it runs on every boot and every
    // open. Column lists too — a second run that added a column would be a
    // migration nobody declared.
    const db = new Database(':memory:');
    const sql = schemaSql(db);
    initWorkspaceSchema(sql);
    const first = declaredColumns(db);

    initWorkspaceSchema(sql);
    expect(declaredColumns(db)).toEqual(first);

    // And the actor tier over a root: opening an actor's state inside a
    // workspace that already booted must add nothing, which is what makes
    // `open.ts` free to call either one.
    initActorStateSchema(sql);
    expect(declaredColumns(db)).toEqual(first);
    db.close();
  });
});
