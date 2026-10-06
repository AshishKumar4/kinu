// openWorkspaceCLI: the local resume path, reading a workspace's identity and SOUL.md.
import { workspaceHome } from '../src/runtime';
import { scratchDir } from '../../test-utils/src/scratch';
import { spawnTest } from '@kinu.run/test-utils';

import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LLMProviderConfig } from '@kinu.run/core';
import { createWorkspace } from '@kinu.run/core/workspace-birth';
import { openWorkspaceCLI } from '../src/open';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

const PURPOSE = 'Run the household and the lab.';

/** Born once: every open case resumes the same workspace, as a second `kinu` process would. */
const bornPath = await (async () => {
  const dbPath = join(scratchDir('open'), 'agent.db');
  const made = new Database(dbPath);
  await createWorkspace(made, { name: 'jarvis', purpose: PURPOSE, llm: DUMMY_LLM, home: workspaceHome(made) });
  made.close();

  return dbPath;
})();

describe('openWorkspaceCLI', () => {
  test('reads the soul out of the workspace filesystem, and its mission onto the identity row', async () => {
    const db = new Database(bornPath);

    const { info } = await openWorkspaceCLI(db, bornPath, { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM });

    expect(info.soul).toContain(PURPOSE);
    expect(info.purpose).toBe(PURPOSE);
    db.close();
  });

  test('opening waits out another process\'s write instead of failing on the lock', async () => {
    // Another process (the daemon) is mid-write when this one opens the workspace. It commits on its own clock:
    // the open blocks this thread inside SQLite's busy wait, so nothing here could tell it to.
    const holder = spawnTest([process.execPath, '-e', `
      const { Database } = require('bun:sqlite');
      const daemon = new Database(${JSON.stringify(bornPath)});
      daemon.exec('PRAGMA journal_mode = WAL');
      daemon.exec('BEGIN IMMEDIATE');
      console.log('held');
      setTimeout(() => daemon.exec('COMMIT'), 300);
    `], { stdout: 'pipe' });

    const reader = holder.stdout.getReader();
    await reader.read();
    const db = new Database(bornPath);

    expect((await openWorkspaceCLI(db, bornPath, { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM })).info.purpose).toBe(PURPOSE);
    db.close();
    await holder.exited;
  });

  // Nimbus 0.13 resets a 0.12 store on first open: refusal must precede that open and preserve every old table.
  // The refusal reads the database alone, so an in-memory one stands in for the file.
  test.each([
    ['the build before this batch, under an older table schema', 0xaaad420],
    ["a build with today's tables, before the Nimbus store format joined the genesis", 0x1286404],
  ])('a database made by %s is refused by name before any schema runs over it, its files untouched', async (_, stamp) => {
    const db = new Database(':memory:');
    db.exec(`PRAGMA user_version = ${String(stamp)}`);
    db.exec(`CREATE TABLE inodes (path TEXT PRIMARY KEY, parent_path TEXT NOT NULL DEFAULT '', kind INTEGER NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 0, atime INTEGER NOT NULL DEFAULT 0, mtime INTEGER NOT NULL DEFAULT 0, mode INTEGER NOT NULL DEFAULT 0,
      uid INTEGER NOT NULL DEFAULT 1000, gid INTEGER NOT NULL DEFAULT 1000, chunk_count INTEGER NOT NULL DEFAULT 0, content_id TEXT NULL,
      ino INTEGER NULL)`);
    db.exec('CREATE TABLE file_chunks (content_id TEXT NOT NULL, chunk_id INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (content_id, chunk_id))');
    db.run("INSERT INTO inodes (path, parent_path, size, mode, chunk_count, content_id) VALUES ('home/main/notes/plan.md', 'home/main/notes', 16, 420, 1, 'c1')");
    db.run("INSERT INTO file_chunks VALUES ('c1', 0, ?)", [new TextEncoder().encode("the user's work\n")]);
    const tables = db.query('SELECT name, sql FROM sqlite_master ORDER BY name').all();

    await expect(openWorkspaceCLI(db, 'agent.db', { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM })).rejects.toThrow(/made by an older Kinu.*kinu create/s);
    expect(db.query('SELECT name, sql FROM sqlite_master ORDER BY name').all()).toEqual(tables);
    expect(db.query('SELECT path FROM inodes').all()).toEqual([{ path: 'home/main/notes/plan.md' }]);
    db.close();
  });
});
