// Project-scoped local refs are metadata only: `~/.kinu/<name>/agent.db` stays the one state path, so a
// virtual workspace groups agents and never nests them, and a relabel moves nothing.
import { scratchDir } from '../../test-utils/src/scratch';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCliAgent, renameLocalAgent, type CreatedCliAgent } from '../src/agent-create';
import { resolveAgentTarget } from '../src/agent-target';
import { openWorkspaceCLI } from '@kinu.run/cli-backend';
import {
  AGENT_HOME,
  adoptUnplacedLocalAgent,
  agentDbPath,
  agentDir,
  defaultVirtualWorkspaceId,
  listAgentDirs,
  listLocalRefsAllProjects,
  listUnplacedAgentNames,
  loadConfigFile,
  localWorkspaceMembers,
  readWorkspaceDisplayName,
  readWorkspaceIdentityId,
  resolveLocalAgent,
  updateConfigFile,
  upsertAgentConfig,
  type KinuConfig,
} from '../src/config';

// AGENT_HOME is bound at module load: without scripts/test-preload.ts this would write the developer's home.
if (resolve(AGENT_HOME) === resolve(join(homedir(), '.kinu'))
  || !resolve(AGENT_HOME).startsWith(resolve(tmpdir()))) {
  throw new Error(
    `project-refs suite refuses to run against a real Kinu home (${AGENT_HOME}). `
    + 'Run it from the repo root so scripts/test-preload.ts provides a throwaway KINU_HOME.',
  );
}

const OFFLINE_PROVIDER = {
  baseUrl: 'http://localhost:0/v1',
  auth: 'Bearer project-refs',
  model: 'openai-compatible/project-refs-model',
};

const workspaces: string[] = [];

let configBefore: KinuConfig = {};

let daemonBefore: string | undefined;

beforeAll(() => {
  configBefore = loadConfigFile();
  daemonBefore = process.env.KINU_SKIP_DAEMON;
  process.env.KINU_SKIP_DAEMON = '1';
});

afterEach(async () => {
  for (const name of workspaces.splice(0)) rmSync(agentDir(name), { recursive: true, force: true });
  await updateConfigFile(() => ({}));
});

afterAll(async () => {
  await updateConfigFile(() => configBefore);

  if (daemonBefore === undefined) delete process.env.KINU_SKIP_DAEMON;
  else process.env.KINU_SKIP_DAEMON = daemonBefore;
});

function workspaceLabels(cwd: string): string[] {
  return [...new Set(
    listLocalRefsAllProjects().filter((ref) => ref.cwd === cwd).map((ref) => ref.workspaceId),
  )];
}

function project(): string {
  const dir = join(scratchDir('project'), 'work');
  mkdirSync(dir);

  return realpathSync(dir);
}

async function create(name: string, cwd: string, workspaceId?: string): Promise<CreatedCliAgent> {
  workspaces.push(name);

  return await createCliAgent({
    name,
    mode: 'local',
    purpose: `hold ${name} for the project-refs suite`,
    cwd,
    workspaceId,
    ...OFFLINE_PROVIDER,
  });
}

function unplacedWorkspace(name: string, identityId: string): string {
  mkdirSync(agentDir(name), { recursive: true });
  workspaces.push(name);
  const dbPath = agentDbPath(name);
  const db = new Database(dbPath, { create: true });

  try {
    db.exec('CREATE TABLE workspace_identity (id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL)');
    db.query('INSERT INTO workspace_identity (id, name, created_at) VALUES (?, ?, ?)')
      .run(identityId, name, Date.now());
  } finally {
    db.close();
  }

  return dbPath;
}

function createdDbPath(created: CreatedCliAgent): string {
  if (!created.dbPath) throw new Error(`create reported no database for ${created.name}`);

  return created.dbPath;
}

async function messageOf<T>(run: () => T | Promise<T>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error('expected a refusal, got none');
}

describe('virtual workspaces group agents inside one project', () => {
  test('one directory holds two virtual workspaces, each with its own members', async () => {
    const cwd = project();
    await create('two-ws-api', cwd, 'api');
    await create('two-ws-web', cwd, 'web');

    expect(workspaceLabels(cwd)).toEqual(['api', 'web']);
    expect(localWorkspaceMembers('api', cwd).map((ref) => ref.name)).toEqual(['two-ws-api']);
    expect(localWorkspaceMembers('web', cwd).map((ref) => ref.name)).toEqual(['two-ws-web']);
    expect(listAgentDirs(cwd)).toEqual(['two-ws-api', 'two-ws-web']);
  });

  test('a second create in the same workspace joins it as a peer', async () => {
    const cwd = project();
    const first = await create('peer-one', cwd, 'team');
    const second = await create('peer-two', cwd, 'team');

    expect(first.peers).toEqual([]);
    expect(second.peers).toEqual(['peer-one']);
    expect(localWorkspaceMembers('team', cwd).map((ref) => ref.name)).toEqual(['peer-one', 'peer-two']);

    expect(localWorkspaceMembers('team', cwd).map((ref) => ref.cwd)).toEqual([cwd, cwd]);
    expect(first.dbPath).toBe(join(AGENT_HOME, 'peer-one', 'agent.db'));
    expect(second.dbPath).toBe(join(AGENT_HOME, 'peer-two', 'agent.db'));
  });

  test('a workspace label with no explicit choice comes from the project directory', async () => {
    const cwd = project();
    await create('default-label', cwd);

    expect(workspaceLabels(cwd)).toEqual([defaultVirtualWorkspaceId(cwd)]);
  });
});

