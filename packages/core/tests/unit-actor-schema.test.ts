import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initActorTables, initAllTables, initScaffoldTables } from '../src/index.ts';

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

    initActorTables((ddl) => db.exec(ddl));

    const tables = tableNames(db);
    expect(tables).toContain('vfs_files');
    expect(tables).toContain('conversation_history');
    expect(tables).toContain('crafted_tools');
    expect(tables).not.toContain('workspace_identity');
    expect(tables).not.toContain('fork_lineage');
  });

  test('keeps the unified workspace initializer behavior intact', () => {
    const db = new Database(':memory:');

    initAllTables((ddl) => db.exec(ddl));

    const tables = tableNames(db);
    expect(tables).toContain('workspace_identity');
    expect(tables).toContain('vfs_files');
    expect(tables).toContain('fork_lineage');
  });

  test('scaffold_versions carries the columns the scaffold code reads, however it was created', () => {
    // The unified initializer used to own a second, drifted copy of this DDL:
    // a workspace created through it had no `status` / `parent_version`, so the
    // shadow rollout and the DGM lineage archive read columns that did not exist.
    for (const init of [initAllTables, initActorTables, initScaffoldTables]) {
      const db = new Database(':memory:');
      init((ddl) => db.exec(ddl));
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

    initAllTables((ddl) => db.exec(ddl));

    expect(columnNames(db, 'scaffold_versions')).toContain('status');
    expect(columnNames(db, 'scaffold_versions')).toContain('parent_version');
    expect(columnNames(db, 'scaffold_versions')).toContain('pathology');
    expect(db.query<{ version: number; status: string }, []>(
      `SELECT version, status FROM scaffold_versions`).all(),
    ).toEqual([{ version: 1, status: 'current' }]);
  });
});
