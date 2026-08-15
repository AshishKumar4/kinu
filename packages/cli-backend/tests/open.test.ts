// openWorkspaceCLI — the local workspace resume path. A ~/.proteus workspace is
// a file that outlives schema changes, so opening one created against an older
// schema must upgrade it in place instead of rejecting it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LLMProviderConfig } from '@proteus/core';
import { createInlineWorkspace } from '@proteus/core/identity';
import { openWorkspaceCLI } from '../src/open.js';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Identity in `agent_identity` — the shape of a workspace created before the
 *  rename to `workspace_identity`. Its SOUL.md is an ordinary file, because a
 *  workspace's files have only ever been files. */
async function legacyWorkspace(): Promise<{ db: Database; dbPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'proteus-open-legacy-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'agent.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE agent_identity (
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      owner_user_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `);
  db.run('INSERT INTO agent_identity (id, name, created_at) VALUES (?, ?, ?)', ['legacy-1', 'jarvis', 1781042330894]);
  const workspace = createInlineWorkspace(db);
  await workspace.vfs.writeFile('SOUL.md', '# jarvis\n\n## Mission\n\nRun the household and the lab.');
  return { db, dbPath };
}

describe('openWorkspaceCLI on a pre-current-schema workspace', () => {
  test('adopts the legacy identity instead of refusing to open', async () => {
    const { db, dbPath } = await legacyWorkspace();

    const { info } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM });

    expect(info.id).toBe('legacy-1');
    expect(info.name).toBe('jarvis');
    expect(info.createdAt).toBe(1781042330894);
    expect(info.purpose).toBe('Run the household and the lab.');
    expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'agent_identity'`).get()).toBeNull();
  });

  test('reads the soul out of the workspace filesystem, and its mission onto the identity row', async () => {
    const { db, dbPath } = await legacyWorkspace();

    const { info } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM });

    expect(info.soul).toContain('Run the household and the lab.');
    expect(info.purpose).toBe('Run the household and the lab.');
  });
});
