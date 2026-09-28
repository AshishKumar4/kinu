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

  // What the build before Nimbus 0.13 left: its genesis stamp over a 0.12 store holding the user's file. Nimbus 0.13
  // resets such a store on its first open, so the refusal must come before it: every table stays as it was.
  test('a database an older Kinu made is refused by name before any schema runs over it, its files untouched', async () => {
    const dir = scratchDir('open-older');
    const dbPath = join(dir, 'agent.db');
    const db = new Database(dbPath);
    db.exec(`PRAGMA user_version = ${String(0xaaad420)}`);
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
