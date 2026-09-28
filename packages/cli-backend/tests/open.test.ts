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

  test('a database an older Kinu made is refused by name before any schema runs over it', async () => {
    const dir = scratchDir('open-older');
    const dbPath = join(dir, 'agent.db');
    const db = new Database(dbPath);
    await createWorkspace(db, { name: 'jarvis', purpose: 'Run the lab.', llm: DUMMY_LLM });
    db.exec('PRAGMA user_version = 0');
    const tables = db.query('SELECT name, sql FROM sqlite_master ORDER BY name').all();

    await expect(openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM })).rejects.toThrow(/made by an older Kinu.*kinu create/s);
    expect(db.query('SELECT name, sql FROM sqlite_master ORDER BY name').all()).toEqual(tables);
    db.close();
  });
});
