import { readText } from '@nimbus-sh/core/vfs/vfs.js';
/** One authority: SOUL.md's bytes. Its mission is read off them, so no copy can drift. */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  readSoul, summarizeSoul, SOUL_FILE, SOUL_PATH, missionOf,
} from '../src/identity/soul';
import { agentCred, agentHome, agentTmpRoot, confineAgentTmp, provisionAgentHome } from '../src/vfs/agent-home';
import { initAllTables } from '../src/state/workspace-schema';
import { createWorkspace } from '../src/workspace-birth';
import { bootstrapScaffold } from '../src/scaffold/bootstrap';
import { getCurrentScaffoldVersion, readScaffoldVersion } from '../src/scaffold/versions';
import { makeSql, makeExecRaw, createWorkspaceBundle } from './helpers';
import { createMemoryVfs } from '@kinu.run/test-utils';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { workspaceSoul, writeWorkspaceSoul } from '../src/vfs/workspace-planes';

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

  // The owner's write runs as uid 0: through a link an agent left at SOUL.md it would overwrite the file the link names.
  test('an owner write replaces a link at SOUL.md with the file, and never writes through it', async () => {
    const db = new Database(':memory:');
    initAllTables(makeExecRaw(db), makeSql(db));
    const bundle = createWorkspaceBundle(db);
    await writeWorkspaceSoul(bundle, '# Atlas\n');
    const { root } = await bundle.privileged();
    const cred = { uid: 2_001, gid: 2_001 };
    const home = provisionAgentHome(root, 'agent-a', cred);
    const kernel = (await bundle.session()).vfs.as(CRED_KERNEL);
    kernel.writeFile(`${home}/private.md`, 'agent-a only');
    kernel.unlink(SOUL_FILE);
    kernel.symlink(`${home}/private.md`, SOUL_FILE);

    await writeWorkspaceSoul(bundle, '# Owner\n');

    expect(new TextDecoder().decode(kernel.readFile(`${home}/private.md`))).toBe('agent-a only');
    expect(kernel.lstat(SOUL_FILE)).toMatchObject({ type: 'file', mode: expect.any(Number) });
    expect(await workspaceSoul(bundle)).toBe('# Owner\n');
  });

  // The owner set it at birth; any agent of the workspace edits it after, from its shell or its file tool alike.
  test('an agent with its own uid edits SOUL.md, and what it wrote is the soul the next turn reads', async () => {
    const db = new Database(':memory:');
    initAllTables(makeExecRaw(db), makeSql(db));
    const bundle = createWorkspaceBundle(db);
    await writeWorkspaceSoul(bundle, '# Atlas\n\n## Mission\n\nHelp with testing.');
    const { root, confiner } = await bundle.privileged();
    const cred = { uid: 2_001, gid: 2_001 };
    provisionAgentHome(root, 'agent-a', cred);
    confineAgentTmp(confiner, 'agent-a', cred);
    const agent = await bundle.asAgent({ cred: agentCred(cred), home: agentHome('agent-a'), tmp: agentTmpRoot('agent-a') });

    const edit = await agent.shell.exec(`printf '# Atlas\\n\\n## Mission\\n\\nShip the release.\\n' > ${SOUL_FILE}`);

    expect([edit.exitCode, edit.stderr]).toEqual([0, '']);
    expect(missionOf(await workspaceSoul(bundle))).toBe('Ship the release.');
  });
});

describe('the mission', () => {
  test('a soul that says nothing a summary keeps is no mission, so a caller can fall back', () => {
    for (const soul of ['# Atlas\n', '  \n\n']) {
      expect(missionOf(soul)).toBeNull();
    }

    expect(missionOf('# Atlas\n\n## Mission\n\nShip it.')).toBe('Ship it.');
  });
});

/** Main's home for a test's birth: the files a real one writes into its space. */
function bornSoul() {
  const { vfs } = createMemoryVfs();

  return { home: vfs, soul: async () => readText(vfs, SOUL_PATH) };
}

describe('workspace birth', () => {
  test('createWorkspace seeds a readable soul and a matching mission', async () => {
    const db = new Database(':memory:');
    const born = bornSoul();

    await createWorkspace(db, {
      name: 'atlas', purpose: 'Help with testing.', llm: TEST_LLM, home: born.home,
    });

    const identity = makeSql(db)<{ name: string }>`SELECT name FROM workspace_identity LIMIT 1`[0];
    expect(identity?.name).toBe('atlas');
    expect(await born.soul()).toContain('Help with testing.');
    expect(missionOf(await born.soul())).toBe('Help with testing.');
  });

  test('the seeds are real files the agent can read back', async () => {
    const db = new Database(':memory:');

    const rt = await createWorkspace(db, {
      name: 'quiet-harbor-1a4e20', title: 'Atlas', purpose: 'Help with testing.', llm: TEST_LLM, home: bornSoul().home,
    });

    expect((await rt.storage.vfs.stat('scaffold/agent.js'))?.type).toBe('file');
    expect(await readText(rt.storage.vfs, 'memory/MEMORY.md')).toContain('Atlas');
  });

  test('a custom first loop is born as v0 through the one writer: source, pointer and live view agree, and a reopen keeps them', async () => {
    const custom = 'async function* run(rt, task) { yield { type: "chunk", data: "custom" }; }';
    const rt = await createWorkspace(new Database(':memory:'), { name: 'atlas', purpose: 'Help.', llm: TEST_LLM, scaffold: custom, home: bornSoul().home });

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
    const titledSoul = bornSoul();

    await createWorkspace(new Database(':memory:'), {
      name: 'quiet-harbor-1a4e20', title: 'Callback Audit', purpose: 'Audit it.', llm: TEST_LLM, home: titledSoul.home,
    });

    expect(await titledSoul.soul()).toContain('Callback Audit');
    const untitledSoul = bornSoul();

    const untitled = await createWorkspace(new Database(':memory:'), {
      name: 'quiet-harbor-1a4e20', purpose: 'Audit it.', llm: TEST_LLM, home: untitledSoul.home,
    });

    const soul = await untitledSoul.soul() ?? '';
    expect(soul).not.toContain('quiet-harbor-1a4e20');
    expect(await readText(untitled.storage.vfs, 'memory/MEMORY.md'))
      .not.toContain('quiet-harbor-1a4e20');
  });
});

test('the mission is the one a late heading declares, not a truncated prefix', () => {
  const soul = `# Atlas\n\n${'filler line\n'.repeat(8 * 1024)}\n## Mission\n\nHelp late in the file.\n`;
  expect(summarizeSoul(soul)).toBe('Help late in the file.');
});
