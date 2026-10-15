// Each class of Durable Object database is stamped with the digest of the genesis of the tables its init makes
// (core identity/schema-stamp.ts). Which tables those are is measured here, by making each as production makes it, and
// held in scripts/schema-classes.json, which the stamps are derived from: a class whose init makes another table
// fails here until the file is rewritten (KINU_SCHEMA_CLASSES=write), and its stamp moves with it.
import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { orchestratorHarness } from './helpers/actor-harness';
import { agentDatabase } from './helpers/agent-facets';
import { createTestUserDO } from './helpers/user-do';

const CLASSES = join(import.meta.dir, '..', '..', '..', 'scripts', 'schema-classes.json');

const LOCK = join(import.meta.dir, '..', '..', '..', 'scripts', 'schema-genesis.lock.json');

const NameSchema = v.object({ name: v.string() });

/** The product's tables `db` holds: those the genesis lock records, the platform's and the SDK's left out. */
function madeTables(db: Database): string[] {
  const product = new Set(Object.keys(v.parse(v.record(v.string(), v.unknown()), JSON.parse(readFileSync(LOCK, 'utf8')))).map((key) => key.slice(0, key.indexOf('@'))));

  return db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => v.parse(NameSchema, row).name).filter((table) => product.has(table));
}

test('each Durable Object class makes the tables scripts/schema-classes.json names for it', () => {
  const account = createTestUserDO();
  const workspace = orchestratorHarness();
  const measured = { account: madeTables(account.db), workspace: madeTables(workspace.db), agent: madeTables(agentDatabase(workspace.db, 'schema-classes')) };
  const held = v.parse(v.record(v.string(), v.array(v.string())), JSON.parse(readFileSync(CLASSES, 'utf8')));

  account.close();

  if (process.env.KINU_SCHEMA_CLASSES === 'write') writeFileSync(CLASSES, `${JSON.stringify({ ...held, ...measured }, null, 2)}\n`);
  expect({ account: held.account, workspace: held.workspace, agent: held.agent }).toEqual(measured);
});
