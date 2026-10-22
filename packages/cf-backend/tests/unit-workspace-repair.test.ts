// A workspace a release left behind is reset as its object constructs, by the root's whole init: the tables it makes
// after it starts too, the webhook secrets, which production's build made with a column this one dropped (core
// state/schema-repair.ts). The changed table is made anew empty, every other keeps its rows, and it is stamped.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { SCHEMA_STAMPS } from '@kinu.run/core';
import { unstartedOrchestratorHarness } from './helpers/actor-harness';
import { kvOf } from './helpers/platform-context';

test('a workspace holding the webhook secrets as production made them drops them as it constructs, and keeps its triggers', () => {
  const db = new Database(':memory:');

  unstartedOrchestratorHarness(undefined, 'repaired', db);
  db.exec("INSERT INTO triggers (actor_id, id, kind, creator_trust, created_at) VALUES ('main', 't-1', 'webhook_durable', 'owner', 1)");
  db.exec(`CREATE TABLE webhook_secrets (secret_id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, secret TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO webhook_secrets VALUES ('s-1', 't-1', 'hush', 1)`);
  kvOf(db).set('kinu.schema_stamp', 1);

  unstartedOrchestratorHarness(undefined, 'repaired', db);

  // Stamped only once every table is this build's: nothing was refused.
  expect(kvOf(db).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.workspace);
  expect(db.query('SELECT COUNT(*) AS n FROM webhook_secrets').all()).toEqual([{ n: 0 }]);
  expect(db.query('SELECT id FROM triggers').all()).toEqual([{ id: 't-1' }]);
  db.exec("INSERT INTO webhook_secrets (secret_id, trigger_id, secret) VALUES ('s-2', 't-1', 'also')");
});

test('a workspace missing a table its init makes gets it, every other table kept, with no unapproved edits invented', () => {
  const db = new Database(':memory:');

  unstartedOrchestratorHarness(undefined, 'shared', db);
  db.exec(`INSERT INTO slate_shares (id, kind, slate_id, visibility, handle, grant_json, created_at, mode, grant_revision)
    VALUES ('s-1', 'live', 'board', 'users', '0123456789', '{"slates":["board"],"members":[]}', 1, 'owner', 'r0')`);
  db.exec("INSERT INTO slate_share_users VALUES ('s-1', 'u-pat', 'pat@example.test', 1, 'edit')");
  db.exec('DROP TABLE slate_edit_marks');
  kvOf(db).set('kinu.schema_stamp', 1);

  unstartedOrchestratorHarness(undefined, 'shared', db);

  expect(kvOf(db).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.workspace);
  expect(db.query('SELECT id, handle, mode, grant_revision FROM slate_shares').all())
    .toEqual([{ id: 's-1', handle: '0123456789', mode: 'owner', grant_revision: 'r0' }]);
  expect(db.query('SELECT email, role FROM slate_share_users').all()).toEqual([{ email: 'pat@example.test', role: 'edit' }]);
  expect(db.query('SELECT * FROM slate_edit_marks').all()).toEqual([]);
  db.exec("INSERT INTO slate_edit_marks VALUES ('board', 'pat@example.test')");
});
