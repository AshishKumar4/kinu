// Project-scoped local refs: which project an agent belongs to, which virtual
// workspace groups it with its peers, and which database it opens.
//
// The policy under test is metadata-only. `~/.kinu/<name>/agent.db` is still the
// one state path, so a virtual workspace GROUPS agents and never nests them, and
// a relabel moves nothing. These assertions exist because the two ways to get
// this wrong are both silent: attributing every legacy workspace to whichever
// directory the CLI started in, and inferring a backend from a file's existence.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCliAgent, renameLocalAgent, type CreatedCliAgent } from '../src/agent-create';
import { resolveAgentTarget } from '../src/agent-target';
import {
  AGENT_HOME,
  adoptLegacyLocalAgent,
  agentDbPath,
  agentDir,
  defaultVirtualWorkspaceId,
  listAgentDirs,
  listLegacyAgentNames,
  listLocalRefsAllProjects,
  loadConfigFile,
  localWorkspaceMembers,
  readWorkspaceDisplayName,
  readWorkspaceIdentityId,
  resolveLocalAgent,
  updateConfigFile,
  upsertAgentConfig,
  type KinuConfig,
} from '../src/config';

// Same boundary assertion as the conformance suite: AGENT_HOME is bound at
// module load, so a hand-run without scripts/test-preload.ts would create real
// workspaces and real `agents` entries in the developer's own home.
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

const projects: string[] = [];
const workspaces: string[] = [];
let configBefore: KinuConfig = {};
let daemonBefore: string | undefined;

beforeAll(() => {
  configBefore = loadConfigFile();
  daemonBefore = process.env.KINU_SKIP_DAEMON;
  process.env.KINU_SKIP_DAEMON = '1';
});

afterEach(() => {
  for (const name of workspaces.splice(0)) rmSync(agentDir(name), { recursive: true, force: true });
  updateConfigFile(() => ({}));
});

afterAll(() => {
  for (const dir of projects.splice(0)) rmSync(dir, { recursive: true, force: true });
  updateConfigFile(() => configBefore);
  if (daemonBefore === undefined) delete process.env.KINU_SKIP_DAEMON;
  else process.env.KINU_SKIP_DAEMON = daemonBefore;
});

/** The virtual workspaces a project holds, in listing order. Read off the
 *  machine-wide roster the scheduler iterates, filtered to one project — the
 *  attribution under test is the ref's recorded `cwd` and nothing else. */
function workspaceLabels(cwd: string): string[] {
  return [...new Set(
    listLocalRefsAllProjects().filter((ref) => ref.cwd === cwd).map((ref) => ref.workspaceId),
  )];
}

/** A throwaway physical project directory, canonical so comparisons hold. */
function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kinu-project-')));
  projects.push(dir);
  return dir;
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

/** A workspace as it existed before placement was recorded: a database under
 *  `~/.kinu/<name>` and no ref naming a project. */
function legacyWorkspace(name: string, identityId: string): string {
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

/** A local create always reports its database; a cloud one has none. */
function createdDbPath(created: CreatedCliAgent): string {
  if (!created.dbPath) throw new Error(`create reported no database for ${created.name}`);
  return created.dbPath;
}

/** The refusal `run` produces. A call that does not refuse is the failure. */
function messageOf(run: () => void): string {
  try {
    run();
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

    // `peers` reports who was already there, so opening a workspace and joining
    // one are distinguishable at the call site.
    expect(first.peers).toEqual([]);
    expect(second.peers).toEqual(['peer-one']);
    expect(localWorkspaceMembers('team', cwd).map((ref) => ref.name)).toEqual(['peer-one', 'peer-two']);

    // One physical plane, private state each: the shared cwd is the point of a
    // virtual workspace, and the separate databases are the point of a peer.
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
    // Both are still reachable machine-wide, which is what a scheduler that is
    // not scoped to its launch directory has to iterate.
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
    // The refusal changed nothing: the original placement still stands.
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
    // Creation records it on the ref too, keyed on the database rather than on
    // the name — that recorded value is the only thing `resolveLocalAgent` can
    // compare a later database against, so a create that left it unset would
    // turn the mismatch guard off and say nothing.
    expect(loadConfigFile().agents?.['renamed-label']?.identityId).toBe(identity);

    // The rename a user actually performs: the workspace's human name,
    // written into the workspace's own database — never mirrored into
    // config.json. `kinu create` writes it and auto-titling rewrites it
    // after the first turn.
    renameLocalAgent('renamed-label', 'Second Thoughts');
    expect(loadConfigFile().agents?.['renamed-label']?.displayName).toBeUndefined();

    const resolved = resolveLocalAgent('renamed-label', { cwd });
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
    projects.push(to);

    // The recorded directory is gone, so the ref places nothing and the agent
    // reads as unplaced — visible, rather than missing from every roster.
    expect(listAgentDirs(from)).toEqual([]);
    expect(listLegacyAgentNames()).toEqual(['moved-project']);

    const rebound = resolveLocalAgent('moved-project', { cwd: to, workspaceId: 'bound' });
    expect(rebound.placement).toBe('adopted');
    expect(rebound.cwd).toBe(to);
    expect(rebound.dbPath).toBe(dbPath);
    expect(readWorkspaceIdentityId(dbPath)).toBe(identity);
    expect(listAgentDirs(to)).toEqual(['moved-project']);
  });
});

