import { readText } from '@nimbus-sh/core/vfs/vfs.js';
/** One authority: SOUL.md's bytes. Its mission is read off them, so no copy can drift. */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  readSoul, readMission, seedSoul, summarizeSoul, SOUL_PATH, ownerMissionOf,
} from '../src/identity/soul';
import { initAllTables } from '../src/state/workspace-schema';
import { createWorkspace } from '../src/workspace-birth';
import { bootstrapScaffold } from '../src/scaffold/bootstrap';
import { getCurrentScaffoldVersion, readScaffoldVersion } from '../src/scaffold/versions';
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
  test('the owner\'s write round-trips through the workspace filesystem', async () => {
    const { vfs, seal } = freshWorkspace();
    await seal('# Atlas\n\n## Mission\n\nHelp with testing.');

    expect(await readSoul(vfs)).toBe('# Atlas\n\n## Mission\n\nHelp with testing.');
    expect(await readText(vfs, SOUL_PATH)).toContain('Help with testing.');
  });

  test('an unborn workspace reads as no soul rather than throwing', async () => {
    const db = new Database(':memory:');
    initAllTables(makeExecRaw(db), makeSql(db));
    expect(await readSoul(createWorkspaceBundle(db).vfs)).toBeNull();
  });

  test('an empty document is no document', async () => {
    const { vfs, seal } = freshWorkspace();
    await seal('   \n  ');
    expect(await readSoul(vfs)).toBeNull();
  });


});

describe('the mission a read-only listing reads', () => {
  // A copy written after the soul could fail between the two writes and leave listings on the old purpose.
  test('it is read off the soul the owner wrote last, with no copy to drift', async () => {
    const { sql, vfs, seal } = freshWorkspace();
    await seal('# Atlas\n\n## Mission\n\nHelp with testing.');
    await seal('# Atlas\n\n## Mission\n\nShip the release.');

    expect(readMission(sql)).toBe('Ship the release.');
    expect(readMission(sql)).toBe(summarizeSoul(await readSoul(vfs)));
  });

  test('it is readable without opening a filesystem — the point of it existing', async () => {
    const { db, seal } = freshWorkspace();
    await seedSoul({ name: 'atlas', mission: 'ship the thing' }, seal);

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

    expect(await readText(rt.storage.vfs, 'scaffold/agent.js')).toContain('async');
    expect(await readText(rt.storage.vfs, 'memory/MEMORY.md')).toContain('Atlas');
  });

  test('a custom first loop is born as v0 through the one writer: source, pointer and live view agree, and a reopen keeps them', async () => {
    const custom = 'async function* run(rt, task) { yield { type: "chunk", data: "custom" }; }';
    const rt = await createWorkspace(new Database(':memory:'), { name: 'atlas', purpose: 'Help.', llm: TEST_LLM, scaffold: custom });

    const agree = async () => ({
      pointer: getCurrentScaffoldVersion(rt.storage.sql, rt.actor),
      source: await readScaffoldVersion(rt, 0),
      live: await rt.identity.scaffold.read(),
    });

    expect(await agree()).toEqual({ pointer: 0, source: custom, live: custom });
    await bootstrapScaffold(rt);
    expect(await agree()).toEqual({ pointer: 0, source: custom, live: custom });
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
    expect(await readText(untitled.storage.vfs, 'memory/MEMORY.md'))
      .not.toContain('quiet-harbor-1a4e20');
  });
});

test('the mission is the one a late heading declares, not a truncated prefix', () => {
  const soul = `# Atlas\n\n${'filler line\n'.repeat(8 * 1024)}\n## Mission\n\nHelp late in the file.\n`;
  expect(summarizeSoul(soul)).toBe('Help late in the file.');
});
