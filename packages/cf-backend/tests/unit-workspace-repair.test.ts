// A workspace a release left behind is repaired as its object constructs, by the root's whole init: the tables it
// makes after it starts too, the webhook secrets, which production's build made with a column this one dropped
// (core state/schema-repair.ts). Its rows are kept, and it is stamped.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { SCHEMA_STAMPS } from '@kinu.run/core';
import { unstartedOrchestratorHarness } from './helpers/actor-harness';
import { kvOf } from './helpers/platform-context';

test('a workspace holding the webhook secrets as production made them repairs them as it constructs, keeping each', () => {
  const db = new Database(':memory:');

  unstartedOrchestratorHarness(undefined, 'repaired', db);
  db.exec("INSERT INTO triggers (actor_id, id, kind, creator_trust, created_at) VALUES ('main', 't-1', 'webhook_durable', 'owner', 1)");
  db.exec(`CREATE TABLE webhook_secrets (secret_id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, secret TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO webhook_secrets VALUES ('s-1', 't-1', 'hush', 1)`);
  kvOf(db).set('kinu.schema_stamp', 1);

  unstartedOrchestratorHarness(undefined, 'repaired', db);

  // Stamped only once every table is this build's: nothing was refused.
  expect(kvOf(db).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.workspace);
  expect(db.query('SELECT secret_id, secret FROM webhook_secrets').all()).toEqual([{ secret_id: 's-1', secret: 'hush' }]);
  db.exec("INSERT INTO webhook_secrets (secret_id, trigger_id, secret) VALUES ('s-2', 't-1', 'also')");
});

test('a workspace\'s live shares made before share modes repair to their viewers\' own access, no owner grant implied', () => {
  const db = new Database(':memory:');

  unstartedOrchestratorHarness(undefined, 'shared', db);
  db.exec(`DROP TABLE slate_live_shares; CREATE TABLE slate_live_shares (
    id TEXT PRIMARY KEY, slate_id TEXT NOT NULL, visibility TEXT NOT NULL CHECK (visibility IN ('users', 'public')),
    handle TEXT NOT NULL UNIQUE, grant_json TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER
  ); INSERT INTO slate_live_shares VALUES ('s-1', 'board', 'users', '0123456789', '{"slates":["board"],"members":[]}', 1, NULL)`);
  kvOf(db).set('kinu.schema_stamp', 1);

  unstartedOrchestratorHarness(undefined, 'shared', db);

  expect(kvOf(db).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.workspace);
  // Nor listed in the Gallery: no share was before the listing columns.
  expect(db.query('SELECT id, handle, mode, grant_revision, listing_line, listing_category FROM slate_live_shares').all())
    .toEqual([{ id: 's-1', handle: '0123456789', mode: 'own', grant_revision: null, listing_line: null, listing_category: null }]);
});

test('a workspace\'s share people added before roles repair to using the slate, none of them to edit it', () => {
  const db = new Database(':memory:');

  unstartedOrchestratorHarness(undefined, 'shared', db);
  db.exec(`DROP TABLE slate_live_share_users; CREATE TABLE slate_live_share_users (
    share_id TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (share_id, user_id)
  ); INSERT INTO slate_live_share_users VALUES ('s-1', 'u-pat', 'pat@example.test', 1)`);
  kvOf(db).set('kinu.schema_stamp', 1);

  unstartedOrchestratorHarness(undefined, 'shared', db);

  expect(kvOf(db).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.workspace);
  expect(db.query('SELECT share_id, user_id, email, role FROM slate_live_share_users').all())
    .toEqual([{ share_id: 's-1', user_id: 'u-pat', email: 'pat@example.test', role: 'use' }]);
});
