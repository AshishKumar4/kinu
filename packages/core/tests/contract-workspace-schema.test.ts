// One schema, one path.
//
// `initWorkspaceSchema` only prevents the "which tables does a workspace have"
// defect class while it is the ONLY answer. The previous attempt at this
// deduplication — `cf-backend/src/actor-schema.ts` — was correct code that
// nothing called: it was written, never wired, and deleted months later with
// the four divergent copies still in place. Deduplication without enforcement
// does nothing.
//
// So this asserts the enforcement: every composition root that opens or boots
// a workspace calls the shared entry point, and none of them calls a table
// initializer the entry point owns. A root that needs a table the others do
// not still declares it — at the root, and in conformance/manifest.ts, which
// observes the real `sqlite_master` afterwards and fails if the two disagree.
//
// The owned list is read out of workspace-schema.ts's own source, so it cannot
// go stale: adding an initializer there immediately forbids it everywhere else.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { initWorkspaceSchema } from '../src/identity/workspace-schema.js';
import { wrapDatabase } from '../src/identity/create.js';
import { resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '../../..');
const read = (path: string): string => readFileSync(resolve(REPO, path), 'utf8');

/** Every composition root that boots or opens a workspace database. */
const ROOTS = [
  'packages/cf-backend/src/orchestrator.ts',
  'packages/cf-backend/src/subordinate-agent.ts',
  'packages/cli-backend/src/local-session.ts',
  'packages/cli-backend/src/open.ts',
  'packages/cli/src/agent-create.ts',
] as const;

const SCHEMA_MODULE = 'packages/core/src/identity/workspace-schema.ts';

/** The initializers the shared entry point calls — read from its body, not
 *  from a hand-kept list that could drift away from it. */
function ownedInitializers(): string[] {
  const source = read(SCHEMA_MODULE);
  const body = source.slice(source.indexOf('export function initWorkspaceSchema'));
  const names = new Set<string>();
  for (const m of body.matchAll(/\b(init[A-Z][A-Za-z]*)\(/g)) names.add(m[1]!);
  // Itself, and the private helper whose DDL is inline here.
  for (const own of ['initWorkspaceSchema', 'initCompactionStateTables']) names.delete(own);
  for (const m of read(SCHEMA_MODULE).matchAll(/^import \{ (init[A-Za-z]+) \}/gm)) names.add(m[1]!);
  return [...names].sort();
}

/** Source with comments and import statements removed — a mention in prose or
 *  an unused import is not a call site. */
function callableSource(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^import[\s\S]*?from\s+'[^']*';$/gm, '')
    .replace(/^import[\s\S]*?from\s+"[^"]*";$/gm, '');
}

describe('workspace schema is the only path', () => {
  const owned = ownedInitializers();

  test('the entry point owns the initializers the roots used to list one by one', () => {
    // A floor, not an exact list: the point of the module is that this grows.
    // Losing an entry means a table quietly left the shared set.
    expect(owned).toEqual(
      expect.arrayContaining([
        'initAgentConfigTable', 'initAllTables', 'initBackgroundJobsTable', 'initCraftScoreTables',
        'initCurriculumTable', 'initEventsHubTables', 'initFactsTable', 'initGepaTables',
        'initHeadsTables', 'initImportedExperienceTable', 'initMctsSearchTable', 'initRunEventTables',
        'initScaffoldTables', 'initSearchTables', 'initShadowTables', 'initTurnOutcomeTables',
      ]),
    );
  });

  test.each(ROOTS)('%s calls initWorkspaceSchema', (root) => {
    expect(callableSource(read(root))).toContain('initWorkspaceSchema(');
  });

  test.each(ROOTS)('%s calls no initializer the entry point owns', (root) => {
    const source = callableSource(read(root));
    const skipped = owned.filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(source));
    expect(skipped).toEqual([]);
  });

  test('the extractor sees a real list (guards the guard)', () => {
    // A regex that matched nothing would make every assertion above vacuous.
    expect(owned.length).toBeGreaterThanOrEqual(16);
  });
});

// The product_change -> release rename touched five tables holding approval and
// deployment records. Without a migration, CREATE TABLE IF NOT EXISTS would mint
// them empty beside the populated originals: nothing crashes, the audit trail
// just stops being visible. This asserts the rows survive.
/** The three dialects initWorkspaceSchema takes, over one bun:sqlite handle.
 *  Built here rather than imported from cli-backend, which core may not reach. */
function schemaSql(db: InstanceType<typeof Database>) {
  const wrapped = wrapDatabase(db);
  return {
    execRaw: wrapped.execRaw,
    sql: wrapped.sql,
    exec: {
      exec(query: string, ...bindings: unknown[]) {
        const rows = db.query(query).all(...(bindings as never[])) as Array<Record<string, unknown>>;
        return { toArray: () => rows };
      },
    },
  } as Parameters<typeof initWorkspaceSchema>[0];
}

describe('release table migration', () => {
  const LEGACY: ReadonlyArray<readonly [string, string]> = [
    ['product_source_bindings', 'release_sources'],
    ['product_change_requests', 'release_changes'],
    ['product_change_checks', 'release_checks'],
    ['product_change_approvals', 'release_approvals'],
    ['product_deployments', 'release_deployments'],
  ];

  test('rows written under the old names are readable under the new ones', () => {
    const db = new Database(':memory:');
    for (const [from] of LEGACY) {
      db.exec(`CREATE TABLE ${from} (id TEXT PRIMARY KEY, payload TEXT)`);
      db.exec(`INSERT INTO ${from} (id, payload) VALUES ('keep-me', 'audit trail')`);
    }
    initWorkspaceSchema(schemaSql(db));
    for (const [from, to] of LEGACY) {
      const row = db.query(`SELECT payload FROM ${to} WHERE id = 'keep-me'`).get() as { payload: string } | null;
      expect(row?.payload).toBe('audit trail');
      const orphan = db.query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
      ).get(from) as { name: string } | null;
      expect(orphan).toBeNull();
    }
    db.close();
  });

  test('a fresh workspace is untouched, and re-running is a no-op', () => {
    // The release tables are created by the release lane, not by the workspace
    // schema — so on a fresh database the rename has nothing to find and must
    // simply do nothing, twice, without throwing.
    const db = new Database(':memory:');
    expect(() => {
      initWorkspaceSchema(schemaSql(db));
      initWorkspaceSchema(schemaSql(db));
    }).not.toThrow();
    for (const [from] of LEGACY) {
      const revived = db.query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
      ).get(from);
      expect(revived).toBeNull();
    }
    db.close();
  });
});
