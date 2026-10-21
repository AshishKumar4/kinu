// A database a release left behind, reset by its own object at first contact (the owner's rule, 2026-10-20): each
// table whose CREATE statement is not the one its init declares now, read in a rolled-back trial, is dropped with every
// table that refers to it, and made anew empty by the init; every other table is left byte for byte. A retired table is
// dropped unless kept rows refer to it. A database at this build is not touched.
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

/** Every row of `table`, in rowid order: what a reset must leave alone. */
const rowsIn = (sql: SqlExec, table: string) => rows(sql, `SELECT rowid AS r, * FROM "${table}" ORDER BY rowid`);

test('a changed table is dropped with what refers to it and made anew empty; every other table is left as it was', () => {
  const { sql, writes } = world(`
    CREATE TABLE parents (id TEXT PRIMARY KEY, old TEXT);
    CREATE TABLE children (id TEXT PRIMARY KEY, parent TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE);
    CREATE TABLE later (id TEXT PRIMARY KEY, parent TEXT REFERENCES parents(id));
    CREATE INDEX later_parent ON later(parent);
    CREATE TABLE kept (id TEXT PRIMARY KEY, body TEXT, blob BLOB);
    CREATE TABLE seen (id TEXT);
    CREATE TRIGGER parents_seen AFTER INSERT ON parents BEGIN INSERT INTO seen VALUES (new.id); END;
    CREATE VIEW parent_ids AS SELECT id FROM parents;
    INSERT INTO parents VALUES ('p', 'x');
    INSERT INTO children VALUES ('c', 'p');
    INSERT INTO later VALUES ('l', 'p');
    INSERT INTO kept (rowid, id, body, blob) VALUES (7, 'k', 'kept', x'00ff'), (9, 'j', NULL, NULL);`, `
    CREATE TABLE IF NOT EXISTS parents (id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS children (id TEXT PRIMARY KEY, parent TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS kept (id TEXT PRIMARY KEY, body TEXT, blob BLOB);
    CREATE TABLE IF NOT EXISTS seen (id TEXT);
    CREATE TRIGGER IF NOT EXISTS parents_seen AFTER INSERT ON parents BEGIN INSERT INTO seen VALUES (new.id); END;
    CREATE VIEW IF NOT EXISTS parent_ids AS SELECT id FROM parents;`, ['parents', 'children', 'kept', 'seen']);

  const keptBefore = rowsIn(sql, 'kept');
  const census = censusOf(sql).filter((row) => row.table === 'kept');
  const repair = repairSchema(sql, writes, 'family');

  expect({ dropped: repair?.dropped, refused: repair?.refused }).toEqual({ dropped: ['parents', 'children', 'later'], refused: null });
  expect(repair?.tables).toEqual([{ table: 'parents', before: 1, after: 0 }, { table: 'children', before: 1, after: 0 }, { table: 'later', before: 1, after: 0 }]);
  // A NOT NULL column with no default is no refusal: there are no rows to keep.
  expect(rows(sql, 'SELECT COUNT(*) AS n FROM parents UNION ALL SELECT COUNT(*) FROM children UNION ALL SELECT COUNT(*) FROM later')).toEqual([{ n: 0 }, { n: 0 }, { n: 0 }]);
  expect(rowsIn(sql, 'kept')).toEqual(keptBefore);
  expect(censusOf(sql).filter((row) => row.table === 'kept')).toEqual(census);
  // The referrer the init does not make is made again as it was, empty, index and all; the trigger and view are the init's.
  expect(rows(sql, "SELECT name FROM sqlite_master WHERE name IN ('later_parent', 'parents_seen', 'parent_ids') ORDER BY name")).toEqual([{ name: 'later_parent' }, { name: 'parent_ids' }, { name: 'parents_seen' }]);
  sql.exec("INSERT INTO parents VALUES ('q', 1); INSERT INTO later VALUES ('m', 'q')");
  // `seen` is unchanged, so it keeps what the trigger wrote before the reset.
  expect(rows(sql, 'SELECT id FROM seen UNION ALL SELECT id FROM parent_ids')).toEqual([{ id: 'p' }, { id: 'q' }, { id: 'q' }]);
  expect(rows(sql, 'PRAGMA foreign_key_check')).toEqual([]);
  expect(readStamp(writes.stamps, sql, 'agent')).toBe('current');
  expect(repairSchema(sql, writes, 'family')).toBeNull();
});

