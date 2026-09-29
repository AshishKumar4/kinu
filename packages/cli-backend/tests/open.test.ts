// openWorkspaceCLI: the local resume path, reading a workspace's identity and SOUL.md.
import { scratchDir } from '../../test-utils/src/scratch';

import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LLMProviderConfig } from '@kinu.run/core';
import { createWorkspace } from '@kinu.run/core/workspace-birth';
import { openWorkspaceCLI } from '../src/open';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

describe('openWorkspaceCLI', () => {
  test('reads the soul out of the workspace filesystem, and its mission onto the identity row', async () => {
    const dir = scratchDir('open');
    const dbPath = join(dir, 'agent.db');
    const db = new Database(dbPath);
    await createWorkspace(db, { name: 'jarvis', purpose: 'Run the household and the lab.', llm: DUMMY_LLM });

    const { info } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM });

    expect(info.soul).toContain('Run the household and the lab.');
    expect(info.purpose).toBe('Run the household and the lab.');
    db.close();
  });

  test('opening waits out another process\'s write instead of failing on the lock', async () => {
    const dir = scratchDir('open-locked');
    const dbPath = join(dir, 'agent.db');
    const made = new Database(dbPath);
    await createWorkspace(made, { name: 'jarvis', purpose: 'Run the lab.', llm: DUMMY_LLM });
    made.close();

    // Another process (the daemon) is mid-write when this one opens the workspace.
    const holder = Bun.spawn([process.execPath, '-e', `
      const { Database } = require('bun:sqlite');
      const daemon = new Database(${JSON.stringify(dbPath)});
      daemon.exec('PRAGMA journal_mode = WAL');
      daemon.exec('BEGIN IMMEDIATE');
      console.log('held');
      setTimeout(() => daemon.exec('COMMIT'), 300);
    `], { stdout: 'pipe' });

    const reader = holder.stdout.getReader();
    await reader.read();
    const db = new Database(dbPath);

    expect((await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM })).info.purpose).toBe('Run the lab.');
    db.close();
    await holder.exited;
  });

  // Nimbus 0.13 resets a 0.12 store on first open: refusal must precede that open and preserve every old table.
  test.each([
    ['the build before this batch, under an older table schema', 0xaaad420],
    ["a build with today's tables, before the Nimbus store format joined the genesis", 0x1286404],
  ])('a database made by %s is refused by name before any schema runs over it, its files untouched', async (_, stamp) => {
    const dir = scratchDir('open-older');
    const dbPath = join(dir, 'agent.db');
    const db = new Database(dbPath);
    db.exec(`PRAGMA user_version = ${String(stamp)}`);
    db.exec(`CREATE TABLE inodes (path TEXT PRIMARY KEY, parent_path TEXT NOT NULL DEFAULT '', kind INTEGER NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 0, atime INTEGER NOT NULL DEFAULT 0, mtime INTEGER NOT NULL DEFAULT 0, mode INTEGER NOT NULL DEFAULT 0,
      uid INTEGER NOT NULL DEFAULT 1000, gid INTEGER NOT NULL DEFAULT 1000, chunk_count INTEGER NOT NULL DEFAULT 0, content_id TEXT NULL,
      ino INTEGER NULL)`);
    db.exec('CREATE TABLE file_chunks (content_id TEXT NOT NULL, chunk_id INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (content_id, chunk_id))');
    db.run("INSERT INTO inodes (path, parent_path, size, mode, chunk_count, content_id) VALUES ('home/main/notes/plan.md', 'home/main/notes', 16, 420, 1, 'c1')");
    db.run("INSERT INTO file_chunks VALUES ('c1', 0, ?)", [new TextEncoder().encode("the user's work\n")]);
    const tables = db.query('SELECT name, sql FROM sqlite_master ORDER BY name').all();

    await expect(openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM })).rejects.toThrow(/made by an older Kinu.*kinu create/s);
    expect(db.query('SELECT name, sql FROM sqlite_master ORDER BY name').all()).toEqual(tables);
    expect(db.query('SELECT path FROM inodes').all()).toEqual([{ path: 'home/main/notes/plan.md' }]);
    db.close();
  });
});
