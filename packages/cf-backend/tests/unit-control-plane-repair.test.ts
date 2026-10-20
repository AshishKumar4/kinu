// The control plane's index is a class of its own (`control`), reset as its object starts like every other class's
// database (core state/schema-repair.ts): in an index a release left behind, or one made before the class had a stamp,
// each changed table is dropped and made anew empty, every other table keeps its rows, and the index is stamped.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { opsCaller, SCHEMA_STAMPS } from '@kinu.run/core';
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

test('an index made before its class had a stamp is reset as it starts: its changed table made anew, its users kept', async () => {
  const db = before();

  db.exec('ALTER TABLE cp_feedback ADD COLUMN legacy TEXT');
  const plane = new ControlPlaneDO(makeCtx(db, 'site'), env);

  expect(kvOf(db).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.control);
  expect((await plane.opsTables(await opsCaller(env))).repair?.dropped).toEqual(['cp_feedback']);
  expect(await plane.opsUsers(await opsCaller(env))).toEqual(['u-1']);
});

test('a table whose new column has no default is dropped and made anew, empty, and the index answers', async () => {
  const db = before();

  db.exec('DROP TABLE cp_audit; CREATE TABLE cp_audit (id TEXT PRIMARY KEY); INSERT INTO cp_audit VALUES (\'a-1\')');
  const plane = new ControlPlaneDO(makeCtx(db, 'site'), env);
  const answer = await plane.opsTables(await opsCaller(env));

  expect({ dropped: answer.repair?.dropped, refused: answer.refused }).toEqual({ dropped: ['cp_audit'], refused: null });
  expect(db.query('SELECT COUNT(*) AS n FROM cp_audit').all()).toEqual([{ n: 0 }]);
  expect(await plane.opsUsers(await opsCaller(env))).toEqual(['u-1']);
});

test('an index made now is stamped as this build\'s', () => {
  const db = new Database(':memory:');

  new ControlPlaneDO(makeCtx(db, 'site'), env);
  expect(kvOf(db).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.control);
});