test('a table derived from a dropped one, by the mark beside its DDL, is dropped with it; unmarked, it would be left stale', () => {
  const before = `
    CREATE TABLE events (actor TEXT, kind TEXT, old TEXT);
    CREATE TABLE folds (actor TEXT PRIMARY KEY, through INTEGER NOT NULL);
    INSERT INTO events VALUES ('a', 'x', 'y'), ('a', 'x', 'z');
    INSERT INTO folds VALUES ('a', 2);`;

  const init = (mark: string) => `
    CREATE TABLE IF NOT EXISTS events (actor TEXT, kind TEXT);
    CREATE TABLE IF NOT EXISTS folds (${mark} actor TEXT PRIMARY KEY, through INTEGER NOT NULL);`;

  const marked = world(before, init('/* derived from events: through is a rowid of its */'), ['events', 'folds']);

  expect(repairSchema(marked.sql, marked.writes, 'folds')?.dropped).toEqual(['events', 'folds']);
  expect(rows(marked.sql, 'SELECT COUNT(*) AS n FROM folds')).toEqual([{ n: 0 }]);

  const unmarked = world(before, init(''), ['events', 'folds']);

  expect(repairSchema(unmarked.sql, unmarked.writes, 'folds')?.dropped).toEqual(['events']);
  // A watermark over rowids that are gone: what the mark exists to prevent.
  expect(rows(unmarked.sql, 'SELECT through FROM folds')).toEqual([{ through: 2 }]);
});

test('a table made on first use is read by `later`: reshaped, it is dropped and left to that use, which makes it anew', () => {
  const before = `
    CREATE TABLE notes (id TEXT PRIMARY KEY);
    CREATE TABLE usage (slate TEXT, member TEXT);
    INSERT INTO usage VALUES ('s', 'm');`;

  const usage = 'CREATE TABLE IF NOT EXISTS usage (slate TEXT NOT NULL, namespace TEXT NOT NULL, member TEXT NOT NULL)';

  const read = world(before, 'CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY);', ['notes', 'usage']);
  const repair = repairSchema(read.sql, { ...read.writes, later: () => { read.sql.exec(usage); } }, 'lazy');

  expect({ dropped: repair?.dropped, unchecked: repair?.unchecked, tables: repair?.tables }).toEqual({ dropped: ['usage'], unchecked: [], tables: [{ table: 'usage', before: 1, after: 0 }] });
  expect(rows(read.sql, "SELECT name FROM sqlite_master WHERE name = 'usage'")).toEqual([]);
  read.sql.exec(usage);
  expect(rows(read.sql, "SELECT COUNT(*) AS n FROM pragma_table_info('usage') WHERE name = 'namespace'")).toEqual([{ n: 1 }]);

  // Without `later`, nothing reads its shape: it stays as the build before made it, which this build's writes refuse.
  const unread = world(before, 'CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY);', ['notes', 'usage']);

  expect(repairSchema(unread.sql, unread.writes, 'lazy')?.unchecked).toEqual(['usage']);
  expect(rows(unread.sql, 'SELECT slate, member FROM usage')).toEqual([{ slate: 's', member: 'm' }]);
});

test('a table whose statement is the init\'s, spelled with other spacing and comments, is not dropped', () => {
  const { sql, writes } = world(`
    CREATE TABLE kept (id TEXT PRIMARY KEY,   body TEXT);
    CREATE TABLE changed (id TEXT PRIMARY KEY, extra TEXT);
    INSERT INTO kept VALUES ('k', 'x');`, `
    CREATE TABLE IF NOT EXISTS kept ( -- the same table
      id TEXT PRIMARY KEY, /* its body */ body TEXT);
    CREATE TABLE IF NOT EXISTS changed (id TEXT PRIMARY KEY);`, ['kept', 'changed']);

  expect(repairSchema(sql, writes, 'two')?.dropped).toEqual(['changed']);
  expect(rows(sql, 'SELECT id, body FROM kept')).toEqual([{ id: 'k', body: 'x' }]);
});

test('a default changed inside its quotes is a changed table, comment marks and all', () => {
  const { sql, writes } = world(`
    CREATE TABLE marks (id TEXT PRIMARY KEY, mark TEXT NOT NULL DEFAULT 'a--old');
    INSERT INTO marks (id) VALUES ('m');`, `
    CREATE TABLE IF NOT EXISTS marks (id TEXT PRIMARY KEY, mark TEXT NOT NULL DEFAULT 'a--new');`, ['marks']);

  expect(repairSchema(sql, writes, 'marks')?.dropped).toEqual(['marks']);
  sql.exec("INSERT INTO marks (id) VALUES ('n')");
  expect(rows(sql, 'SELECT id, mark FROM marks')).toEqual([{ id: 'n', mark: 'a--new' }]);
});

