// The control plane's index is a class of its own (`control`), repaired as its object starts like every other class's
// database (core state/schema-repair.ts): an index a release left behind, or one made before the class had a stamp,
// keeps its rows and is stamped; one whose repair refuses answers every call with why.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { opsCaller, SCHEMA_STAMPS } from '@kinu.run/core';
import { internalCaller } from '@kinu.run/core/control-plane';
import { ControlPlaneDO } from '../src/control-plane/control-plane-do';
import { workerEnv } from './helpers/bindings';
import { kvOf, makeCtx } from './helpers/platform-context';

const env = workerEnv({ CREDENTIAL_ENCRYPTION_KEY: 'c'.repeat(64) });

/** The index as the build before this one made it: no stamp, a user seen, and the feedback a column it dropped. */
function before(): Database {
  const db = new Database(':memory:');

  new ControlPlaneDO(makeCtx(db, 'site'), env);
  kvOf(db).delete('kinu.schema_stamp');
  db.exec("INSERT INTO cp_users (user_id, email, first_seen_at, last_seen_at) VALUES ('u-1', 'one@example.com', 1, 2)");

  return db;
}

test('an index made before its class had a stamp is repaired as it starts, keeping its rows, and answers', async () => {
  const db = before();

  db.exec('ALTER TABLE cp_feedback ADD COLUMN legacy TEXT');
  const plane = new ControlPlaneDO(makeCtx(db, 'site'), env);

  expect(kvOf(db).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.control);
  expect((await plane.opsTables(await opsCaller(env))).repair?.rebuilt).toEqual(['cp_feedback']);
  expect(await plane.opsUsers(await opsCaller(env))).toEqual(['u-1']);
});

test('an index whose repair refuses answers every call with why, and keeps its rows', async () => {
  const db = before();

  // Rows the build's shape cannot take: a NOT NULL column with no default and no source.
  db.exec('DROP TABLE cp_audit; CREATE TABLE cp_audit (id TEXT PRIMARY KEY); INSERT INTO cp_audit VALUES (\'a-1\')');
  const plane = new ControlPlaneDO(makeCtx(db, 'site'), env);

  await expect(plane.observeUser(await internalCaller(env), { userId: 'u-2', email: 'two@example.com', at: 3 })).rejects.toThrow('cp_audit');
  await expect(plane.opsUsers(await opsCaller(env))).rejects.toThrow('cp_audit');
  expect((await plane.opsTables(await opsCaller(env))).refused).toContain('cp_audit');
  expect(db.query('SELECT id FROM cp_audit').all()).toEqual([{ id: 'a-1' }]);
});

test('an index made now is stamped as this build\'s', () => {
  const db = new Database(':memory:');

  new ControlPlaneDO(makeCtx(db, 'site'), env);
  expect(kvOf(db).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.control);
});
