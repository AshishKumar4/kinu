// A release's tables reset as one object carries it out: only the changed tables, and only while they hold the old
// shape, are dropped, and the object's init makes them anew; every other table keeps its rows, and a rerun drops
// nothing a finished run made. Reached only with the capability `/ops/tables` mints.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { initUserTables, opsCaller, requireOps, resetTables, type ChangedTable, type TableWrites } from '../src/index';
import { sqlStorageOver } from '../src/identity/inline-primitives';
import type { SqlExec } from '../src/types/primitives';

const KEY = { CREDENTIAL_ENCRYPTION_KEY: 'a'.repeat(64) };

const CHANGED: readonly ChangedTable[] = [
  { table: 'device_joins', change: 'remade', columns: ['device_id', 'ticket_hash', 'workspace', 'expires_at'], dropped: [] },
  { table: 'device_consent_requests', change: 'removed', columns: [], dropped: [] },
  { table: 'device_connect_tickets', change: 'columns', columns: ['ticket_hash', 'device_id', 'token_was_current', 'expires_at'], dropped: ['used_at'] },
  // A column SQLite will not drop: it is in the table's key.
  { table: 'pinned', change: 'columns', columns: ['id'], dropped: ['part'] },
];

/** An account as the build before this release left it: an old device_joins, a removed table, a column the release
 *  dropped, one SQLite cannot drop, and a profile. */
function previousAccount() {
  const db = new Database(':memory:');
  const sql = sqlStorageOver(db);

  sql.exec('CREATE TABLE device_joins (device_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
  sql.exec("INSERT INTO device_joins VALUES ('dev-old', 1)");
  sql.exec('CREATE TABLE device_consent_requests (consent_id TEXT PRIMARY KEY)');
  sql.exec("INSERT INTO device_consent_requests VALUES ('c-1'), ('c-2')");
  sql.exec('CREATE TABLE device_connect_tickets (ticket_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, token_was_current INTEGER, expires_at INTEGER NOT NULL, used_at INTEGER)');
  sql.exec("INSERT INTO device_connect_tickets VALUES ('h-1', 'dev-1', 1, 9, NULL), ('h-2', 'dev-1', 1, 9, 5)");
  sql.exec('CREATE TABLE pinned (id TEXT NOT NULL, part TEXT NOT NULL, PRIMARY KEY (id, part))');
  sql.exec("INSERT INTO pinned VALUES ('a', 'b')");
  initUserTables(sql);
  sql.exec("INSERT INTO user_profile (id, email) VALUES (1, 'owner@example.com')");

  return { db, sql };
}

const writes = (db: Database, sql: SqlExec): TableWrites => ({ schema: 'account', transactionSync: (write) => db.transaction(write)(), init: () => { initUserTables(sql); } });

const columnsOf = (sql: SqlExec, table: string) => sql.exec(`PRAGMA table_info(${table})`).toArray().map((row) => v.parse(ColumnSchema, row).name);

const ColumnSchema = v.object({ name: v.string() });

test('a census names every table and its rows, which changed tables are as the build before left them, and which keep their rows', () => {
  const { db, sql } = previousAccount();
  const answer = resetTables(sql, { tables: [...CHANGED], drop: false }, writes(db, sql));

  expect(answer.held).toEqual([
    { table: 'device_joins', rows: 1, stale: true, keepsRows: false },
    { table: 'device_consent_requests', rows: 2, stale: true, keepsRows: false },
    { table: 'device_connect_tickets', rows: 2, stale: true, keepsRows: true },
    { table: 'pinned', rows: 1, stale: true, keepsRows: false, refused: expect.stringContaining('pinned.part') },
  ]);
  expect(answer.dropped).toEqual([]);
  // The trial drop was rolled back: the column is still there.
  expect(columnsOf(sql, 'device_connect_tickets')).toContain('used_at');
  expect(answer.census).toContainEqual({ table: 'user_profile', rows: 1 });
  expect(answer.census.map((row) => row.table)).toEqual(answer.census.map((row) => row.table).slice().sort());
});

test('a drop drops a column keeping its rows, drops and remakes the rest, and a rerun changes nothing', () => {
  const { db, sql } = previousAccount();
  const dropped = resetTables(sql, { tables: [...CHANGED], drop: true }, writes(db, sql));

  expect(dropped.dropped).toEqual(['device_joins', 'device_consent_requests', 'device_connect_tickets.used_at', 'pinned']);
  expect(columnsOf(sql, 'device_joins')).toContain('ticket_hash');
  expect(sql.exec("SELECT name FROM sqlite_master WHERE name IN ('device_consent_requests', 'pinned')").toArray()).toEqual([]);
  expect(columnsOf(sql, 'device_connect_tickets')).not.toContain('used_at');
  expect(sql.exec('SELECT COUNT(*) AS n FROM device_connect_tickets').toArray()).toEqual([{ n: 2 }]);

  const again = resetTables(sql, { tables: [...CHANGED], drop: true }, writes(db, sql));

  expect(again.held).toEqual([
    { table: 'device_joins', rows: 0, stale: false, keepsRows: true },
    { table: 'device_connect_tickets', rows: 2, stale: false, keepsRows: true },
  ]);
  expect(again.dropped).toEqual([]);
  // What no release changed keeps its rows.
  expect(again.census).toContainEqual({ table: 'user_profile', rows: 1 });
});

test('only the capability /ops/tables mints is admitted', async () => {
  await requireOps(KEY, await opsCaller(KEY));
  await expect(requireOps(KEY, { opsToken: 'b'.repeat(64) })).rejects.toThrow('only through the deployment\'s /ops/tables route');
  await expect(requireOps(KEY, null)).rejects.toThrow('/ops/tables');
  await expect(requireOps({}, await opsCaller(KEY))).rejects.toThrow('CREDENTIAL_ENCRYPTION_KEY');
});

test('a table whose drop would reach rows of a table the release did not change is not dropped, and says which', () => {
  const db = new Database(':memory:');
  const sql = sqlStorageOver(db);

  sql.exec('CREATE TABLE parents (id TEXT PRIMARY KEY, old INTEGER)');
  sql.exec('CREATE TABLE children (id TEXT PRIMARY KEY, parent TEXT REFERENCES parents(id) ON DELETE CASCADE)');
  sql.exec("INSERT INTO parents VALUES ('p', 1)");
  sql.exec("INSERT INTO children VALUES ('c', 'p')");
  const remade: ChangedTable = { table: 'parents', change: 'remade', columns: ['id', 'fresh'], dropped: [] };
  const answer = resetTables(sql, { tables: [remade], drop: true }, { schema: 'account', transactionSync: (write) => db.transaction(write)(), init: () => {} });

  expect(answer.held).toEqual([{ table: 'parents', rows: 1, stale: true, keepsRows: false, cascades: ['children'] }]);
  expect(answer.dropped).toEqual([]);
  expect(sql.exec('SELECT COUNT(*) AS n FROM children').toArray()).toEqual([{ n: 1 }]);
});
