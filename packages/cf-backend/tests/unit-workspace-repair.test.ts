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
