/**
 * A workspace database has two openers on one machine: the daemon and an interactive chat. A write that meets the
 * other's transaction waits for it; bun:sqlite's own default is to fail at once with "database is locked".
 */
import { workspaceDatabase } from '@kinu.run/test-utils';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { initWorkspaceSchema } from '@kinu.run/core';
import { spawnTest, scratchDir } from '@kinu.run/test-utils'
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src';

test('a write while another process holds the database waits for it instead of failing', async () => {
  const dbPath = join(scratchDir('shared-db'), 'agent.db');
  const db = workspaceDatabase(dbPath, { create: true });
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { cwd: scratchDir('workspace-folder'), llm: { name: 'openai-compat', baseURL: 'http://localhost:0', headers: {}, model: 'm' } });

  const holder = spawnTest(['bun', '-e', `
    const { Database } = require('bun:sqlite');
    const db = new Database(${JSON.stringify(dbPath)});
    db.exec('BEGIN IMMEDIATE');
    console.log('held');
    setTimeout(() => { db.exec('COMMIT'); process.exit(0); }, 300);
  `], { stdout: 'pipe' });

  try {
    await holder.stdout.getReader().read();
    rt.storage.execRaw('CREATE TABLE IF NOT EXISTS shared_probe (x INTEGER)');
    void rt.storage.sql`INSERT INTO shared_probe (x) VALUES (${1})`;

    expect(rt.storage.sql<{ x: number }>`SELECT x FROM shared_probe`).toEqual([{ x: 1 }]);
  } finally {
    expect(await holder.exited).toBe(0);
  }
});
