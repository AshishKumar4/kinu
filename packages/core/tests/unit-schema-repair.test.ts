// A database a release left behind, repaired by its own object at first contact: each table its class makes is
// brought to the shape its init declares now, read in a rolled-back trial; a stale one is rebuilt keeping every row and
// rowid, with its referrers alongside and its triggers made after the copy. Rows that cannot be copied are lost only on
// a table its DDL declares a regenerable cache; any other refuses in SQLite's words, and the database stays unstamped.
// A retired table is dropped unless kept rows refer to it. A database at this build is not touched.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { censusOf, opsCaller, pragmaStamps, readStamp, repairSchema, requireOps, SCHEMA_STAMPS, type TableWrites } from '../src/index';
import { sqlStorageOver } from '../src/identity/inline-primitives';
import type { SqlExec } from '../src/types/primitives';

const KEY = { CREDENTIAL_ENCRYPTION_KEY: 'a'.repeat(64) };

/** A database as the build before left it (stamped, but not as this build's), and the candidate's init. */
function world(before: string, candidate: string, tables: readonly string[]) {
  const db = new Database(':memory:');
  const sql = sqlStorageOver(db);

  db.exec('PRAGMA foreign_keys = ON');
  db.exec(before);
  db.exec('PRAGMA user_version = 1');

  const writes: TableWrites = {
    schema: 'agent', tables, stamps: pragmaStamps(sql), transactionSync: (write) => db.transaction(write)(), init: () => { db.exec(candidate); },
  };

  return { db, sql, writes };
}

const RowSchema = v.record(v.string(), v.unknown());

const rows = (sql: SqlExec, query: string) => sql.exec(query).toArray().map((row) => v.parse(RowSchema, row));

