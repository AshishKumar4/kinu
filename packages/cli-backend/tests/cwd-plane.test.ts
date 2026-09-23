/** Workspace plane bound to a physical directory: peers share canonical files on disk while identity stays in each agent's database. */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { AgentRuntime, LLMProviderConfig, WriteEvent, WriteObserver } from '@kinu.run/core';
import { buildBuiltinTools, initWorkspaceSchema, isVfsError, WORKSPACE_ROOT, subordinateAgentName } from '@kinu.run/core';
import { createWorkspace } from '@kinu.run/core/identity';
import { scratchDir, toolExecute } from '@kinu.run/test-utils';
import {
  createCLIRuntime, makeWorkspaceSchemaSql, shareLocalWorkspacePlane,
  type CLIRuntime,
} from '../src/runtime';
import { createHeadRuntime } from './actor-fixture';
import { registerLocalActor } from '../src/actor-identity';
import { openWorkspaceCLI } from '../src/open';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

function roots(label: string) {
  const root = scratchDir(label);
  const state = join(root, 'state');
  const project = join(root, 'project');
  mkdirSync(state, { recursive: true });
  mkdirSync(project, { recursive: true });

  return { state, project };
}

type LocalAgent = CLIRuntime & { readonly db: Database; readonly dbPath: string };

function agentRuntime(state: string, name: string, cwd?: string): LocalAgent {
  const dbPath = join(state, name, 'agent.db');
  mkdirSync(dirname(dbPath), { recursive: true });

  const config: Parameters<typeof createCLIRuntime>[1] = {
    dbPath, llm: DUMMY_LLM, agentName: name,
  };

  if (cwd !== undefined) config.cwd = cwd;
  const db = new Database(dbPath);

  return Object.assign(createCLIRuntime(db, config), { db, dbPath });
}

/** Opened the way the CLI opens one: the only path through openWorkspaceCLI's plane choices. */
async function openedWorkspace(state: string, name: string, cwd: string) {
  const dbPath = join(state, name, 'agent.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  await createWorkspace(db, { name, purpose: `Test agent ${name}`, llm: DUMMY_LLM });
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));

  return openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM, cwd });
}

async function readText(rt: AgentRuntime, path: string): Promise<string> {
  const raw = await rt.storage.vfs.readFile(path, { encoding: 'utf8' });

  return raw instanceof Uint8Array ? new TextDecoder().decode(raw) : raw;
}

async function refusalOf<T>(op: () => Promise<T>): Promise<string> {
  let caught: unknown;

  try { await op(); } catch (error) { caught = error; }

  if (!isVfsError(caught)) throw new Error(`expected a classified refusal, got ${String(caught)}`);

  return caught.code;
}

describe('peers over one directory', () => {
  test('two runtimes bound to the same directory read each other\'s bytes', async () => {
    const { state, project } = roots('cwd-plane-peers');
    const first = agentRuntime(state, 'first', project);
    const second = agentRuntime(state, 'second', project);

    await first.storage.vfs.writeFile('shared.txt', 'written by first');

    expect(await readText(second, 'shared.txt')).toBe('written by first');
    expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('written by first');

    await second.storage.vfs.writeFile('src/deep/file.ts', 'export const x = 1;\n');
    expect(await readText(first, 'src/deep/file.ts')).toBe('export const x = 1;\n');
  });

  test('a file the user created is already there for both of them', async () => {
    const { state, project } = roots('cwd-plane-existing');
    writeFileSync(join(project, 'AGENTS.md'), '# House rules\n');
    const first = agentRuntime(state, 'first', project);
    const second = agentRuntime(state, 'second', project);

    expect(await readText(first, 'AGENTS.md')).toBe('# House rules\n');
    expect(await readText(second, 'AGENTS.md')).toBe('# House rules\n');
    expect(await first.storage.vfs.readdir('.')).toContain('AGENTS.md');
  });

  test('identity, scaffold and memory stay private to each peer', async () => {
    const { state, project } = roots('cwd-plane-private');
    const first = agentRuntime(state, 'first', project);
    const second = agentRuntime(state, 'second', project);

    await first.identity.scaffold.write('// first\n');
    await second.identity.scaffold.write('// second\n');
    await first.memory.write('memory/notes.md', 'what first learned');

    expect(await first.identity.scaffold.read()).toBe('// first\n');
    expect(await second.identity.scaffold.read()).toBe('// second\n');
    expect(first.identity.id).not.toBe(second.identity.id);

    const secondState = second.agentStateVfs;

    if (!secondState) throw new Error('a bound runtime must expose its own state plane');
    expect(await secondState.exists('memory/notes.md')).toBe(false);

    expect(readdirSync(project)).toEqual([]);
  });

  test('a subordinate writes into the shared directory and keeps its own actor-scoped stores', async () => {
    const { state, project } = roots('cwd-plane-subordinate');
    const parent = agentRuntime(state, 'parent', project);
    const binding = registerLocalActor(parent.actor, { name: 'child', creationId: 'child-birth', kind: 'subordinate', lifetime: 'durable' });
    const physicalName = subordinateAgentName(binding.storageKey);

    const child = await shareLocalWorkspacePlane(
      createCLIRuntime(parent.db, { dbPath: parent.dbPath, llm: null, cwd: project, facet: physicalName, actorBinding: binding }),
      parent, physicalName,
    );

    await child.storage.vfs.writeFile('from-child.txt', 'child was here');
    expect(readFileSync(join(project, 'from-child.txt'), 'utf8')).toBe('child was here');
    expect(await readText(parent, 'from-child.txt')).toBe('child was here');

    expect(child.cwd).toBe(resolve(project));
    expect(child.checkpoints).toBe(parent.checkpoints);
    expect(child.actor.actorId).not.toBe(parent.actor.actorId);
    expect(existsSync(join(state, 'child'))).toBe(false);
  });
});

