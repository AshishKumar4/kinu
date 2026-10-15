// A release's tables reset as one object carries it out: a reshaped table is rebuilt keeping its rows wherever a
// rolled-back trial finds the copy holds, with its referrers rebuilt alongside and its indexes, triggers and views made
// again after the copy; it loses its rows only where the copy fails, and says why. A removed table is dropped unless
// that would reach rows the release did not change. A rerun changes nothing, and only `/ops/tables`' capability is
// admitted.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { opsCaller, pragmaStamps, requireOps, resetTables, type ChangedTable, type TableWrites } from '../src/index';
import { sqlStorageOver } from '../src/identity/inline-primitives';
import type { SqlExec } from '../src/types/primitives';

const KEY = { CREDENTIAL_ENCRYPTION_KEY: 'a'.repeat(64) };

/** A database as the build before left it, and the candidate's init, which makes each table as it declares it now. */
function world(before: string, candidate: string) {
  const db = new Database(':memory:');
  const sql = sqlStorageOver(db);

  db.exec('PRAGMA foreign_keys = ON');
  db.exec(before);
  const writes: TableWrites = { schema: 'agent', stamps: pragmaStamps(sql), transactionSync: (write) => db.transaction(write)(), init: () => { db.exec(candidate); } };

  return { db, sql, writes };
}

const altered = (...tables: string[]): ChangedTable[] => tables.map((table) => ({ table, change: 'reshaped' }));

const RowSchema = v.record(v.string(), v.unknown());

const rows = (sql: SqlExec, query: string) => sql.exec(query).toArray().map((row) => v.parse(RowSchema, row));

