/**
 * A workspace database has two openers on one machine: the daemon and an interactive chat. A write that meets the
 * other's transaction waits for it; bun:sqlite's own default is to fail at once with "database is locked".
 */
import { workspaceDatabase } from '@kinu.run/test-utils';
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { initWorkspaceSchema } from '@kinu.run/core';
import { spawnTest, scratchDir } from '@kinu.run/test-utils'
import { createCLIRuntime, makeWorkspaceSchemaSql, workspaceMemory } from '../src';

const LLM = { name: 'openai-compat', baseURL: 'http://localhost:0', headers: {}, model: 'm' } as const;

/** A workspace database that records how each transaction it opens begins: called plainly, one begins DEFERRED. */
class RecordingDatabase extends Database {
  readonly began: string[] = [];

  override transaction<A extends unknown[], T>(inside: (...args: A) => T) {
    const real = super.transaction(inside);

    const entered = (mode: string, run: () => T): T => {
      this.began.push(mode);

      return run();
    };

    return Object.assign((...args: A) => entered('deferred', () => real(...args)), {
      deferred: (...args: A) => entered('deferred', () => real.deferred(...args)),
      immediate: (...args: A) => entered('immediate', () => real.immediate(...args)),
      exclusive: (...args: A) => entered('exclusive', () => real.exclusive(...args)),
    });
  }
}

test('a write while another process holds the database waits for it instead of failing', async () => {
  const dbPath = join(scratchDir('shared-db'), 'agent.db');
  const db = workspaceDatabase(dbPath, { create: true });
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { cwd: scratchDir('workspace-folder'), llm: LLM });

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

// A deferred transaction that read first fails at once when the other opener has written, busy timeout or not
// (`writeTransaction`). The memory's index write, a decision's admission and Stop's cancellation each began one.
test("the memory's index writes begin IMMEDIATE, through the workspace's memory and the runtime's", async () => {
  const dbPath = join(scratchDir('shared-db'), 'agent.db');
  const setup = workspaceDatabase(dbPath, { create: true });

  initWorkspaceSchema(makeWorkspaceSchemaSql(setup));
  createCLIRuntime(setup, { cwd: scratchDir('workspace-folder'), llm: LLM });
  setup.close();
  const db = new RecordingDatabase(dbPath);

  db.exec('PRAGMA journal_mode = WAL');
  await workspaceMemory(db).write('memory/bakery.md', 'Flour and Hearth opens at seven.');
  await createCLIRuntime(db, { cwd: scratchDir('workspace-folder'), llm: LLM }).memoryStore.indexFile('memory/hours.md', 'Closed on Mondays.');

  expect({ any: db.began.length > 0, other: db.began.filter((mode) => mode !== 'immediate') }).toEqual({ any: true, other: [] });
});