describe('a fork over the bound directory', () => {
  test('a head works in the parent\'s directory and keeps its own state', async () => {
    const { state, project } = roots('cwd-plane-head');
    writeFileSync(join(project, 'task.txt'), 'the task input');
    const parent = agentRuntime(state, 'parent', project);
    const written: WriteEvent[] = [];

    const observer: WriteObserver = {
      needsBaseline: () => true,
      record: (event) => { written.push(event); },
    };

    const head = await createHeadRuntime(parent, 'h1', observer);

    expect(await readText(head, 'task.txt')).toBe('the task input');
    await head.storage.vfs.writeFile('head-output.md', 'what the head found');
    expect(readFileSync(join(project, 'head-output.md'), 'utf8')).toBe('what the head found');
    expect(await readText(parent, 'head-output.md')).toBe('what the head found');

    // The split reports this head's changes only if the observer wraps the plane it writes through.
    expect(written.map((event) => event.path)).toEqual(['head-output.md']);

    const headShell = head.shell;

    if (!headShell) throw new Error('a head over a bound directory runs the host shell');
    const env = await headShell.exec('pwd; echo "$HOME"; echo "$TMPDIR"');
    expect(env.stdout.trim().split('\n')).toEqual([
      resolve(project),
      join(resolve(project), '.kinu', 'facets', `head-${head.actor.storageKey}`),
      join(resolve(project), '.kinu', 'facets', `head-${head.actor.storageKey}`, 'tmp'),
    ]);
    const parentShell = parent.shell;

    if (!parentShell) throw new Error('a bound workspace runs the host shell');
    expect((await parentShell.exec('echo "$HOME"')).stdout.trim()).toBe(process.env.HOME ?? '');
    await head.identity.scaffold.write('// head\n');
    expect(await head.identity.scaffold.read()).toBe('// head\n');
    expect(await parent.identity.scaffold.exists()).toBe(false);
    expect(existsSync(join(project, 'scaffold'))).toBe(false);
    expect(readdirSync(join(state, 'parent')).filter((entry) => entry.endsWith('.db'))).toEqual(['agent.db']);
  });
});

