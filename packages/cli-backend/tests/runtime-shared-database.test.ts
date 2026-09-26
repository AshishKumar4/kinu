/**
 * A workspace database has two openers on one machine: the daemon and an interactive chat. A write that meets the
 * other's transaction waits for it; bun:sqlite's own default is to fail at once with "database is locked".
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { initWorkspaceSchema } from '@kinu.run/core';
import { scratchDir } from '@kinu.run/test-utils';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src';

test('a write while another process holds the database waits for it instead of failing', async () => {
  const dbPath = join(scratchDir('shared-db'), 'agent.db');
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { dbPath, llm: { name: 'openai-compat', baseURL: 'http://localhost:0', headers: {}, model: 'm' } });

  const holder = Bun.spawn(['bun', '-e', `
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
