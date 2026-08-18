import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  initActorTables, initAllTables, initScaffoldTables, initSearchTables,
  initBackgroundJobsTable, migrateWorkspaceStorage, readForkLineage, readLatestSearchTree,
} from '../src/index';
import { makeSql, makeExecRaw } from './helpers';

function tableNames(db: Database): string[] {
  return db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
  ).all().map((row) => row.name);
}

function columnNames(db: Database, table: string): string[] {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

describe('actor schema', () => {
  test('initializes actor-local state without workspace identity or fork lineage', () => {
    const db = new Database(':memory:');

    initActorTables((ddl) => db.exec(ddl), makeSql(db));

    const tables = tableNames(db);

    expect(tables).toContain('crafted_tools');
    expect(tables).not.toContain('workspace_identity');
    expect(tables).not.toContain('fork_lineage');
  });

  test('keeps the unified workspace initializer behavior intact', () => {
    const db = new Database(':memory:');

    initAllTables((ddl) => db.exec(ddl), makeSql(db));

    const tables = tableNames(db);
    expect(tables).toContain('workspace_identity');

    expect(tables).toContain('fork_lineage');
  });

  test('scaffold_versions carries the columns the scaffold code reads, however it was created', () => {
    // The unified initializer used to own a second, drifted copy of this DDL:
    // a workspace created through it had no `status` / `parent_version`, so the
    // shadow rollout and the DGM lineage archive read columns that did not exist.
    for (const init of [initAllTables, initActorTables, initScaffoldTables]) {
      const db = new Database(':memory:');
      init((ddl) => db.exec(ddl), makeSql(db));
      expect(columnNames(db, 'scaffold_versions')).toEqual(
        ['version', 'written_at', 'rationale', 'canary_score', 'baseline_score', 'status', 'parent_version', 'pathology'],
      );
      db.close();
    }
  });

  test('a workspace created against the pre-status schema is migrated in place', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE scaffold_versions (
      version INTEGER PRIMARY KEY, written_at INTEGER NOT NULL, rationale TEXT NOT NULL,
      canary_score REAL, baseline_score REAL)`);
    db.exec(`INSERT INTO scaffold_versions (version, written_at, rationale) VALUES (1, 10, 'seed')`);

    initAllTables((ddl) => db.exec(ddl), makeSql(db));

    expect(columnNames(db, 'scaffold_versions')).toContain('status');
    expect(columnNames(db, 'scaffold_versions')).toContain('parent_version');
    expect(columnNames(db, 'scaffold_versions')).toContain('pathology');
    expect(db.query<{ version: number; status: string }, []>(
      `SELECT version, status FROM scaffold_versions`).all(),
    ).toEqual([{ version: 1, status: 'current' }]);
  });

  test('search_nodes carries the columns its readers select, however it was created', () => {
    // Same failure shape as scaffold_versions above: the unified initializer
    // owned a second copy of this DDL, so a column added to one was missing
    // from workspaces created through the other.
    for (const init of [initAllTables, initActorTables, initSearchTables]) {
      const db = new Database(':memory:');
      init((ddl) => db.exec(ddl), makeSql(db));
      const columns = columnNames(db, 'search_nodes');
      for (const column of ['code_used', 'code_language', 'root_id']) {
        expect(columns).toContain(column);
      }
      db.close();
    }
  });

  test('a workspace created before code_language can still be read', () => {
    // The live failure this reproduces:
    //   "Couldn't refresh live data for MCTS ... SQL query failed:
    //    no such column: code_language at offset 74: SQLITE_ERROR"
    // CREATE TABLE IF NOT EXISTS is a no-op on the existing table, so opening
    // an older workspace left every reader selecting a column that was absent.
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE search_nodes (
      id TEXT PRIMARY KEY, parent_id TEXT, task TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT '', observation TEXT NOT NULL DEFAULT '',
      visits INTEGER NOT NULL DEFAULT 0, value REAL NOT NULL DEFAULT 0,
      depth INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open',
      msg_id TEXT, branch_agent_key TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
    db.exec(`INSERT INTO search_nodes (id, task, depth, created_at) VALUES ('n1', 'audit', 0, 10)`);

    initAllTables((ddl) => db.exec(ddl), makeSql(db));

    expect(columnNames(db, 'search_nodes')).toContain('code_language');
    const sql = makeSql(db);
    // A pre-root_id row stays invisible to the scoped projection by design,
    // but the query must now run instead of throwing.
    expect(readLatestSearchTree(sql)).toEqual([]);

    void sql`INSERT INTO search_nodes (id, root_id, task, depth, created_at)
        VALUES (${'n2'}, ${'r1'}, ${'audit'}, ${0}, ${20})`;
    expect(readLatestSearchTree(sql).map((node) => node.id)).toEqual(['n2']);
  });

  test('background_jobs carries the columns every job read selects', () => {
    // Same trap: work_mode, input_json, epoch and resume_attempts were all
    // added after the table shipped, and get/list/listRunning select them by
    // name — so an older workspace could not read its own jobs at all.
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE background_jobs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT,
      status TEXT NOT NULL DEFAULT 'running', result TEXT, error TEXT,
      created_at INTEGER NOT NULL, settled_at INTEGER)`);
    db.exec(`INSERT INTO background_jobs (id, kind, created_at) VALUES ('j1', 'fork', 10)`);

    initBackgroundJobsTable((ddl) => db.exec(ddl), makeSql(db));

    for (const column of ['work_mode', 'input_json', 'epoch', 'resume_attempts']) {
      expect(columnNames(db, 'background_jobs')).toContain(column);
    }
    // The pre-plan-mode row reads back as a build turn rather than failing.
    expect(db.query<{ id: string; work_mode: string; epoch: number }, []>(
      `SELECT id, work_mode, epoch FROM background_jobs`).all(),
    ).toEqual([{ id: 'j1', work_mode: 'build', epoch: 0 }]);
  });

  test('workspace_identity gains mission without losing the row', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE workspace_identity (
      id TEXT NOT NULL, name TEXT NOT NULL, owner_user_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0)`);
    db.exec(`INSERT INTO workspace_identity (id, name, created_at) VALUES ('w1', 'jarvis', 10)`);

    initAllTables((ddl) => db.exec(ddl), makeSql(db));

    expect(db.query<{ name: string; mission: string }, []>(
      `SELECT name, mission FROM workspace_identity`).all(),
    ).toEqual([{ name: 'jarvis', mission: '' }]);
  });

  test("a pre-rename fork's lineage survives the agent→workspace rename", () => {
    const db = new Database(':memory:');
    const execRaw = makeExecRaw(db);
    const sql = makeSql(db);
    db.exec(`CREATE TABLE fork_lineage (
      id INTEGER PRIMARY KEY,
      source_agent_id TEXT NOT NULL, source_agent_name TEXT NOT NULL,
      source_message_id TEXT NOT NULL, source_message_created_at INTEGER NOT NULL,
      forked_at INTEGER NOT NULL)`);
    db.exec(`INSERT INTO fork_lineage
      (source_agent_id, source_agent_name, source_message_id, source_message_created_at, forked_at)
      VALUES ('SRC', 'atlas', 'm1', 20, 30)`);

    initAllTables(execRaw, makeSql(db));
    migrateWorkspaceStorage(sql, execRaw);

    expect(columnNames(db, 'fork_lineage')).toContain('source_workspace_id');
    expect(readForkLineage(sql)).toMatchObject({
      sourceWorkspaceId: 'SRC', sourceWorkspaceName: 'atlas', sourceMessageId: 'm1',
    });
  });

  test('reconciliation is idempotent on a current workspace', () => {
    const db = new Database(':memory:');
    const execRaw = makeExecRaw(db);
    initAllTables(execRaw, makeSql(db));
    const before = columnNames(db, 'search_nodes');

    initAllTables(execRaw, makeSql(db));
    migrateWorkspaceStorage(makeSql(db), execRaw);

    expect(columnNames(db, 'search_nodes')).toEqual(before);
  });
});
