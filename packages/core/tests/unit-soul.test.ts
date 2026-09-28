/** SOUL.md and its mission row cannot drift: `writeSoul` is the only writer of either. */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  readSoul, readMission, writeSoul, seedSoul, summarizeSoul, SOUL_PATH, ownerMissionOf,
} from '../src/identity/soul';
import { initAllTables } from '../src/state/workspace-schema';
import { createWorkspace } from '../src/workspace-birth';
import { makeSql, makeExecRaw, createWorkspaceBundle } from './helpers';
import { writeWorkspaceSoul } from '../src/vfs/workspace-planes';

const TEST_LLM = { name: 'test', baseURL: 'http://localhost:0', headers: {}, model: 'test-model' };

function freshWorkspace() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  initAllTables(makeExecRaw(db), makeSql(db));
  void sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'W'}, ${'atlas'}, ${100})`;

  const bundle = createWorkspaceBundle(db);

  return { db, sql, vfs: bundle.vfs, seal: (content: string) => writeWorkspaceSoul(bundle, content) };
}

describe('the soul is a file', () => {
  test('writeSoul round-trips through the workspace filesystem', async () => {
    const { sql, vfs, seal } = freshWorkspace();
    await writeSoul(sql, '# Atlas\n\n## Mission\n\nHelp with testing.', seal);

    expect(await readSoul(vfs)).toBe('# Atlas\n\n## Mission\n\nHelp with testing.');
    expect(await vfs.readFile(SOUL_PATH, { encoding: 'utf8' })).toContain('Help with testing.');
  });

  test('an unborn workspace reads as no soul rather than throwing', async () => {
    const db = new Database(':memory:');
    initAllTables(makeExecRaw(db), makeSql(db));
    expect(await readSoul(createWorkspaceBundle(db).vfs)).toBeNull();
  });

  test('an empty document is no document', async () => {
    const { sql, vfs, seal } = freshWorkspace();
    await writeSoul(sql, '   \n  ', seal);
    expect(await readSoul(vfs)).toBeNull();
  });


});

describe('the mission a read-only listing reads', () => {
  test('writeSoul maintains it, so the row cannot drift from the document', async () => {
    const { sql, vfs, seal } = freshWorkspace();
    await writeSoul(sql, '# Atlas\n\n## Mission\n\nHelp with testing.', seal);

    expect(readMission(sql)).toBe('Help with testing.');
    expect(readMission(sql)).toBe(summarizeSoul(await readSoul(vfs)));
  });

  test('it is readable without opening a filesystem — the point of it existing', async () => {
    const { db, sql, seal } = freshWorkspace();
    await seedSoul(sql, { name: 'atlas', mission: 'ship the thing' }, seal);

    // A handle with no workspace filesystem, as `kinu list` has, so a listing never writes.
    const listing = makeSql(db);
    expect(readMission(listing)).toBe('ship the thing');
  });

  test('a workspace whose soul was never written reports no mission', () => {
    const { sql } = freshWorkspace();
    expect(readMission(sql)).toBeNull();
  });

  test('a soul that says nothing a summary keeps is no mission, so a caller can fall back', () => {
    for (const soul of ['# Atlas\n', '  \n\n']) {
      expect(ownerMissionOf({ soulTable: true, soul, identity: null })).toBeNull();
    }

    expect(ownerMissionOf({ soulTable: true, soul: '# Atlas\n\n## Mission\n\nShip it.', identity: null })).toBe('Ship it.');
  });
});

describe('workspace birth', () => {
  test('createWorkspace seeds a readable soul and a matching mission', async () => {
    const db = new Database(':memory:');

    const rt = await createWorkspace(db, {
      name: 'atlas', purpose: 'Help with testing.', llm: TEST_LLM,
    });

    const identity = makeSql(db)<{ name: string }>`SELECT name FROM workspace_identity LIMIT 1`[0];
    expect(identity?.name).toBe('atlas');
    expect(await readSoul(rt.storage.vfs)).toContain('Help with testing.');
    expect(readMission(makeSql(db))).toBe('Help with testing.');
  });

  test('the seeds are real files the agent can read back', async () => {
    const db = new Database(':memory:');

    const rt = await createWorkspace(db, {
      name: 'quiet-harbor-1a4e20', title: 'Atlas', purpose: 'Help with testing.', llm: TEST_LLM,
    });

    expect(await rt.storage.vfs.readFile('scaffold/agent.js', { encoding: 'utf8' })).toContain('async');
    expect(await rt.storage.vfs.readFile('memory/MEMORY.md', { encoding: 'utf8' })).toContain('Atlas');
  });

  /** `name` is the address and `title` is the name; a workspace is born untitled. */
  test('the documents a model reads are headed by the title, never by the slug', async () => {
    const titled = await createWorkspace(new Database(':memory:'), {
      name: 'quiet-harbor-1a4e20', title: 'Callback Audit', purpose: 'Audit it.', llm: TEST_LLM,
    });

    expect(await readSoul(titled.storage.vfs)).toStartWith('# Callback Audit');

    const untitled = await createWorkspace(new Database(':memory:'), {
      name: 'quiet-harbor-1a4e20', purpose: 'Audit it.', llm: TEST_LLM,
    });

    const soul = await readSoul(untitled.storage.vfs) ?? '';
    expect(soul).toStartWith('# Kinu');
    expect(soul).not.toContain('quiet-harbor-1a4e20');
    expect(await untitled.storage.vfs.readFile('memory/MEMORY.md', { encoding: 'utf8' }))
      .not.toContain('quiet-harbor-1a4e20');
  });
});

test('the mission is the one a late heading declares, not a truncated prefix', () => {
  const soul = `# Atlas\n\n${'filler line\n'.repeat(8 * 1024)}\n## Mission\n\nHelp late in the file.\n`;
  expect(summarizeSoul(soul)).toBe('Help late in the file.');
});
