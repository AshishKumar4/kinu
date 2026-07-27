import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initActorTables, initAllTables } from '../src/index.ts';

function tableNames(db: Database): string[] {
  return db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
  ).all().map((row) => row.name);
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
});
