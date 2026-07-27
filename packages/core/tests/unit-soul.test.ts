// Regression tests for SOUL.md storage (b7fefa1 fallout):
//   1. writeSoul must produce canonical BLOB rows that SqliteFS can read
//      (the broken writer stored TEXT and every VFS read threw atob errors).
//   2. The agent_soul → SOUL.md switch must migrate legacy databases instead
//      of refusing to open them / silently dropping the agent's purpose.
//   3. TEXT-corrupted SOUL.md rows (written by the broken writer in
//      production) must be recovered and re-encoded.
//   4. Reads must stay reads: the repairs belong to migrateWorkspaceStorage,
//      so readSoul works against a readonly database (`proteus list`).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SqliteFS } from '@proteus/agent-utils/vfs';
import { readSoul, writeSoul, seedSoul, SOUL_PATH } from '../src/identity/soul.js';
import { initAllTables, migrateWorkspaceStorage } from '../src/identity/schema.js';
import { openWorkspace } from '../src/identity/open.js';
import { wrapDatabase, type AgentDatabase } from '../src/identity/inline-primitives.js';
import { makeSql, makeExecRaw } from './helpers.js';

const TEST_LLM = { name: 'test', baseURL: 'http://localhost:0', headers: {}, model: 'test-model' };

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDb() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  return { db, sql, execRaw };
}

describe('writeSoul ↔ SqliteFS interop', () => {
  test('writeSoul stores a BLOB row that SqliteFS.readFile round-trips', async () => {
    const { sql, execRaw } = freshDb();
    initAllTables(execRaw);

    const markdown = '# Jarvis\n\n## Mission\n\nRun the lab.';
    writeSoul(sql, markdown);

    const row = sql<{ t: string }>`SELECT typeof(data) AS t FROM vfs_files WHERE path = ${SOUL_PATH}`;
    expect(row[0]?.t).toBe('blob');

    const fs = new SqliteFS(sql);
    fs.init();
    expect(await fs.readFile(SOUL_PATH, { encoding: 'utf8' })).toBe(markdown);
  });

  test('SqliteFS.writeFile content is readable through readSoul', async () => {
    const { sql, execRaw } = freshDb();
    initAllTables(execRaw);

    const fs = new SqliteFS(sql);
    fs.init();
    await fs.writeFile(SOUL_PATH, '# Vega\n\n## Mission\n\nObserve.');

    expect(readSoul(sql)).toBe('# Vega\n\n## Mission\n\nObserve.');
  });

  test('seedSoul renders name + mission and round-trips', () => {
    const { sql, execRaw } = freshDb();
    initAllTables(execRaw);

    const soul = seedSoul(sql, { name: 'Atlas', mission: 'Map everything.' });
    expect(soul).toContain('# Atlas');
    expect(soul).toContain('Map everything.');
    expect(readSoul(sql)).toBe(soul);
  });

  test('readSoul throws loudly when vfs_files is missing (no silent fallback)', () => {
    const { sql } = freshDb();
    expect(() => readSoul(sql)).toThrow(/vfs_files/);
  });
});