describe('the same label in two projects is two workspaces', () => {
  test('members and listings stay inside their own project', async () => {
    const first = project();
    const second = project();
    await create('same-label-a', first, 'app');
    await create('same-label-b', second, 'app');

    expect(workspaceLabels(first)).toEqual(['app']);
    expect(workspaceLabels(second)).toEqual(['app']);
    expect(localWorkspaceMembers('app', first).map((ref) => ref.name)).toEqual(['same-label-a']);
    expect(localWorkspaceMembers('app', second).map((ref) => ref.name)).toEqual(['same-label-b']);
    expect(listAgentDirs(first)).toEqual(['same-label-a']);
    expect(listAgentDirs(second)).toEqual(['same-label-b']);
    expect(listLocalRefsAllProjects().map((ref) => `${ref.cwd}:${ref.workspaceId}:${ref.name}`).sort())
      .toEqual([`${first}:app:same-label-a`, `${second}:app:same-label-b`].sort());
  });

  test('an agent name is machine-wide, so a reused one is refused and names its owner', async () => {
    const first = project();
    const second = project();
    await create('claimed-name', first, 'app');

    let message = '';

    try {
      await create('claimed-name', second, 'app');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('already exists');
    expect(message).toContain('workspace "app"');
    expect(message).toContain(first);
    expect(localWorkspaceMembers('app', first).map((ref) => ref.name)).toEqual(['claimed-name']);
    expect(listAgentDirs(second)).toEqual([]);
  });
});

describe('renaming changes no identity and moves no database', () => {
  test('a new display name leaves the database, the placement and the identity alone', async () => {
    const cwd = project();
    const created = await create('renamed-label', cwd, 'bound');
    const dbPath = createdDbPath(created);
    const identity = readWorkspaceIdentityId(dbPath);

    if (identity === null) throw new Error(`the workspace at ${dbPath} carries no identity`);
    // Recorded on the ref: `resolveLocalAgent` compares later databases against it, so leaving it unset
    // would silently disable the mismatch guard.
    expect(loadConfigFile().agents?.['renamed-label']?.identityId).toBe(identity);

    // The human name lives in the workspace database, never mirrored into config.json.
    renameLocalAgent('renamed-label', 'Second Thoughts');
    expect(loadConfigFile().agents?.['renamed-label']?.displayName).toBeUndefined();

    const resolved = await resolveLocalAgent('renamed-label', { cwd });
    expect(readWorkspaceDisplayName(dbPath)).toBe('Second Thoughts');
    expect(resolved.placement).toBe('recorded');
    expect(resolved.workspaceId).toBe('bound');
    expect(resolved.dbPath).toBe(dbPath);
    expect(readWorkspaceIdentityId(dbPath)).toBe(identity);
    expect(localWorkspaceMembers('bound', cwd).map((ref) => ref.name)).toEqual(['renamed-label']);
  });

  test('a project directory that moved rebinds on the next open instead of vanishing', async () => {
    const from = project();
    const created = await create('moved-project', from, 'bound');
    const dbPath = createdDbPath(created);
    const identity = readWorkspaceIdentityId(dbPath);

    const to = `${from}-moved`;
    renameSync(from, to);

    expect(listAgentDirs(from)).toEqual([]);
    // Membership, not equality: another file in the same process may own unplaced rows.
    expect(listUnplacedAgentNames()).toContain('moved-project');

    const rebound = await resolveLocalAgent('moved-project', { cwd: to, workspaceId: 'bound' });
    expect(rebound.placement).toBe('adopted');
    expect(rebound.cwd).toBe(to);
    expect(rebound.dbPath).toBe(dbPath);
    expect(readWorkspaceIdentityId(dbPath)).toBe(identity);
    expect(listAgentDirs(to)).toEqual(['moved-project']);
  });
});

describe('a backend is stated, not inferred from a file', () => {
  test('a configured cloud ref wins over a local database of the same name', async () => {
    unplacedWorkspace('twin', 'ws-twin');
    await upsertAgentConfig({ name: 'twin', mode: 'cloud', cloudName: 'twin' });

    expect(resolveAgentTarget('twin').mode).toBe('cloud');
    expect(await messageOf(async () => await resolveLocalAgent('twin'))).toContain('this needs a local one');
  });

  test('an unconfigured name addressing both is refused, naming both candidates', async () => {
    const dbPath = unplacedWorkspace('both-ways', 'ws-both');
    await upsertAgentConfig({ name: 'remote-key', mode: 'cloud', cloudName: 'both-ways' });

    const message = await messageOf(() => resolveAgentTarget('both-ways'));
    expect(message).toContain(dbPath);
    expect(message).toContain('"remote-key"');
  });

  test('a backend the caller states cannot contradict the configured ref', async () => {
    await upsertAgentConfig({ name: 'cloud-only', mode: 'cloud' });

    expect(await messageOf(() => resolveAgentTarget('cloud-only', { backend: 'local' })))
      .toContain('cannot be opened as local');
    expect(resolveAgentTarget('cloud-only', { backend: 'cloud' }).mode).toBe('cloud');
  });

  test('a local ref carries the placement its planes bind to', async () => {
    const cwd = project();
    await create('stated-local', cwd, 'bound');

    const target = resolveAgentTarget('stated-local');
    expect(target.mode).toBe('local');
    expect(target.cwd).toBe(cwd);
    expect(target.workspaceId).toBe('bound');
  });

  test('the machine is the workspace: a placed ref opens its shell in the placement, and offers no other machine', async () => {
    const cwd = project();
    const created = await create('placed-shell', cwd);
    const local = await resolveLocalAgent('placed-shell');
    const db = new Database(createdDbPath(created));

    try {
      const { rt } = await openWorkspaceCLI(db, createdDbPath(created), { llm: null, cwd: local.cwd });
      expect(rt.cwd).toBe(cwd);
      expect(rt.executionRouter?.listExecutors().map((e) => e.name)).toEqual(['workspace']);
      const pwd = await rt.shell?.exec('pwd');
      expect(pwd?.stdout.trim()).toBe(cwd);
    } finally {
      db.close();
    }
  });
});

describe('an unplaced workspace is adopted one at a time', () => {
  test('an unplaced workspace belongs to no project until something opens it', async () => {
    const cwd = project();
    unplacedWorkspace('unplaced-one', 'ws-unplaced-one');
    unplacedWorkspace('unplaced-two', 'ws-unplaced-two');

    expect(listAgentDirs(cwd)).toEqual([]);
    expect(listUnplacedAgentNames()).toEqual(expect.arrayContaining(['unplaced-one', 'unplaced-two']));

    const read = await resolveLocalAgent('unplaced-one', { cwd, adopt: false });
    expect(read.placement).toBe('unplaced');
    expect(read.dbPath).toBe(agentDbPath('unplaced-one'));
    expect(listUnplacedAgentNames()).toEqual(expect.arrayContaining(['unplaced-one', 'unplaced-two']));

    const opened = await resolveLocalAgent('unplaced-one', { cwd, workspaceId: 'adopted' });
    expect(opened.placement).toBe('adopted');
    expect(opened.cwd).toBe(cwd);
    expect(opened.workspaceId).toBe('adopted');
    expect(listAgentDirs(cwd)).toEqual(['unplaced-one']);
    expect(listUnplacedAgentNames()).toContain('unplaced-two');
    expect(listUnplacedAgentNames()).not.toContain('unplaced-one');
  });

  test('adoption records the database identity, and re-adoption is a no-op', async () => {
    const cwd = project();
    unplacedWorkspace('keyed', 'ws-keyed');

    await adoptUnplacedLocalAgent('keyed', { cwd, workspaceId: 'first' });
    expect(loadConfigFile().agents?.keyed?.identityId).toBe('ws-keyed');

    const other = project();
    expect((await adoptUnplacedLocalAgent('keyed', { cwd: other, workspaceId: 'second' })).cwd).toBe(cwd);
    expect((await resolveLocalAgent('keyed', { cwd })).placement).toBe('recorded');
    expect(listAgentDirs(other)).toEqual([]);
  });

  test('a name reused for a different database is refused, not silently rebound', async () => {
    const cwd = project();
    unplacedWorkspace('recycled', 'ws-original');
    await adoptUnplacedLocalAgent('recycled', { cwd, workspaceId: 'bound' });

    const db = new Database(agentDbPath('recycled'));

    try {
      db.query('UPDATE workspace_identity SET id = ?').run('ws-replacement');
    } finally {
      db.close();
    }

    const message = await messageOf(async () => await resolveLocalAgent('recycled', { cwd }));
    expect(message).toContain('ws-original');
    expect(message).toContain('ws-replacement');
  });

  test('adopting a name with no database is refused', async () => {
    expect(await messageOf(async () => await adoptUnplacedLocalAgent('never-existed'))).toContain('not found at');
  });
});

describe('the project directory holds no state', () => {
  test('creating and opening an agent writes nothing under the project', async () => {
    const cwd = project();
    const created = await create('no-litter', cwd, 'solo');
    await resolveLocalAgent('no-litter', { cwd });

    expect(readdirSync(cwd)).toEqual([]);
    expect(createdDbPath(created)).toBe(join(AGENT_HOME, 'no-litter', 'agent.db'));
  });

  test('adopting an unplaced workspace writes nothing under the project', async () => {
    const cwd = project();
    unplacedWorkspace('no-litter-unplaced', 'ws-no-litter');
    await adoptUnplacedLocalAgent('no-litter-unplaced', { cwd, workspaceId: 'solo' });

    expect(readdirSync(cwd)).toEqual([]);
  });
});
