// openWorkspaceCLI — the local workspace resume path. It opens a workspace
// file and reads its identity and SOUL.md.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LLMProviderConfig } from '@kinu.run/core';
import { createWorkspace } from '@kinu.run/core/identity';
import { openWorkspaceCLI } from '../src/open';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('openWorkspaceCLI', () => {
  test('reads the soul out of the workspace filesystem, and its mission onto the identity row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kinu-open-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'agent.db');
    const db = new Database(dbPath);
    await createWorkspace(db, { name: 'jarvis', purpose: 'Run the household and the lab.', llm: DUMMY_LLM });

    const { info } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM });

    expect(info.soul).toContain('Run the household and the lab.');
    expect(info.purpose).toBe('Run the household and the lab.');
    db.close();
  });
});