test('a removed column SQLite refuses to drop is rebuilt away, every row and rowid kept, and the database stamped', () => {
  const { sql, writes } = world(`
    CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT, CHECK (digest IS NULL OR length(digest) = 4));
    CREATE INDEX notes_digest ON notes(digest);
    INSERT INTO notes (rowid, id, body, digest) VALUES (7, 'a', 'kept', 'abcd'), (9, 'b', 'also kept', NULL);`, `
    CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS notes_body ON notes(body);`, ['notes']);

  const repair = repairSchema(sql, writes, 'notes');

  expect({ rebuilt: repair?.rebuilt, tables: repair?.tables, refused: repair?.refused }).toEqual({ rebuilt: ['notes'], tables: [{ table: 'notes', before: 2, after: 2 }], refused: null });
  expect(rows(sql, 'SELECT rowid AS r, id, body FROM notes ORDER BY id')).toEqual([{ r: 7, id: 'a', body: 'kept' }, { r: 9, id: 'b', body: 'also kept' }]);
  expect(rows(sql, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notes' AND sql IS NOT NULL")).toEqual([{ name: 'notes_body' }]);
  expect(readStamp(writes.stamps, sql, 'agent')).toBe('current');
  expect(repairSchema(sql, writes, 'notes')).toBeNull();
});

test('a table whose statement is the init\'s, spelled with other spacing and comments, is not rebuilt', () => {
  const { sql, writes } = world(`
    CREATE TABLE kept (id TEXT PRIMARY KEY,   body TEXT);
    CREATE TABLE changed (id TEXT PRIMARY KEY, extra TEXT);
    INSERT INTO kept VALUES ('k', 'x');`, `
    CREATE TABLE IF NOT EXISTS kept ( -- the same table
      id TEXT PRIMARY KEY, /* its body */ body TEXT);
    CREATE TABLE IF NOT EXISTS changed (id TEXT PRIMARY KEY);`, ['kept', 'changed']);

  expect(repairSchema(sql, writes, 'two')?.rebuilt).toEqual(['changed']);
});

test('a relaxed constraint and a re-key from columns the table holds are rebuilt, and the view over it made again', () => {
  const { sql, writes } = world(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, seq INTEGER NOT NULL, task TEXT NOT NULL);
    CREATE VIEW open_tasks AS SELECT id, task FROM tasks;
    INSERT INTO tasks VALUES ('main:1', 'main', 1, 'write'), ('main:2', 'main', 2, 'read');`, `
    CREATE TABLE IF NOT EXISTS tasks (actor_id TEXT NOT NULL, seq INTEGER NOT NULL, task TEXT,
      id TEXT GENERATED ALWAYS AS (actor_id || ':' || seq) VIRTUAL, PRIMARY KEY (actor_id, seq)) WITHOUT ROWID;
    CREATE VIEW IF NOT EXISTS open_tasks AS SELECT id, task, seq FROM tasks;`, ['tasks']);

  expect(repairSchema(sql, writes, 'tasks')?.rebuilt).toEqual(['tasks']);
  expect(rows(sql, 'SELECT id, task, seq FROM open_tasks ORDER BY seq')).toEqual([{ id: 'main:1', task: 'write', seq: 1 }, { id: 'main:2', task: 'read', seq: 2 }]);
  sql.exec("INSERT INTO tasks (actor_id, seq, task) VALUES ('main', 3, NULL)");
});

test('a table whose rows refer to a rebuilt one is rebuilt alongside, the init\'s or not, so no cascade takes its rows', () => {
  const { sql, writes } = world(`
    CREATE TABLE parents (id TEXT PRIMARY KEY, old TEXT);
    CREATE TABLE children (id TEXT PRIMARY KEY, parent TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE);
    CREATE TABLE later (id TEXT PRIMARY KEY, parent TEXT REFERENCES parents(id) ON DELETE CASCADE);
    CREATE INDEX later_parent ON later(parent);
    INSERT INTO parents VALUES ('p', 'x');
    INSERT INTO children VALUES ('c', 'p');
    INSERT INTO later VALUES ('l', 'p');`, `
    CREATE TABLE IF NOT EXISTS parents (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS children (id TEXT PRIMARY KEY, parent TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE);`, ['parents', 'children']);

  expect(repairSchema(sql, writes, 'family')?.rebuilt).toEqual(['parents', 'children', 'later']);
  expect(rows(sql, 'SELECT id, parent FROM children UNION ALL SELECT id, parent FROM later')).toEqual([{ id: 'c', parent: 'p' }, { id: 'l', parent: 'p' }]);
  expect(rows(sql, "SELECT name FROM sqlite_master WHERE name = 'later_parent'")).toHaveLength(1);
  expect(rows(sql, 'PRAGMA foreign_key_check')).toEqual([]);
});

test('a trigger the init makes does not run on the rows the rebuild copies back, and runs after', () => {
  const { sql, writes } = world(`
    CREATE TABLE entries (id INTEGER PRIMARY KEY, text TEXT, digest TEXT);
    CREATE TABLE entry_log (id INTEGER);
    CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN INSERT INTO entry_log VALUES (new.id); END;
    INSERT INTO entries VALUES (1, 'one', 'x'), (2, 'two', 'y');`, `
    CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, text TEXT);
    CREATE TABLE IF NOT EXISTS entry_log (id INTEGER);
    CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN INSERT INTO entry_log VALUES (new.id); END;`, ['entries', 'entry_log']);

  repairSchema(sql, writes, 'entries');

  expect(rows(sql, 'SELECT COUNT(*) AS n FROM entry_log')).toEqual([{ n: 2 }]);
  sql.exec("INSERT INTO entries (id, text) VALUES (3, 'three')");
  expect(rows(sql, 'SELECT COUNT(*) AS n FROM entry_log')).toEqual([{ n: 3 }]);
});

test('a trigger of a table outside the rebuild that names a rebuilt one is made again, and a view over a view', () => {
  const { sql, writes } = world(`
    CREATE TABLE notes (id TEXT PRIMARY KEY, old TEXT);
    CREATE TABLE audit (note TEXT);
    CREATE TABLE edits (id TEXT);
    CREATE TRIGGER edits_note AFTER INSERT ON edits BEGIN INSERT INTO audit SELECT id FROM notes WHERE id = new.id; END;
    CREATE VIEW note_ids AS SELECT id FROM notes;
    CREATE VIEW note_count AS SELECT COUNT(*) AS n FROM note_ids;
    INSERT INTO notes VALUES ('a', 'x');`, `
    CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS audit (note TEXT);
    CREATE TABLE IF NOT EXISTS edits (id TEXT);`, ['notes', 'audit', 'edits']);

  expect(repairSchema(sql, writes, 'dependents')?.rebuilt).toEqual(['notes']);
  sql.exec("INSERT INTO edits VALUES ('a')");
  expect(rows(sql, 'SELECT note FROM audit UNION ALL SELECT n FROM note_count')).toEqual([{ note: 'a' }, { note: 1 }]);
});

test('a default changed inside its quotes is a stale table, comment marks and all', () => {
  const { sql, writes } = world(`
    CREATE TABLE marks (id TEXT PRIMARY KEY, mark TEXT NOT NULL DEFAULT 'a--old');
    INSERT INTO marks (id) VALUES ('m');`, `
    CREATE TABLE IF NOT EXISTS marks (id TEXT PRIMARY KEY, mark TEXT NOT NULL DEFAULT 'a--new');`, ['marks']);

  expect(repairSchema(sql, writes, 'marks')?.rebuilt).toEqual(['marks']);
  sql.exec("INSERT INTO marks (id) VALUES ('n')");
  expect(rows(sql, "SELECT mark FROM marks WHERE id = 'n'")).toEqual([{ mark: 'a--new' }]);
});

test('a view its init declares anew is made again over tables that did not change, and what reads it with it', () => {
  const { sql, writes } = world(`
    CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT);
    CREATE VIEW note_bodies AS SELECT id FROM notes;
    CREATE VIEW note_count AS SELECT COUNT(*) AS n FROM note_bodies;
    INSERT INTO notes VALUES ('a', 'kept');`, `
    CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT);
    CREATE VIEW IF NOT EXISTS note_bodies AS SELECT id, body FROM notes;`, ['notes', 'note_bodies']);

  expect(repairSchema(sql, writes, 'views')?.rebuilt).toEqual(['note_bodies']);
  expect(rows(sql, 'SELECT id, body FROM note_bodies UNION ALL SELECT n, NULL FROM note_count')).toEqual([{ id: 'a', body: 'kept' }, { id: 1, body: null }]);
});

test('rows that cannot be copied refuse in SQLite\'s words, leaving every table and the stamp as they were', () => {
  const { sql, writes } = world(`
    CREATE TABLE heads (id TEXT PRIMARY KEY);
    INSERT INTO heads VALUES ('h');`, `
    CREATE TABLE IF NOT EXISTS heads (id TEXT PRIMARY KEY, seq INTEGER NOT NULL);`, ['heads']);

  const repair = repairSchema(sql, writes, 'heads');

  expect(repair?.refused).toContain('NOT NULL constraint failed: heads.seq');
  expect(rows(sql, 'SELECT id FROM heads')).toEqual([{ id: 'h' }]);
  expect(readStamp(writes.stamps, sql, 'agent')).toBe('behind');
});

test('rows that cannot be copied are dropped only from a regenerable cache, which the init makes anew', () => {
  const { sql, writes } = world(`
    CREATE TABLE overviews (name TEXT PRIMARY KEY);
    CREATE TABLE pins (name TEXT REFERENCES overviews(name));
    CREATE INDEX pins_name ON pins(name);
    INSERT INTO overviews VALUES ('w');`, `
    CREATE TABLE IF NOT EXISTS overviews ( /* regenerable cache, refilled by each workspace's push */
      name TEXT PRIMARY KEY, overview TEXT NOT NULL);`, ['overviews']);

  const repair = repairSchema(sql, writes, 'overviews');

  expect({ refilled: repair?.refilled, refused: repair?.refused }).toEqual({ refilled: ['overviews', 'pins'], refused: null });
  expect(repair?.tables).toEqual([{ table: 'overviews', before: 1, after: 0 }, { table: 'pins', before: 0, after: 0 }]);
  // The empty table that refers to the cache, which the init does not make, is made again as it was, index and all.
  sql.exec("INSERT INTO overviews VALUES ('w', '{}'); INSERT INTO pins VALUES ('w')");
  expect(rows(sql, "SELECT name FROM sqlite_master WHERE name = 'pins_name'")).toHaveLength(1);
  expect(readStamp(writes.stamps, sql, 'agent')).toBe('current');
});

test('a retired table is dropped, unless rows a kept table holds refer to it', () => {
  const dropped = world(`
    CREATE TABLE device_consent_requests (consent_id TEXT PRIMARY KEY);
    INSERT INTO device_consent_requests VALUES ('c');`, 'CREATE TABLE IF NOT EXISTS notes (id TEXT)', []);

  expect(repairSchema(dropped.sql, dropped.writes, 'retired')?.retired).toEqual(['device_consent_requests']);
  expect(censusOf(dropped.sql)).toEqual([{ table: 'notes', rows: 0 }]);

  const held = world(`
    CREATE TABLE device_consent_requests (consent_id TEXT PRIMARY KEY);
    CREATE TABLE stays (id TEXT PRIMARY KEY, consent TEXT REFERENCES device_consent_requests(consent_id) ON DELETE CASCADE);
    INSERT INTO device_consent_requests VALUES ('c');
    INSERT INTO stays VALUES ('s', 'c');`, 'CREATE TABLE IF NOT EXISTS notes (id TEXT)', []);

  expect(repairSchema(held.sql, held.writes, 'retired')?.retired).toEqual([]);
  expect(rows(held.sql, 'SELECT COUNT(*) AS n FROM stays')).toEqual([{ n: 1 }]);
});

test('a database at this build, or one nothing made, is not repaired', () => {
  const { sql, writes } = world('CREATE TABLE notes (id TEXT, old TEXT);', 'CREATE TABLE IF NOT EXISTS notes (id TEXT);', ['notes']);

  writes.stamps.write(SCHEMA_STAMPS.agent);
  expect(repairSchema(sql, writes, 'current')).toBeNull();
  expect(rows(sql, 'SELECT COUNT(*) AS n FROM pragma_table_info(\'notes\')')).toEqual([{ n: 2 }]);
});

test('a census names every table and its rows, sorted', () => {
  const { sql } = world(`CREATE TABLE b (id TEXT); CREATE TABLE a (id TEXT); INSERT INTO a VALUES ('x');`, '', []);

  expect(censusOf(sql)).toEqual([{ table: 'a', rows: 1 }, { table: 'b', rows: 0 }]);
});

test('only the capability /ops/tables mints is admitted', async () => {
  await requireOps(KEY, await opsCaller(KEY));
  await expect(requireOps(KEY, { opsToken: 'b'.repeat(64) })).rejects.toThrow('only through the deployment\'s /ops/tables route');
  await expect(requireOps(KEY, null)).rejects.toThrow('/ops/tables');
  await expect(requireOps({}, await opsCaller(KEY))).rejects.toThrow('CREDENTIAL_ENCRYPTION_KEY');
});
