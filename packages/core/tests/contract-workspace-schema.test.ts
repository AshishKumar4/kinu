// One schema, one path: `initWorkspaceSchema` and `initActorStateSchema` create what a workspace and an actor use,
// safely over a schema already there, and a run that fails partway leaves nothing behind.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  initActorStateSchema, initWorkspaceSchema, type WorkspaceSchemaSql,
} from '../src/state/workspace-schema';
import { wrapDatabase } from '../src/identity/inline-primitives';
import { normalizeObservedTables } from '../src/conformance';
import { makeSqlExec } from './helpers';

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

describe('workspace schema is the only path', () => {
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
