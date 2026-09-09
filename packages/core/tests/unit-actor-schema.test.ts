import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  initActorTables, initAllTables, initScaffoldTables, initSearchTables,
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
    // ONE DDL behind every entry point. A second, drifting copy in the unified
    // initializer gives a workspace created through it no `status` /
    // `parent_version`, and the shadow rollout and the DGM lineage archive then
    // read columns that do not exist.
    for (const init of [initAllTables, initActorTables]) {
      const db = new Database(':memory:');
      init((ddl) => db.exec(ddl), makeSql(db));
      expect(columnNames(db, 'scaffold_versions')).toEqual(
        ['actor_id', 'version', 'written_at', 'rationale', 'canary_score', 'baseline_score',
          'status', 'parent_version', 'pathology'],
      );
      db.close();
    }
    {
      const db = new Database(':memory:');
      initScaffoldTables((ddl) => db.exec(ddl));
      expect(columnNames(db, 'scaffold_versions')).toEqual(
        ['actor_id', 'version', 'written_at', 'rationale', 'canary_score', 'baseline_score',
          'status', 'parent_version', 'pathology'],
      );
      db.close();
    }
  });

  test('search_nodes carries the columns its readers select, however it was created', () => {
    // Same failure shape as scaffold_versions above: a second copy of this DDL
    // in the unified initializer means a column added to one is missing from
    // workspaces created through the other.
    for (const init of [initAllTables, initActorTables]) {
      const db = new Database(':memory:');
      init((ddl) => db.exec(ddl), makeSql(db));
      const columns = columnNames(db, 'search_nodes');
      for (const column of ['code_used', 'code_language', 'root_id']) {
        expect(columns).toContain(column);
      }
      db.close();
    }
    {
      const db = new Database(':memory:');
      initSearchTables((ddl) => db.exec(ddl));
      const columns = columnNames(db, 'search_nodes');
      for (const column of ['code_used', 'code_language', 'root_id']) {
        expect(columns).toContain(column);
      }
      db.close();
    }
  });

  test('every init is idempotent on a current workspace', () => {
    const db = new Database(':memory:');
    const execRaw = makeExecRaw(db);
    initAllTables(execRaw, makeSql(db));
    const before = columnNames(db, 'search_nodes');

    initAllTables(execRaw, makeSql(db));

    expect(columnNames(db, 'search_nodes')).toEqual(before);
  });
});
