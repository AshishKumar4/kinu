// A database is asked its class's stamp, never caught failing (identity/schema-stamp.ts): this build's stamp opens it,
// none on a database its class never made makes it, and anything else is behind this build, a Durable Object made
// before stamps were per class (0, with its tables) among them.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { readStamp, requireSchemaStamp, SCHEMA_STAMPS, stampOf, writeStamp } from '../src/index';
import { sqlStorageOver } from '../src/identity/inline-primitives';

test('a database is current, unmade or behind by one PRAGMA, and one its class made unstamped is behind', () => {
  const sql = sqlStorageOver(new Database(':memory:'));

  expect(readStamp(sql, 'account')).toBe('unmade');
  sql.exec('CREATE TABLE user_profile (id INTEGER PRIMARY KEY)');
  expect(readStamp(sql, 'account')).toBe('behind');
  writeStamp(sql, 'account');
  expect(stampOf(sql)).toBe(SCHEMA_STAMPS.account);
  expect(readStamp(sql, 'account')).toBe('current');
  // Another class's stamp is behind this one's, though each opens under its own.
  expect(readStamp(sql, 'workspace')).toBe('behind');
});

test('each class has its own stamp, so one class\'s change refuses no other\'s databases', () => {
  expect(new Set(Object.values(SCHEMA_STAMPS)).size).toBe(Object.keys(SCHEMA_STAMPS).length);
});

test('a local database or an export under another stamp is refused by name', () => {
  requireSchemaStamp('Workspace "scout"', 'local', SCHEMA_STAMPS.local);
  expect(() => requireSchemaStamp('Workspace "scout"', 'local', 0)).toThrow('Workspace "scout" was made by an older version of Kinu');
  expect(() => requireSchemaStamp('Workspace "scout"', 'local', SCHEMA_STAMPS.workspace)).toThrow('kinu create');
});
