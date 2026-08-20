/**
 * SOUL.md — a file in the workspace filesystem, and the mission row a
 * read-only listing reads instead.
 *
 * The property that matters is that those two cannot drift: `writeSoul` is the
 * only writer of either, so a listing showing a stale mission would mean a
 * second write path existed. The old suite here tested a storage encoding
 * (BLOB-vs-TEXT rows in `vfs_files`) that no longer exists — the document is a
 * file now, and how the filesystem stores it is the filesystem's business.
 */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  readSoul, readMission, writeSoul, seedSoul, summarizeSoul, SOUL_PATH,
} from '../src/identity/soul';
import { initAllTables } from '../src/identity/schema';
import { createWorkspace } from '../src/identity/create';
import { openWorkspace } from '../src/identity/open';
import { makeSql, makeExecRaw, createWorkspaceBundle, makeAgentDatabase } from './helpers';

const TEST_LLM = { name: 'test', baseURL: 'http://localhost:0', headers: {}, model: 'test-model' };

function freshWorkspace() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  initAllTables(makeExecRaw(db), makeSql(db));
  void sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'W'}, ${'atlas'}, ${100})`;
  return { db, sql, vfs: createWorkspaceBundle(db).vfs };
}

describe('the soul is a file', () => {
  test('writeSoul round-trips through the workspace filesystem', async () => {
    const { sql, vfs } = freshWorkspace();
    await writeSoul(vfs, sql, '# Atlas\n\n## Mission\n\nHelp with testing.');

    expect(await readSoul(vfs)).toBe('# Atlas\n\n## Mission\n\nHelp with testing.');
    // Reachable by the ordinary path, so `file`, workspace.readFile and grep
    // all address the same document.
    expect(await vfs.readFile(SOUL_PATH, { encoding: 'utf8' })).toContain('Help with testing.');
  });

  test('a workspace with no soul reads as null rather than throwing', async () => {
    const { vfs } = freshWorkspace();
    expect(await readSoul(vfs)).toBeNull();
  });

  test('an empty document is no document', async () => {
    const { sql, vfs } = freshWorkspace();
    await writeSoul(vfs, sql, '   \n  ');
    expect(await readSoul(vfs)).toBeNull();
  });

  test('a host-owned writer can protect the file without duplicating mission updates', async () => {
    const { sql, vfs } = freshWorkspace();
    const writes: Array<{ path: string; content: string }> = [];
    const content = '# Atlas\n\n## Mission\n\nsecond mission';

    await writeSoul(vfs, sql, content, async (path, markdown) => {
      writes.push({ path, content: markdown });
      await vfs.writeFile(path, markdown);
    });

    expect(writes).toEqual([{ path: SOUL_PATH, content }]);
    expect(await readSoul(vfs)).toBe(content);
    expect(readMission(sql)).toBe('second mission');
  });
});

describe('the mission a read-only listing reads', () => {
  test('writeSoul maintains it, so the row cannot drift from the document', async () => {
    const { sql, vfs } = freshWorkspace();
    await writeSoul(vfs, sql, '# Atlas\n\n## Mission\n\nHelp with testing.');

    expect(readMission(sql)).toBe('Help with testing.');
    expect(readMission(sql)).toBe(summarizeSoul(await readSoul(vfs)));
  });

  test('it is readable without opening a filesystem — the point of it existing', async () => {
    const { db, sql, vfs } = freshWorkspace();
    await seedSoul(vfs, sql, { name: 'atlas', mission: 'ship the thing' });

    // A second handle that never builds a workspace filesystem: exactly what
    // `kinu list` has, and what stops a listing from writing to every
    // workspace it walks past.
    const listing = makeSql(db);
    expect(readMission(listing)).toBe('ship the thing');
  });

  test('a workspace whose soul was never written reports no mission', () => {
    const { sql } = freshWorkspace();
    expect(readMission(sql)).toBeNull();
  });
});

describe('workspace birth and open', () => {
  test('createWorkspace seeds a readable soul and a matching mission', async () => {
    const db = new Database(':memory:');
    const agentDb = makeAgentDatabase(db);
    await createWorkspace(agentDb, {
      name: 'atlas', purpose: 'Help with testing.', llm: TEST_LLM,
    });

    const { info } = await openWorkspace(agentDb, { llm: TEST_LLM });
    expect(info.name).toBe('atlas');
    expect(info.purpose).toBe('Help with testing.');
    expect(info.soul).toContain('Help with testing.');
    expect(readMission(makeSql(db))).toBe('Help with testing.');
  });

  test('the seeds are real files the agent can read back', async () => {
    const db = new Database(':memory:');
    const rt = await createWorkspace(makeAgentDatabase(db), {
      name: 'atlas', purpose: 'Help with testing.', llm: TEST_LLM,
    });

    expect(await rt.storage.vfs.readFile('scaffold/agent.js', { encoding: 'utf8' })).toContain('async');
    expect(await rt.storage.vfs.readFile('memory/MEMORY.md', { encoding: 'utf8' })).toContain('atlas');
  });
});