describe('addressing the bound directory', () => {
  test('every address family the tree produces names the same bytes', async () => {
    const { state, project } = roots('cwd-plane-addresses');
    const rt = agentRuntime(state, 'solo', project);

    await rt.storage.vfs.writeFile('notes/one.md', 'one');

    // Relative, the advertised workspace root, the skills-style /workspace root, and the real host path.
    expect(await readText(rt, 'notes/one.md')).toBe('one');
    expect(await readText(rt, `${WORKSPACE_ROOT}/notes/one.md`)).toBe('one');
    expect(await readText(rt, '/workspace/notes/one.md')).toBe('one');
    expect(await readText(rt, join(project, 'notes/one.md'))).toBe('one');

    expect(await rt.storage.vfs.readdir('/')).toContain('notes');
    expect(await rt.storage.vfs.readdir('/workspace')).toContain('notes');
    expect(await rt.storage.vfs.readdir(WORKSPACE_ROOT)).toContain('notes');
  });

  test('a path that leaves the directory is refused, and writes nothing', async () => {
    const { state, project } = roots('cwd-plane-escape');
    const outside = join(project, '..', 'outside.txt');
    const rt = agentRuntime(state, 'solo', project);

    expect(await refusalOf(() => rt.storage.vfs.readFile('/workspace/../outside.txt'))).toBe('EACCES');
    expect(await refusalOf(() => rt.storage.vfs.writeFile('/workspace/../outside.txt', 'escaped'))).toBe('EACCES');
    expect(await refusalOf(() => rt.storage.vfs.writeFile('../outside.txt', 'escaped'))).toBe('EACCES');
    expect(await refusalOf(() => rt.storage.vfs.writeFile(`${WORKSPACE_ROOT}/../outside.txt`, 'escaped'))).toBe('EACCES');
    expect(await refusalOf(() => rt.storage.vfs.readFile('/etc/hostname'))).toBe('EACCES');
    expect(await refusalOf(() => rt.storage.vfs.mkdir('/workspace/../sneaky', { recursive: true }))).toBe('EACCES');

    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(project, '..', 'sneaky'))).toBe(false);
    expect(await refusalOf(() => rt.storage.vfs.exists('/etc/hostname'))).toBe('EACCES');
    expect(await refusalOf(() => rt.storage.vfs.stat('/etc/hostname'))).toBe('EACCES');
  });

  test('a directory whose own name contains dots is not mistaken for an escape', async () => {
    const { state, project } = roots('cwd-plane-dotnames');
    const rt = agentRuntime(state, 'solo', project);

    await rt.storage.vfs.writeFile('..hidden/file.txt', 'still inside');
    expect(readFileSync(join(project, '..hidden/file.txt'), 'utf8')).toBe('still inside');
  });
});

describe('the shell over the bound directory', () => {
  test('starts in the bound directory, not the directory the process runs in', async () => {
    const { state, project } = roots('cwd-plane-shell');
    writeFileSync(join(project, 'marker.txt'), 'the bound directory');
    const rt = agentRuntime(state, 'solo', project);
    rt.actor.config.setShellApprovalMode('allow_all');
    const shell = rt.shell;

    if (!shell) throw new Error('a bound runtime must have a shell');

    expect(process.cwd()).not.toBe(resolve(project));

    const read = await shell.exec('cat marker.txt');
    expect(read.exitCode).toBe(0);
    expect(read.stdout.trim()).toBe('the bound directory');

    const pwd = await shell.exec('pwd -P');
    expect(pwd.stdout.trim()).toBe(resolve(project));

    await shell.exec('echo from-the-shell > shell-wrote.txt');
    expect(await readText(rt, 'shell-wrote.txt')).toBe('from-the-shell\n');
  });

  test('what a command may have changed is snapshotted, and the snapshot names that directory', async () => {
    const { state, project } = roots('cwd-plane-checkpoints');
    writeFileSync(join(project, 'before.txt'), 'the state to restore\n');
    // Checkpoint storage is global per agent name; a stable name would read stores from prior runs.
    const rt = agentRuntime(state, `checkpointer-${basename(dirname(state))}`, project);
    rt.actor.config.setShellApprovalMode('allow_all');
    const checkpoints = rt.checkpoints;

    if (!checkpoints) throw new Error('a bound runtime must have a checkpoint engine');

    if (!(await checkpoints.status()).available) return; // no git on this box

    await rt.shell?.exec('echo mutated > before.txt');

    // The dedup is per directory, so one entry naming the bound directory.
    const entries = await checkpoints.list({ limit: 10 });
    expect(entries.map((entry) => entry.dir)).toEqual([resolve(project)]);
  });
});

describe('what an opened workspace puts where', () => {
  test('SOUL and memory are read from the agent plane and never appear in the directory', async () => {
    const { state, project } = roots('cwd-plane-opened');
    const { rt, info } = await openedWorkspace(state, 'jarvis', project);

    // Both come off the private plane; a shared directory holds neither.
    expect(info.soul).toContain('jarvis');
    expect(info.purpose).toBe('Test agent jarvis');
    expect(info.memorySize).toBeGreaterThan(0);

    await rt.memory.append('memory/MEMORY.md', '\nlearned something\n');
    await rt.identity.scaffold.write('// evolved\n');
    await rt.storage.vfs.writeFile('README.md', '# the project\n');

    expect(readdirSync(project)).toEqual(['README.md']);
    expect(await rt.storage.vfs.exists('SOUL.md')).toBe(false);
    expect(await rt.storage.vfs.exists('memory/MEMORY.md')).toBe(false);
    expect(await rt.storage.vfs.exists('scaffold/agent.js')).toBe(false);

    const agentState = rt.agentStateVfs;

    if (!agentState) throw new Error('an opened workspace must expose its own state plane');
    expect(await agentState.exists('SOUL.md')).toBe(true);
    expect(await agentState.exists('memory/MEMORY.md')).toBe(true);
    expect(await agentState.exists('scaffold/agent.js')).toBe(true);
  });
});