describe('legacy migrations', () => {
  test('TEXT-corrupted SOUL.md row reads back verbatim without being rewritten', () => {
    const { db, sql, execRaw } = freshDb();
    initAllTables(execRaw);
    // Exactly what the broken writer produced: markdown bound as TEXT.
    const markdown = '# Echo\n\n## Mission\n\nSurvive the encoding bug.';
    db.run(
      'INSERT INTO vfs_files (path, chunk_index, parent_path, data, is_dir, size, mtime) VALUES (?, 0, ?, ?, 0, ?, ?)',
      [SOUL_PATH, '', markdown, markdown.length, Date.now()],
    );

    expect(readSoul(sql)).toBe(markdown);
    const row = sql<{ t: string }>`SELECT typeof(data) AS t FROM vfs_files WHERE path = ${SOUL_PATH}`;
    expect(row[0]?.t).toBe('text');
  });

  test('migrateWorkspaceStorage re-encodes a TEXT SOUL.md row as a canonical BLOB', async () => {
    const { db, sql, execRaw } = freshDb();
    initAllTables(execRaw);
    const markdown = '# Echo\n\n## Mission\n\nSurvive the encoding bug.';
    db.run(
      'INSERT INTO vfs_files (path, chunk_index, parent_path, data, is_dir, size, mtime) VALUES (?, 0, ?, ?, 0, ?, ?)',
      [SOUL_PATH, '', markdown, markdown.length, Date.now()],
    );

    migrateWorkspaceStorage(sql);

    const row = sql<{ t: string }>`SELECT typeof(data) AS t FROM vfs_files WHERE path = ${SOUL_PATH}`;
    expect(row[0]?.t).toBe('blob');
    const fs = new SqliteFS(sql);
    fs.init();
    expect(await fs.readFile(SOUL_PATH, { encoding: 'utf8' })).toBe(markdown);
    expect(readSoul(sql)).toBe(markdown);
  });

  test('readSoul works against a readonly database (proteus list / status)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proteus-soul-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'agent.db');
    const markdown = '# Jarvis\n\n## Mission\n\nRun the house.';

    const writable = new Database(dbPath);
    initAllTables(makeExecRaw(writable));
    writable.run(
      'INSERT INTO vfs_files (path, chunk_index, parent_path, data, is_dir, size, mtime) VALUES (?, 0, ?, ?, 0, ?, ?)',
      [SOUL_PATH, '', markdown, markdown.length, Date.now()],
    );
    writable.close();

    const readonly = new Database(dbPath, { readonly: true });
    expect(readSoul(makeSql(readonly))).toBe(markdown);
    readonly.close();
  });

  test('legacy agent_soul table migrates to SOUL.md with purpose preserved, then drops', () => {
    const { db, sql, execRaw } = freshDb();
    initAllTables(execRaw);
    sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'legacy-id'}, ${'Legacy Agent'}, ${1})`;
    execRaw(`CREATE TABLE agent_soul (
      purpose       TEXT NOT NULL,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      owner_user_id TEXT NOT NULL DEFAULT ''
    )`);
    db.run('INSERT INTO agent_soul (purpose) VALUES (?)', ['Track satellites for the user']);

    // Readable before the migration runs, and unchanged by reading it.
    const beforeMigration = readSoul(sql);
    expect(beforeMigration).toContain('Track satellites for the user');

    migrateWorkspaceStorage(sql);

    const soul = readSoul(sql);
    expect(soul).toBe(beforeMigration);
    expect(soul).toContain('# Legacy Agent');

    // Table dropped; subsequent reads come from SOUL.md.
    const tables = sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_soul'`;
    expect(tables.length).toBe(0);
  });

  test('legacy agent_identity row is adopted as the workspace identity', () => {
    const { db, sql, execRaw } = freshDb();
    initAllTables(execRaw);
    execRaw(`CREATE TABLE agent_identity (
      id            TEXT NOT NULL,
      name          TEXT NOT NULL,
      owner_user_id TEXT NOT NULL DEFAULT '',
      created_at    INTEGER NOT NULL
    )`);
    db.run('INSERT INTO agent_identity (id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?)',
      ['jarvis-id', 'jarvis', 'owner-1', 1781042330894]);

    migrateWorkspaceStorage(sql);

    expect(sql<{ id: string; name: string; owner_user_id: string; created_at: number }>`
      SELECT id, name, owner_user_id, created_at FROM workspace_identity
    `).toEqual([{ id: 'jarvis-id', name: 'jarvis', owner_user_id: 'owner-1', created_at: 1781042330894 }]);
    expect(sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_identity'
    `.length).toBe(0);

    // Idempotent: a second pass leaves the adopted row alone.
    migrateWorkspaceStorage(sql);
    expect(sql<{ c: number }>`SELECT COUNT(*) AS c FROM workspace_identity`[0]?.c).toBe(1);
  });

  test('agent_identity predating owner_user_id is adopted with an empty owner', () => {
    const { db, sql, execRaw } = freshDb();
    initAllTables(execRaw);
    execRaw(`CREATE TABLE agent_identity (id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    db.run('INSERT INTO agent_identity (id, name, created_at) VALUES (?, ?, ?)', ['old-id', 'old', 7]);

    migrateWorkspaceStorage(sql);

    expect(sql<{ id: string; owner_user_id: string }>`
      SELECT id, owner_user_id FROM workspace_identity
    `).toEqual([{ id: 'old-id', owner_user_id: '' }]);
  });

  test('legacy CLI agent (agent_soul era) opens through openWorkspace with purpose intact', () => {
    const db = new Database(':memory:') as unknown as AgentDatabase & Database;
    const { sql, execRaw } = wrapDatabase(db);
    initAllTables(execRaw);
    sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'old-cli'}, ${'old-cli-agent'}, ${42})`;
    execRaw(`CREATE TABLE agent_soul (purpose TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0)`);
    db.run('INSERT INTO agent_soul (purpose) VALUES (?)', ['Keep the garden watered']);

    const { info } = openWorkspace(db, { llm: TEST_LLM });
    expect(info.soul).toContain('Keep the garden watered');
    expect(info.purpose).toContain('Keep the garden watered');
    expect(info.name).toBe('old-cli-agent');
  });

  test('empty legacy agent_soul reports no soul, and the migration drops the table', () => {
    const { sql, execRaw } = freshDb();
    initAllTables(execRaw);
    execRaw(`CREATE TABLE agent_soul (purpose TEXT NOT NULL)`);

    expect(readSoul(sql)).toBeNull();

    migrateWorkspaceStorage(sql);

    const tables = sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_soul'`;
    expect(tables.length).toBe(0);
    expect(readSoul(sql)).toBeNull();
  });
});