test('what the init seeds into a table it makes anew is the table\'s only rows', () => {
  const { sql, writes } = world(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO settings VALUES ('old', 'x');`, `
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO settings VALUES ('mode', 'build');`, ['settings']);

  expect(repairSchema(sql, writes, 'settings')?.tables).toEqual([{ table: 'settings', before: 1, after: 1 }]);
  expect(rows(sql, 'SELECT key, value FROM settings')).toEqual([{ key: 'mode', value: 'build' }]);
});

test('a view its init declares anew is made again over tables that did not change, and what reads it with it', () => {
  const { sql, writes } = world(`
    CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT);
    CREATE VIEW note_bodies AS SELECT id FROM notes;
    CREATE VIEW note_count AS SELECT COUNT(*) AS n FROM note_bodies;
    INSERT INTO notes VALUES ('a', 'kept');`, `
    CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT);
    CREATE VIEW IF NOT EXISTS note_bodies AS SELECT id, body FROM notes;`, ['notes', 'note_bodies']);

  expect(repairSchema(sql, writes, 'views')?.dropped).toEqual(['note_bodies']);
  expect(rows(sql, 'SELECT id, body FROM note_bodies UNION ALL SELECT n, NULL FROM note_count')).toEqual([{ id: 'a', body: 'kept' }, { id: 1, body: null }]);
});

test('an init that refuses leaves every table and the stamp as they were, refused in SQLite\'s words', () => {
  const { sql, writes } = world(`
    CREATE TABLE heads (id TEXT PRIMARY KEY, old TEXT);
    INSERT INTO heads VALUES ('h', 'x');`, `
    CREATE TABLE IF NOT EXISTS heads (id TEXT PRIMARY KEY);
    INSERT INTO heads VALUES (NULL, 'too many values');`, ['heads']);

  const repair = repairSchema(sql, writes, 'heads');

  expect(repair?.refused).toContain('heads');
  expect(rows(sql, 'SELECT id, old FROM heads')).toEqual([{ id: 'h', old: 'x' }]);
  expect(readStamp(writes.stamps, sql, 'agent')).toBe('behind');
});

test('a retired table is dropped, unless rows a kept table holds refer to it', () => {
  const dropped = world(`
    CREATE TABLE device_consent_requests (consent_id TEXT PRIMARY KEY);
    INSERT INTO device_consent_requests VALUES ('c');`, 'CREATE TABLE IF NOT EXISTS notes (id TEXT)', []);

  expect(repairSchema(dropped.sql, dropped.writes, 'retired')?.retired).toEqual(['device_consent_requests']);
  expect(censusOf(dropped.sql).map(({ table, rows: count }) => [table, count])).toEqual([['notes', 0]]);

  const held = world(`
    CREATE TABLE device_consent_requests (consent_id TEXT PRIMARY KEY);
    CREATE TABLE stays (id TEXT PRIMARY KEY, consent TEXT REFERENCES device_consent_requests(consent_id) ON DELETE CASCADE);
    INSERT INTO device_consent_requests VALUES ('c');
    INSERT INTO stays VALUES ('s', 'c');`, 'CREATE TABLE IF NOT EXISTS notes (id TEXT)', []);

  expect(repairSchema(held.sql, held.writes, 'retired')?.retired).toEqual([]);
  expect(rows(held.sql, 'SELECT COUNT(*) AS n FROM stays')).toEqual([{ n: 1 }]);
});

// Review of the consolidation (2026-10-21): a retired table that refers to a stale one went with its group, was made again
// from its old statement, and was then retired: reported dropped and retired, with two rows in `tables`.
test('a retired table that refers to a changed one goes with it once, as retired, and is not made again', () => {
  const { sql, writes } = world(`
    CREATE TABLE actor_requests (id TEXT PRIMARY KEY, old TEXT);
    CREATE TABLE request_renders (request TEXT NOT NULL REFERENCES actor_requests(id), body TEXT);
    CREATE INDEX request_renders_request ON request_renders(request);
    INSERT INTO actor_requests VALUES ('r', 'x');
    INSERT INTO request_renders VALUES ('r', 'shown');`, 'CREATE TABLE IF NOT EXISTS actor_requests (id TEXT PRIMARY KEY, render TEXT);', ['actor_requests']);

  const repair = repairSchema(sql, writes, 'requests');

  expect({ dropped: repair?.dropped, retired: repair?.retired, tables: repair?.tables, refused: repair?.refused }).toEqual({
    dropped: ['actor_requests'], retired: ['request_renders'], refused: null,
    tables: [{ table: 'actor_requests', before: 1, after: 0 }, { table: 'request_renders', before: 1, after: null }],
  });
  expect(rows(sql, "SELECT name FROM sqlite_master WHERE name LIKE 'request_renders%'")).toEqual([]);
});

// Review of the consolidation (2026-10-21): a contentless FTS index keyed by a dropped table's rowids outlived it, and a
// message delivered after the reset took rowid 1, and with it the old message's tokens.
test('a virtual table derived from a dropped one, by the mark in its own statement, is dropped and made anew with it', () => {
  const before = `
    CREATE TABLE messages (id TEXT PRIMARY KEY, subject TEXT, old TEXT);
    CREATE VIRTUAL TABLE messages_fts USING fts5 (subject, content = '', contentless_delete = 1);
    INSERT INTO messages (rowid, id, subject) VALUES (1, 'm1', 'oldsecretword');
    INSERT INTO messages_fts (rowid, subject) VALUES (1, 'oldsecretword');`;

  const init = (mark: string) => `
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, subject TEXT);
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 ( ${mark}
      subject, content = '', contentless_delete = 1
    );`;

  const deliver = (sql: SqlExec) => {
    sql.exec("INSERT INTO messages (id, subject) VALUES ('m2', 'new subject')");
    sql.exec("INSERT INTO messages_fts (rowid, subject) SELECT rowid, subject FROM messages WHERE id = 'm2'");

    return rows(sql, "SELECT m.id FROM messages m WHERE m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'oldsecretword')");
  };

  const marked = world(before, init('/* derived from messages: its rowids are theirs */'), ['messages']);
  const repair = repairSchema(marked.sql, marked.writes, 'mail');

  expect({ dropped: repair?.dropped, tables: repair?.tables }).toEqual({
    dropped: ['messages', 'messages_fts'], tables: [{ table: 'messages', before: 1, after: 0 }, { table: 'messages_fts', before: 1, after: 0 }],
  });
  expect(deliver(marked.sql)).toEqual([]);

  // Unmarked, the index is left over rowids that are gone: what the mark exists to prevent.
  const unmarked = world(before, init(''), ['messages']);

  expect(repairSchema(unmarked.sql, unmarked.writes, 'mail')?.dropped).toEqual(['messages']);
  expect(deliver(unmarked.sql)).toEqual([{ id: 'm2' }]);
});

test('a virtual table its first use makes, derived from a dropped table, is dropped and left to that use', () => {
  const index = 'CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5( /* derived from entries: their text, indexed */ content)';

  const read = world(`
    CREATE TABLE entries (id TEXT PRIMARY KEY, old TEXT);
    CREATE VIRTUAL TABLE entries_fts USING fts5(content);
    INSERT INTO entries VALUES ('e', 'x');
    INSERT INTO entries_fts (rowid, content) VALUES (1, 'hello');`, 'CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY);', ['entries']);

  const repair = repairSchema(read.sql, { ...read.writes, later: () => { read.sql.exec(index); } }, 'search');

  expect({ dropped: repair?.dropped, tables: repair?.tables }).toEqual({
    dropped: ['entries', 'entries_fts'], tables: [{ table: 'entries', before: 1, after: 0 }, { table: 'entries_fts', before: 1, after: 0 }],
  });
  expect(rows(read.sql, "SELECT name FROM sqlite_master WHERE name LIKE 'entries_fts%'")).toEqual([]);
});

test('a database at this build, or one nothing made, is not repaired', () => {
  const { sql, writes } = world('CREATE TABLE notes (id TEXT, old TEXT);', 'CREATE TABLE IF NOT EXISTS notes (id TEXT);', ['notes']);

  writes.stamps.write(SCHEMA_STAMPS.agent);
  expect(repairSchema(sql, writes, 'current')).toBeNull();
  expect(rows(sql, 'SELECT COUNT(*) AS n FROM pragma_table_info(\'notes\')')).toEqual([{ n: 2 }]);
});

test('a census names every table, its rows and a digest of what they hold, sorted', () => {
  const { sql } = world(`CREATE TABLE b (id TEXT); CREATE TABLE a (id TEXT, data BLOB); CREATE TABLE w (k TEXT PRIMARY KEY) WITHOUT ROWID;
    INSERT INTO a VALUES ('x', x'01'); INSERT INTO w VALUES ('y');`, '', []);

  const first = censusOf(sql);

  expect(first.map(({ table, rows: count }) => [table, count])).toEqual([['a', 1], ['b', 0], ['w', 1]]);
  expect(censusOf(sql)).toEqual(first);
  // A changed byte changes the table's digest, and only its.
  sql.exec("UPDATE a SET data = x'02'");
  const second = censusOf(sql);

  expect(second.map(({ digest }, at) => digest === first[at]?.digest)).toEqual([false, true, true]);
});

test('only the capability /ops/tables mints is admitted', async () => {
  await requireOps(KEY, await opsCaller(KEY));
  await expect(requireOps(KEY, { opsToken: 'b'.repeat(64) })).rejects.toThrow('only through the deployment\'s /ops/tables route');
  await expect(requireOps(KEY, null)).rejects.toThrow('/ops/tables');
  await expect(requireOps({}, await opsCaller(KEY))).rejects.toThrow('CREDENTIAL_ENCRYPTION_KEY');
});