describe('a runtime with no directory bound', () => {
  test('keeps the in-SQLite plane and writes nothing to the filesystem', async () => {
    const { state } = roots('cwd-plane-unbound');
    const rt = agentRuntime(state, 'solo');

    expect(rt.cwd ?? null).toBeNull();
    await rt.storage.vfs.writeFile('untracked.txt', 'in the database');
    expect(await readText(rt, 'untracked.txt')).toBe('in the database');
    expect(existsSync(join(process.cwd(), 'untracked.txt'))).toBe(false);

    // Unbound, the two planes are one tree: the objects differ, the bytes do not.
    const agentState = rt.agentStateVfs;

    if (!agentState) throw new Error('every runtime states where its own state lives');
    expect(await agentState.readFile('untracked.txt', { encoding: 'utf8' })).toBe('in the database');
  });

  test('offers a node home only when the plane it would confine is its own', async () => {
    const { state, project } = roots('cwd-plane-nodehome');

    expect(agentRuntime(state, 'unbound').nodeHome).toBeDefined();
    expect(agentRuntime(state, 'bound', project).nodeHome).toBeUndefined();
  });
});

test('local Plan file inspection remains useful without granting native project writes', async () => {
  const { state, project } = roots('plan-cwd-inspection');
  writeFileSync(join(project, 'inspect.txt'), 'alpha\nneedle\nomega');
  const rt = agentRuntime(state, 'inspector', project);
  const planned = buildBuiltinTools({ rt, workMode: 'plan', history: rt.stores.history });
  const file = planned.file;

  if (file === undefined) throw new Error('No Plan file tool');
  const inspect = toolExecute(file);
  expect(await inspect({ action: 'list', path: '.' })).toMatchObject({ entries: expect.arrayContaining(['inspect.txt']) });
  expect(await inspect({ action: 'stat', path: 'inspect.txt' })).toMatchObject({ isDir: false, size: 18 });
  expect(await inspect({ action: 'search', path: 'inspect.txt', query: 'needle' })).toMatchObject({ matches: [{ line: 2, text: 'needle' }] });
  expect(await inspect({ action: 'read', path: 'inspect.txt' })).toEqual(expect.stringContaining('needle'));
  await expect(inspect({ action: 'write', path: 'inspect.txt', content: 'changed' })).rejects.toMatchObject({ code: 'denied' });
  expect(readFileSync(join(project, 'inspect.txt'), 'utf8')).toBe('alpha\nneedle\nomega');
  const buildFile = buildBuiltinTools({ rt, workMode: 'build', history: rt.stores.history }).file;

  if (buildFile === undefined) throw new Error('No Build file tool');
  const build = toolExecute(buildFile);
  await build({ action: 'read', path: 'inspect.txt' });
  expect(await build({ action: 'write', path: 'inspect.txt', content: 'built' })).toMatchObject({ ok: true });
  expect(readFileSync(join(project, 'inspect.txt'), 'utf8')).toBe('built');
});

test('a file the agent writes is named local:// when the directory is the workspace, vfs:// when it is not', async () => {
  const { state, project } = roots('cwd-plane-reference');

  const write = (rt: CLIRuntime) => {
    const file = buildBuiltinTools({ rt, workMode: 'build', history: rt.stores.history }).file;

    if (file === undefined) throw new Error('No Build file tool');

    return toolExecute(file)({ action: 'write', path: 'notes/plan.md', content: 'ship it' });
  };

  expect(await write(agentRuntime(state, 'bound', project))).toMatchObject({ ok: true, reference: 'local://notes/plan.md' });
  expect(readFileSync(join(project, 'notes/plan.md'), 'utf8')).toBe('ship it');
  expect(await write(agentRuntime(state, 'unbound'))).toMatchObject({ ok: true, reference: 'vfs://notes/plan.md' });
});