describe('a backend is stated, not inferred from a file', () => {
  test('a configured cloud ref wins over a local database of the same name', () => {
    legacyWorkspace('twin', 'ws-twin');
    upsertAgentConfig({ name: 'twin', mode: 'cloud', cloudName: 'twin' });

    expect(resolveAgentTarget('twin').mode).toBe('cloud');
    expect(messageOf(() => resolveLocalAgent('twin'))).toContain('has no local database');
  });

  test('an unconfigured name addressing both is refused, naming both candidates', () => {
    const dbPath = legacyWorkspace('both-ways', 'ws-both');
    upsertAgentConfig({ name: 'remote-key', mode: 'cloud', cloudName: 'both-ways' });

    const message = messageOf(() => resolveAgentTarget('both-ways'));
    expect(message).toContain(dbPath);
    expect(message).toContain('"remote-key"');
  });

  test('a backend the caller states cannot contradict the configured ref', () => {
    upsertAgentConfig({ name: 'cloud-only', mode: 'cloud' });

    expect(messageOf(() => resolveAgentTarget('cloud-only', { backend: 'local' })))
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
});

describe('a legacy workspace is adopted one at a time', () => {
  test('an unplaced workspace belongs to no project until something opens it', () => {
    const cwd = project();
    legacyWorkspace('legacy-one', 'ws-legacy-one');
    legacyWorkspace('legacy-two', 'ws-legacy-two');

    // The deleted behaviour: an empty project used to report every workspace on
    // the machine as its own.
    expect(listAgentDirs(cwd)).toEqual([]);
    expect(listLegacyAgentNames()).toEqual(['legacy-one', 'legacy-two']);

    // A read states the placement it would use without recording it.
    const read = resolveLocalAgent('legacy-one', { cwd, adopt: false });
    expect(read.placement).toBe('unplaced');
    expect(read.dbPath).toBe(agentDbPath('legacy-one'));
    expect(listLegacyAgentNames()).toEqual(['legacy-one', 'legacy-two']);

    // An open adopts exactly the one it opened.
    const opened = resolveLocalAgent('legacy-one', { cwd, workspaceId: 'adopted' });
    expect(opened.placement).toBe('adopted');
    expect(opened.cwd).toBe(cwd);
    expect(opened.workspaceId).toBe('adopted');
    expect(listAgentDirs(cwd)).toEqual(['legacy-one']);
    expect(listLegacyAgentNames()).toEqual(['legacy-two']);
  });

  test('adoption records the database identity, and re-adoption is a no-op', () => {
    const cwd = project();
    legacyWorkspace('keyed', 'ws-keyed');

    adoptLegacyLocalAgent('keyed', { cwd, workspaceId: 'first' });
    expect(loadConfigFile().agents?.keyed?.identityId).toBe('ws-keyed');

    // Already placed: adopting again does not re-point it at another project.
    const other = project();
    expect(adoptLegacyLocalAgent('keyed', { cwd: other, workspaceId: 'second' }).cwd).toBe(cwd);
    expect(resolveLocalAgent('keyed', { cwd }).placement).toBe('recorded');
    expect(listAgentDirs(other)).toEqual([]);
  });

  test('a name reused for a different database is refused, not silently rebound', () => {
    const cwd = project();
    legacyWorkspace('recycled', 'ws-original');
    adoptLegacyLocalAgent('recycled', { cwd, workspaceId: 'bound' });

    const db = new Database(agentDbPath('recycled'));
    try {
      db.query('UPDATE workspace_identity SET id = ?').run('ws-replacement');
    } finally {
      db.close();
    }

    const message = messageOf(() => resolveLocalAgent('recycled', { cwd }));
    expect(message).toContain('ws-original');
    expect(message).toContain('ws-replacement');
  });

  test('adopting a name with no database is refused', () => {
    expect(messageOf(() => adoptLegacyLocalAgent('never-existed'))).toContain('nothing to adopt');
  });
});

describe('the project directory holds no state', () => {
  test('creating and opening an agent writes nothing under the project', async () => {
    const cwd = project();
    const created = await create('no-litter', cwd, 'solo');
    resolveLocalAgent('no-litter', { cwd });

    expect(readdirSync(cwd)).toEqual([]);
    expect(createdDbPath(created)).toBe(join(AGENT_HOME, 'no-litter', 'agent.db'));
  });

  test('adopting a legacy workspace writes nothing under the project', () => {
    const cwd = project();
    legacyWorkspace('no-litter-legacy', 'ws-no-litter');
    adoptLegacyLocalAgent('no-litter-legacy', { cwd, workspaceId: 'solo' });

    expect(readdirSync(cwd)).toEqual([]);
  });
});
