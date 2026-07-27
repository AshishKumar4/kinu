// openWorkspaceCLI — the local workspace resume path. A ~/.proteus workspace is
// a file that outlives schema changes, so opening one created against an older
// schema must upgrade it in place instead of rejecting it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LLMProviderConfig } from '@proteus/core';
import { openWorkspaceCLI } from '../src/open.js';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Identity in `agent_identity`, SOUL.md bound as TEXT — the shape of a
 *  workspace created before the rename and the VFS BLOB-encoding fix. */
function legacyWorkspace(): { db: Database; dbPath: string } {
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
    CREATE TABLE vfs_files (
      path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      parent_path TEXT NOT NULL DEFAULT '',
      data BLOB,
      is_dir INTEGER NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 0,
      mtime INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (path, chunk_index)
    );
  `);
  db.run('INSERT INTO agent_identity (id, name, created_at) VALUES (?, ?, ?)', ['legacy-1', 'jarvis', 1781042330894]);
  const soul = '# jarvis\n\n## Mission\n\nRun the household and the lab.';
  db.run('INSERT INTO vfs_files (path, chunk_index, data, is_dir, size, mtime) VALUES (?, 0, ?, 0, ?, ?)', [
    'SOUL.md', soul, soul.length, 1,
  ]);
  return { db, dbPath };
}

describe('openWorkspaceCLI on a pre-current-schema workspace', () => {
  test('adopts the legacy identity instead of refusing to open', () => {
    const { db, dbPath } = legacyWorkspace();

    const { info } = openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM });

    expect(info.id).toBe('legacy-1');
    expect(info.name).toBe('jarvis');
    expect(info.createdAt).toBe(1781042330894);
    expect(info.purpose).toBe('Run the household and the lab.');
    expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'agent_identity'`).get()).toBeNull();
  });

  test('re-encodes the TEXT SOUL.md row so the VFS can read it', () => {
    const { db, dbPath } = legacyWorkspace();

    openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM });

    expect(db.query(`SELECT typeof(data) AS t FROM vfs_files WHERE path = 'SOUL.md'`).get())
      .toEqual({ t: 'blob' });
  });
});
