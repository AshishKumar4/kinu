/**
 * A workspace created before a column existed must gain it on open.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on a table that already exists, so a column added to a
 * shipped table never reaches an older workspace while every reader still selects it by name. A live
 * workspace failed exactly this way with `no such column: code_language at offset 74`, months after
 * `search_nodes` gained the column.
 *
 * The old shape guessed — `try { ALTER TABLE … ADD COLUMN } catch { /* already present *\/ }` — which
 * cannot tell "the column is there" from "the table is locked", "the database is read-only" or "the
 * table was never created", so the migration reported success in all four cases. These tests pin the
 * asking form instead: which columns are missing is read from `pragma_table_info`, the ALTERs issued
 * are exactly those, and a failure propagates.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

import { reconcileColumns } from '../src/identity/columns.js';
import { initWorkspaceSchema } from '../src/identity/workspace-schema.js';
import { makeExecRaw, makeSql, makeSqlExec } from './helpers.js';

/** `search_nodes` as it stood before `code_used`, `code_language` and `root_id` were added. */
const LEGACY_SEARCH_NODES = `
  CREATE TABLE search_nodes (
    id          TEXT PRIMARY KEY,
    parent_id   TEXT REFERENCES search_nodes(id) ON DELETE CASCADE,
    task        TEXT NOT NULL,
    action      TEXT NOT NULL DEFAULT '',
    observation TEXT NOT NULL DEFAULT '',
    visits      INTEGER NOT NULL DEFAULT 0,
    value       REAL NOT NULL DEFAULT 0,
    depth       INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'open',
    msg_id      TEXT
  )
`;

function columnsOf(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, [string]>(`SELECT name FROM pragma_table_info(?)`)
    .all(table)
    .map((row) => row.name);
}

describe('opening a pre-column workspace', () => {
  test('search_nodes gains code_language, and a legacy row survives with it NULL', () => {
    const db = new Database(':memory:');
    db.run(LEGACY_SEARCH_NODES);
    db.run(`INSERT INTO search_nodes (id, task) VALUES ('n1', 'inherited work')`);
    expect(columnsOf(db, 'search_nodes')).not.toContain('code_language');

    initWorkspaceSchema({ execRaw: makeExecRaw(db), sql: makeSql(db), exec: makeSqlExec(db) });

    // The three columns `search_nodes` has gained since release, all of them.
    expect(columnsOf(db, 'search_nodes')).toEqual(
      expect.arrayContaining(['code_used', 'code_language', 'root_id']),
    );
    // The exact read that crashed the live workspace, now against the repaired table.
    const rows = db
      .query<{ id: string; code_language: string | null }, []>(
        `SELECT id, code_language FROM search_nodes`,
      )
      .all();
    expect(rows).toEqual([{ id: 'n1', code_language: null }]);
  });

  test('a second open is a no-op rather than a second ALTER', () => {
    const db = new Database(':memory:');
    db.run(LEGACY_SEARCH_NODES);
    const open = (): void => {
      initWorkspaceSchema({ execRaw: makeExecRaw(db), sql: makeSql(db), exec: makeSqlExec(db) });
    };
    open();
    const after = columnsOf(db, 'search_nodes');
    // The old guessing form issued the ALTER every time and relied on the throw. This must not
    // throw, because it must not issue the ALTER at all.
    expect(open).not.toThrow();
    expect(columnsOf(db, 'search_nodes')).toEqual(after);
  });

  test('a fresh workspace has the columns from its own CREATE, with nothing to repair', () => {
    const db = new Database(':memory:');
    initWorkspaceSchema({ execRaw: makeExecRaw(db), sql: makeSql(db), exec: makeSqlExec(db) });
    expect(columnsOf(db, 'search_nodes')).toEqual(
      expect.arrayContaining(['code_used', 'code_language', 'root_id']),
    );
  });
});

describe('reconcileColumns asks rather than guesses', () => {
  test('adds only the missing columns and leaves existing values intact', () => {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE t (id TEXT PRIMARY KEY, kept TEXT)`);
    db.run(`INSERT INTO t (id, kept) VALUES ('a', 'value')`);

    reconcileColumns(makeSql(db), makeExecRaw(db), 't', {
      kept: 'TEXT',
      added: "TEXT NOT NULL DEFAULT ''",
    });

    expect(columnsOf(db, 't')).toEqual(['id', 'kept', 'added']);
    expect(db.query<{ kept: string; added: string }, []>(`SELECT kept, added FROM t`).all()).toEqual(
      [{ kept: 'value', added: '' }],
    );
  });

  test('an absent table is reported, not read as "no columns present"', () => {
    const db = new Database(':memory:');
    // `pragma_table_info` returns zero rows for a table that does not exist rather than failing.
    // Doing nothing would leave the caller believing the shape was reconciled; issuing the ALTERs
    // would blame `no such table` on the column. Neither is acceptable, so it says which table.
    expect(() =>
      reconcileColumns(makeSql(db), makeExecRaw(db), 'ghost', { a: 'TEXT' }),
    ).toThrow(/table ghost does not exist/u);
  });

  test('a real DDL failure propagates instead of reading as "already present"', () => {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE t (id TEXT PRIMARY KEY)`);
    // Provoked, not assumed: SQLite answers `Cannot add a UNIQUE column` here, and
    // `Cannot add a NOT NULL column with default value NULL` once the table has rows — but NOT on
    // an empty table, which is why the second case seeds one. Under the old
    // `catch { /* already present */ }` every one of these reported success and added nothing.
    expect(() =>
      reconcileColumns(makeSql(db), makeExecRaw(db), 't', { tag: 'TEXT UNIQUE' }),
    ).toThrow(/Cannot add a UNIQUE column/u);
    expect(columnsOf(db, 't')).toEqual(['id']);

    db.run(`INSERT INTO t (id) VALUES ('a')`);
    expect(() =>
      reconcileColumns(makeSql(db), makeExecRaw(db), 't', { needed: 'TEXT NOT NULL' }),
    ).toThrow(/NOT NULL column with default value NULL/u);
    expect(columnsOf(db, 't')).toEqual(['id']);
  });
});
