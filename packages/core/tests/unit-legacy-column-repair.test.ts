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

import { reconcileColumns } from '../src/identity/columns';
import { initWorkspaceSchema } from '../src/identity/workspace-schema';
import { initSearchTables } from '../src/mcts/schemas';
import { initBackgroundJobsTable } from '../src/jobs/store';
import { makeExecRaw, makeSql, makeSqlExec } from './helpers';

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

/** `background_jobs` as it stood before work_mode, input_json and the lease-epoch pair. */
const LEGACY_BACKGROUND_JOBS = `
  CREATE TABLE background_jobs (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    label      TEXT,
    status     TEXT NOT NULL DEFAULT 'running',
    result     TEXT,
    error      TEXT,
    created_at INTEGER NOT NULL,
    settled_at INTEGER
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

/**
 * `initWorkspaceSchema` is not the only way these tables come into existence. MCTS
 * self-initializes — `mcts/engine.ts` calls `initSearchTables` directly so a subsystem does not
 * need the unified schema — and a workspace that reaches `search_nodes` down that path gets no
 * legacy repair from the unified pass. The reconcile therefore lives at each table's own DDL site,
 * and these pin that: without it every assertion below still passed, because a fresh CREATE has
 * the columns anyway.
 */
describe('a standalone initializer repairs its own table', () => {
  test('initSearchTables reconciles a legacy table reached without the unified schema', () => {
    const db = new Database(':memory:');
    db.run(LEGACY_SEARCH_NODES);
    db.run(`INSERT INTO search_nodes (id, task) VALUES ('n1', 'inherited work')`);

    initSearchTables(makeExecRaw(db), makeSql(db));

    expect(columnsOf(db, 'search_nodes')).toEqual(
      expect.arrayContaining(['code_used', 'code_language', 'root_id']),
    );
    // `no such column: code_language at offset 74`, verbatim, on the path that has no legacy repair.
    expect(
      db
        .query<{ id: string; code_language: string | null }, []>(
          `SELECT id, code_language FROM search_nodes`,
        )
        .all(),
    ).toEqual([{ id: 'n1', code_language: null }]);
  });

  test('initSearchTables builds idx_sn_root_status, which needs the reconciled root_id', () => {
    const db = new Database(':memory:');
    db.run(LEGACY_SEARCH_NODES);
    // The index over `root_id` is created after the reconcile for this reason: on a legacy table it
    // would otherwise fail with `no such column: root_id` at workspace open.
    expect(() => { initSearchTables(makeExecRaw(db), makeSql(db)); }).not.toThrow();
    expect(
      db.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='index'`).all(),
    ).toEqual(expect.arrayContaining([{ name: 'idx_sn_root_status' }]));
  });

  test('initBackgroundJobsTable reconciles a legacy registry, keeping the rows on it', () => {
    const db = new Database(':memory:');
    db.run(LEGACY_BACKGROUND_JOBS);
    db.run(`INSERT INTO background_jobs (id, kind, created_at) VALUES ('j1', 'run', 7)`);

    initBackgroundJobsTable(makeExecRaw(db), makeSql(db));

    expect(columnsOf(db, 'background_jobs')).toEqual(
      expect.arrayContaining(['work_mode', 'input_json', 'epoch', 'resume_attempts']),
    );
    // `work_mode` is NOT NULL, so the added column has to carry a constant default — an epoch of 0
    // and 'build' are what the reader would have inferred for a row written before either existed.
    expect(
      db
        .query<{ work_mode: string; epoch: number; resume_attempts: number }, []>(
          `SELECT work_mode, epoch, resume_attempts FROM background_jobs`,
        )
        .all(),
    ).toEqual([{ work_mode: 'build', epoch: 0, resume_attempts: 0 }]);
  });

  test('both are no-ops on a second call rather than a second ALTER', () => {
    const db = new Database(':memory:');
    db.run(LEGACY_SEARCH_NODES);
    db.run(LEGACY_BACKGROUND_JOBS);
    const open = (): void => {
      initSearchTables(makeExecRaw(db), makeSql(db));
      initBackgroundJobsTable(makeExecRaw(db), makeSql(db));
    };
    open();
    const after = [columnsOf(db, 'search_nodes'), columnsOf(db, 'background_jobs')];
    expect(open).not.toThrow();
    expect([columnsOf(db, 'search_nodes'), columnsOf(db, 'background_jobs')]).toEqual(after);
  });
});
