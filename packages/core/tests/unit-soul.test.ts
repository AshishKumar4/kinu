// Regression tests for SOUL.md storage (b7fefa1 fallout):
//   1. writeSoul must produce canonical BLOB rows that SqliteFS can read
//      (the broken writer stored TEXT and every VFS read threw atob errors).
//   2. The agent_soul → SOUL.md switch must migrate legacy databases instead
//      of refusing to open them / silently dropping the agent's purpose.
//   3. TEXT-corrupted SOUL.md rows (written by the broken writer in
//      production) must be recovered and re-encoded.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SqliteFS } from '@proteus/agent-utils/vfs';
import { readSoul, writeSoul, seedSoul, SOUL_PATH } from '../src/identity/soul.js';
import { initAllTables } from '../src/identity/schema.js';
import { openAgent } from '../src/identity/open.js';
import { wrapDatabase, type AgentDatabase } from '../src/identity/inline-primitives.js';
import { makeSql, makeExecRaw } from './helpers.js';

const TEST_LLM = { name: 'test', baseURL: 'http://localhost:0', headers: {}, model: 'test-model' };

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
  test('TEXT-corrupted SOUL.md row is recovered and rewritten as a BLOB', async () => {
    const { db, sql, execRaw } = freshDb();
    initAllTables(execRaw);
    // Exactly what the broken writer produced: markdown bound as TEXT.
    const markdown = '# Echo\n\n## Mission\n\nSurvive the encoding bug.';
    db.run(
      'INSERT INTO vfs_files (path, chunk_index, parent_path, data, is_dir, size, mtime) VALUES (?, 0, ?, ?, 0, ?, ?)',
      [SOUL_PATH, '', markdown, markdown.length, Date.now()],
    );

    expect(readSoul(sql)).toBe(markdown);

    // Healed: now a canonical BLOB readable through the VFS.
    const row = sql<{ t: string }>`SELECT typeof(data) AS t FROM vfs_files WHERE path = ${SOUL_PATH}`;
    expect(row[0]?.t).toBe('blob');
    const fs = new SqliteFS(sql);
    fs.init();
    expect(await fs.readFile(SOUL_PATH, { encoding: 'utf8' })).toBe(markdown);
  });

  test('legacy agent_soul table migrates to SOUL.md with purpose preserved, then drops', () => {
    const { db, sql, execRaw } = freshDb();
    initAllTables(execRaw);
    sql`INSERT INTO agent_identity (id, name, created_at) VALUES (${'legacy-id'}, ${'Legacy Agent'}, ${1})`;
    execRaw(`CREATE TABLE agent_soul (
      purpose       TEXT NOT NULL,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      owner_user_id TEXT NOT NULL DEFAULT ''
    )`);
    db.run('INSERT INTO agent_soul (purpose) VALUES (?)', ['Track satellites for the user']);

    const soul = readSoul(sql);
    expect(soul).toContain('# Legacy Agent');
    expect(soul).toContain('Track satellites for the user');

    // Table dropped; subsequent reads come from SOUL.md.
    const tables = sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_soul'`;
    expect(tables.length).toBe(0);
    expect(readSoul(sql)).toBe(soul);
  });

  test('legacy CLI agent (agent_soul era) opens through openAgent with purpose intact', () => {
    const db = new Database(':memory:') as unknown as AgentDatabase & Database;
    const { sql, execRaw } = wrapDatabase(db);
    initAllTables(execRaw);
    sql`INSERT INTO agent_identity (id, name, created_at) VALUES (${'old-cli'}, ${'old-cli-agent'}, ${42})`;
    execRaw(`CREATE TABLE agent_soul (purpose TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0)`);
    db.run('INSERT INTO agent_soul (purpose) VALUES (?)', ['Keep the garden watered']);

    const { info } = openAgent(db, { llm: TEST_LLM });
    expect(info.soul).toContain('Keep the garden watered');
    expect(info.purpose).toContain('Keep the garden watered');
    expect(info.name).toBe('old-cli-agent');
  });

  test('empty legacy agent_soul drops the table and reports no soul', () => {
    const { sql, execRaw } = freshDb();
    initAllTables(execRaw);
    execRaw(`CREATE TABLE agent_soul (purpose TEXT NOT NULL)`);

    expect(readSoul(sql)).toBeNull();
    const tables = sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_soul'`;
    expect(tables.length).toBe(0);
  });
});
