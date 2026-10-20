// A local workspace's database is stamped with the digest of the genesis of the tables a local workspace makes (core
// identity/schema-stamp.ts). Which tables those are is measured here, by making one as `kinu create` does, and held in
// scripts/schema-classes.json under `local`: a local workspace that makes another table fails here until the file is
// rewritten (KINU_SCHEMA_CLASSES=write), and its stamp moves with it.
import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { scratchDir, scratchPath, workspaceDatabase } from '@kinu.run/test-utils';
import { ensureIndexTables, initMissionBudgetTable, initWorkspaceSchema, type LLMProviderConfig } from '@kinu.run/core';
import { createWorkspace } from '@kinu.run/core/workspace-birth';
import { createCLIRuntime, makeWorkspaceSchemaSql, workspaceHome } from '../src/runtime';

const CLASSES = join(import.meta.dir, '..', '..', '..', 'scripts', 'schema-classes.json');

const LOCK = join(import.meta.dir, '..', '..', '..', 'scripts', 'schema-genesis.lock.json');

const LLM: LLMProviderConfig = { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model' };

const NameSchema = v.object({ name: v.string() });

test('a local workspace makes the tables scripts/schema-classes.json names for it', async () => {
  const db = workspaceDatabase(scratchPath('schema-classes', 'agent.db'));

  await createWorkspace(db, { name: 'schema-classes', purpose: 'measuring its tables', home: workspaceHome(db) });
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  createCLIRuntime(db, { cwd: scratchDir('schema-classes-folder'), llm: LLM });
  // Made on first use: the conversation index (a search), a ledger (a session).
  ensureIndexTables(makeWorkspaceSchemaSql(db).sql);
  initMissionBudgetTable(makeWorkspaceSchemaSql(db).execRaw);

  const product = new Set(Object.keys(v.parse(v.record(v.string(), v.unknown()), JSON.parse(readFileSync(LOCK, 'utf8')))).map((key) => key.slice(0, key.indexOf('@'))));
  const local = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => v.parse(NameSchema, row).name).filter((table) => product.has(table));
  const held = v.parse(v.record(v.string(), v.array(v.string())), JSON.parse(readFileSync(CLASSES, 'utf8')));

  db.close();

  if (process.env.KINU_SCHEMA_CLASSES === 'write') writeFileSync(CLASSES, `${JSON.stringify({ ...held, local }, null, 2)}\n`);
  expect(held.local).toEqual(local);
});