test('a removed column SQLite refuses to drop is rebuilt away, every row and rowid kept, and a rerun changes nothing', () => {
  const { sql, writes } = world(`
    CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT, CHECK (digest IS NULL OR length(digest) = 4));
    CREATE INDEX notes_digest ON notes(digest);
    INSERT INTO notes (rowid, id, body, digest) VALUES (7, 'a', 'kept', 'abcd'), (9, 'b', 'also kept', NULL);`, `
    CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS notes_body ON notes(body);`);

  const planned = resetTables(sql, { tables: altered('notes'), drop: false }, writes);

  expect(planned.held).toEqual([{ table: 'notes', rows: 2, stale: true, keepsRows: true }]);
  expect(rows(sql, "SELECT name FROM sqlite_master WHERE name = 'notes_digest'")).toHaveLength(1);

  const done = resetTables(sql, { tables: altered('notes'), drop: true }, writes);

  expect({ rebuilt: done.rebuilt, dropped: done.dropped }).toEqual({ rebuilt: ['notes'], dropped: [] });
  expect(rows(sql, 'SELECT rowid AS r, id, body FROM notes ORDER BY id')).toEqual([{ r: 7, id: 'a', body: 'kept' }, { r: 9, id: 'b', body: 'also kept' }]);
  expect(rows(sql, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notes' AND sql IS NOT NULL")).toEqual([{ name: 'notes_body' }]);

  const again = resetTables(sql, { tables: altered('notes'), drop: true }, writes);

  expect({ held: again.held, rebuilt: again.rebuilt }).toEqual({ held: [{ table: 'notes', rows: 2, stale: false, keepsRows: true }], rebuilt: [] });
});

test('a relaxed constraint and a re-key from columns the table holds are rebuilt, and the view over it made again', () => {
  const { sql, writes } = world(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, seq INTEGER NOT NULL, task TEXT NOT NULL);
    CREATE VIEW open_tasks AS SELECT id, task FROM tasks;
    INSERT INTO tasks VALUES ('main:1', 'main', 1, 'write'), ('main:2', 'main', 2, 'read');`, `
    CREATE TABLE IF NOT EXISTS tasks (actor_id TEXT NOT NULL, seq INTEGER NOT NULL, task TEXT,
      id TEXT GENERATED ALWAYS AS (actor_id || ':' || seq) VIRTUAL, PRIMARY KEY (actor_id, seq)) WITHOUT ROWID;
    CREATE VIEW IF NOT EXISTS open_tasks AS SELECT id, task, seq FROM tasks;`);

  const done = resetTables(sql, { tables: altered('tasks'), drop: true }, writes);

  expect(done.rebuilt).toEqual(['tasks']);
  expect(rows(sql, 'SELECT id, task, seq FROM open_tasks ORDER BY seq')).toEqual([{ id: 'main:1', task: 'write', seq: 1 }, { id: 'main:2', task: 'read', seq: 2 }]);
  sql.exec("INSERT INTO tasks (actor_id, seq, task) VALUES ('main', 3, NULL)");
});

test('a table whose rows refer to a rebuilt one is rebuilt alongside, so no cascade takes its rows', () => {
  const { sql, writes } = world(`
    CREATE TABLE parents (id TEXT PRIMARY KEY, old TEXT);
    CREATE TABLE children (id TEXT PRIMARY KEY, parent TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE);
    INSERT INTO parents VALUES ('p', 'x');
    INSERT INTO children VALUES ('c', 'p');`, `
    CREATE TABLE IF NOT EXISTS parents (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS children (id TEXT PRIMARY KEY, parent TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE);`);

  const done = resetTables(sql, { tables: altered('parents'), drop: true }, writes);

  expect(done.rebuilt).toEqual(['parents', 'children']);
  expect(rows(sql, 'SELECT id, parent FROM children')).toEqual([{ id: 'c', parent: 'p' }]);
});

test('a trigger the candidate makes does not run on the rows the rebuild copies back', () => {
  const { sql, writes } = world(`
    CREATE TABLE entries (id INTEGER PRIMARY KEY, text TEXT, digest TEXT);
    CREATE TABLE entry_log (id INTEGER);
    CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN INSERT INTO entry_log VALUES (new.id); END;
    INSERT INTO entries VALUES (1, 'one', 'x'), (2, 'two', 'y');`, `
    CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, text TEXT);
    CREATE TABLE IF NOT EXISTS entry_log (id INTEGER);
    CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN INSERT INTO entry_log VALUES (new.id); END;`);

  expect(rows(sql, 'SELECT COUNT(*) AS n FROM entry_log')).toEqual([{ n: 2 }]);
  resetTables(sql, { tables: altered('entries'), drop: true }, writes);

  expect(rows(sql, 'SELECT COUNT(*) AS n FROM entry_log')).toEqual([{ n: 2 }]);
  sql.exec("INSERT INTO entries (id, text) VALUES (3, 'three')");
  expect(rows(sql, 'SELECT COUNT(*) AS n FROM entry_log')).toEqual([{ n: 3 }]);
});

test('a new NOT NULL column with no default and no source loses the rows, in SQLite\'s words, and only then', () => {
  const { sql, writes } = world(`
    CREATE TABLE heads (id TEXT PRIMARY KEY);
    INSERT INTO heads VALUES ('h');`, `
    CREATE TABLE IF NOT EXISTS heads (id TEXT PRIMARY KEY, seq INTEGER NOT NULL);`);

  const planned = resetTables(sql, { tables: altered('heads'), drop: false }, writes);

  expect(planned.held).toEqual([{ table: 'heads', rows: 1, stale: true, keepsRows: false, refused: expect.stringContaining('NOT NULL constraint failed: heads.seq') }]);

  const done = resetTables(sql, { tables: altered('heads'), drop: true }, writes);

  expect({ dropped: done.dropped, rebuilt: done.rebuilt }).toEqual({ dropped: ['heads'], rebuilt: [] });
  expect(rows(sql, 'SELECT COUNT(*) AS n FROM heads')).toEqual([{ n: 0 }]);
  sql.exec("INSERT INTO heads VALUES ('h', 1)");
});

test('a removed table whose drop would reach rows of a table the release did not change is left, and says which', () => {
  const { sql, writes } = world(`
    CREATE TABLE gone (id TEXT PRIMARY KEY);
    CREATE TABLE stays (id TEXT PRIMARY KEY, gone TEXT REFERENCES gone(id) ON DELETE CASCADE);
    INSERT INTO gone VALUES ('g');
    INSERT INTO stays VALUES ('s', 'g');`, `
    CREATE TABLE IF NOT EXISTS stays (id TEXT PRIMARY KEY, gone TEXT REFERENCES gone(id) ON DELETE CASCADE);`);

  const done = resetTables(sql, { tables: [{ table: 'gone', change: 'removed' }], drop: true }, writes);

  expect(done.held).toEqual([{ table: 'gone', rows: 1, stale: true, keepsRows: false, cascades: ['stays'] }]);
  expect(done.dropped).toEqual([]);
  expect(rows(sql, 'SELECT COUNT(*) AS n FROM stays')).toEqual([{ n: 1 }]);
});

test('two changed tables, each indexed, are each rebuilt with their own indexes and none of the other\'s', () => {
  const { sql, writes } = world(`
    CREATE TABLE tickets (hash TEXT PRIMARY KEY, expires_at INTEGER, used_at INTEGER);
    CREATE INDEX tickets_exp ON tickets(expires_at);
    CREATE TABLE joins (id TEXT PRIMARY KEY, expires_at INTEGER, used_at INTEGER);
    CREATE INDEX joins_exp ON joins(expires_at);
    INSERT INTO tickets VALUES ('t', 1, NULL);
    INSERT INTO joins VALUES ('j', 2, 3);`, `
    CREATE TABLE IF NOT EXISTS tickets (hash TEXT PRIMARY KEY, expires_at INTEGER);
    CREATE INDEX IF NOT EXISTS tickets_exp ON tickets(expires_at);
    CREATE TABLE IF NOT EXISTS joins (id TEXT PRIMARY KEY, expires_at INTEGER);
    CREATE INDEX IF NOT EXISTS joins_exp ON joins(expires_at);`);

  const done = resetTables(sql, { tables: altered('tickets', 'joins'), drop: true }, writes);

  expect({ rebuilt: [...done.rebuilt].sort(), dropped: done.dropped }).toEqual({ rebuilt: ['joins', 'tickets'], dropped: [] });
  expect(rows(sql, 'SELECT hash, expires_at FROM tickets')).toEqual([{ hash: 't', expires_at: 1 }]);
  expect(rows(sql, "SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name")).toEqual([{ name: 'joins_exp' }, { name: 'tickets_exp' }]);
});

test('a census names every table and its rows, sorted', () => {
  const { sql, writes } = world(`CREATE TABLE b (id TEXT); CREATE TABLE a (id TEXT); INSERT INTO a VALUES ('x');`, '');

  expect(resetTables(sql, { tables: [], drop: false }, writes).census).toEqual([{ table: 'a', rows: 1 }, { table: 'b', rows: 0 }]);
});

test('only the capability /ops/tables mints is admitted', async () => {
  await requireOps(KEY, await opsCaller(KEY));
  await expect(requireOps(KEY, { opsToken: 'b'.repeat(64) })).rejects.toThrow('only through the deployment\'s /ops/tables route');
  await expect(requireOps(KEY, null)).rejects.toThrow('/ops/tables');
  await expect(requireOps({}, await opsCaller(KEY))).rejects.toThrow('CREDENTIAL_ENCRYPTION_KEY');
});
