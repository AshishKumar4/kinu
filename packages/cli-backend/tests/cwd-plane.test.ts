/**
 * The workspace plane bound to a physical directory.
 *
 * The property under test is the one that makes two local agents peers rather
 * than strangers: their canonical files are ONE directory on the real
 * filesystem, while everything each agent knows about itself stays in its own
 * database. Both halves have to hold at once — a shared plane that also
 * shares identity would have every peer overwriting the others' SOUL, and a
 * private plane that also privatised the files would give each peer its own
 * invisible copy of the user's project.
 *
 * These assertions are about bytes on disk, not about wiring: every one of
 * them reads the real directory with node:fs after driving the runtime, so a
 * plane that merely looks connected cannot pass.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { AgentRuntime, LLMProviderConfig, WriteEvent, WriteObserver } from '@kinu.run/core';
import { createAgentConfigStore, initWorkspaceSchema, isVfsError, WORKSPACE_ROOT } from '@kinu.run/core';
import { createWorkspace } from '@kinu.run/core/identity';
import { scratchDir } from '@kinu.run/test-utils';
import {
  buildCLIHeadRuntime, createCLIRuntime, makeWorkspaceSchemaSql, shareLocalWorkspacePlane,
  type CLIRuntime,
} from '../src/runtime';
import { openWorkspaceCLI } from '../src/open';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

/** State under `state/`, the project under `project/` — the shape the product
 *  has, because agent state never lives inside the directory it works in. */
function roots(label: string) {
  const root = scratchDir(label);
  const state = join(root, 'state');
  const project = join(root, 'project');
  mkdirSync(state, { recursive: true });
  mkdirSync(project, { recursive: true });
  return { state, project };
}

/** One agent's runtime over its own database, bound to `cwd` when given. */
function agentRuntime(state: string, name: string, cwd?: string): CLIRuntime {
  const dbPath = join(state, name, 'agent.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const config: Parameters<typeof createCLIRuntime>[1] = {
    dbPath, llm: DUMMY_LLM, agentName: name,
  };
  if (cwd !== undefined) config.cwd = cwd;
  return createCLIRuntime(new Database(dbPath), config);
}

/** A workspace with a real identity and SOUL.md, opened the way the CLI opens
 *  one — the only path that exercises openWorkspaceCLI's plane choices. */
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

    // And back the other way, through a directory neither runtime created.
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

    // None of it reached the directory the two of them share.
    expect(readdirSync(project)).toEqual([]);
  });

  test('a subordinate writes into the shared directory and keeps its own stores', async () => {
    const { state, project } = roots('cwd-plane-subordinate');
    const parent = agentRuntime(state, 'parent', project);
    const child = shareLocalWorkspacePlane(agentRuntime(state, 'child', project), parent);

    await child.storage.vfs.writeFile('from-child.txt', 'child was here');
    expect(readFileSync(join(project, 'from-child.txt'), 'utf8')).toBe('child was here');
    expect(await readText(parent, 'from-child.txt')).toBe('child was here');

    // Same directory, so the transplant is unnecessary: what it shares is the
    // one restore point for that directory, and nothing else.
    expect(child.cwd).toBe(resolve(project));
    expect(child.checkpoints).toBe(parent.checkpoints);
    expect(child.memory).not.toBe(parent.memory);
    expect(child.craftStore).not.toBe(parent.craftStore);
    expect(child.storage.sql).not.toBe(parent.storage.sql);
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
    const headDb = new Database(':memory:');
    const head = buildCLIHeadRuntime(headDb, {
      parentRuntime: parent, agentId: 'h1', agentName: 'head-h1', writeObserver: observer,
    });

    // A fork explores the same project, so what the user left in the directory
    // is what the head reads, and what it writes lands there.
    expect(await readText(head, 'task.txt')).toBe('the task input');
    await head.storage.vfs.writeFile('head-output.md', 'what the head found');
    expect(readFileSync(join(project, 'head-output.md'), 'utf8')).toBe('what the head found');
    expect(await readText(parent, 'head-output.md')).toBe('what the head found');

    // The split reports the files THIS head changed, which only works if the
    // observer wraps the plane the head actually writes through.
    expect(written.map((event) => event.path)).toEqual(['head-output.md']);

    // One directory, one shell — and its own state stays its own.
    expect(head.shell).toBe(parent.shell);
    await head.identity.scaffold.write('// head\n');
    expect(await head.identity.scaffold.read()).toBe('// head\n');
    expect(await parent.identity.scaffold.exists()).toBe(false);
    expect(existsSync(join(project, 'scaffold'))).toBe(false);
    headDb.close();
  });
});

describe('addressing the bound directory', () => {
  test('every address family the tree produces names the same bytes', async () => {
    const { state, project } = roots('cwd-plane-addresses');
    const rt = agentRuntime(state, 'solo', project);

    await rt.storage.vfs.writeFile('notes/one.md', 'one');

    // Relative (the file tool), the workspace root the prompt advertises, the
    // skills-style /workspace root, and the real path the host shell prints.
    expect(await readText(rt, 'notes/one.md')).toBe('one');
    expect(await readText(rt, `${WORKSPACE_ROOT}/notes/one.md`)).toBe('one');
    expect(await readText(rt, '/workspace/notes/one.md')).toBe('one');
    expect(await readText(rt, join(project, 'notes/one.md'))).toBe('one');

    // The plane's root lists the directory whichever way it is named.
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
    // A refusal is not an absence: `exists` and `stat` refuse too, rather than
    // reporting that the machine's own files are not there.
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
    // The default is 'strict', which asks a channel this runtime has none of.
    createAgentConfigStore(rt.storage.sql).setShellApprovalMode('allow_all');
    const shell = rt.shell;
    if (!shell) throw new Error('a bound runtime must have a shell');

    expect(process.cwd()).not.toBe(resolve(project));

    // A relative read only resolves if the shell really started there.
    const read = await shell.exec('cat marker.txt');
    expect(read.exitCode).toBe(0);
    expect(read.stdout.trim()).toBe('the bound directory');

    const pwd = await shell.exec('pwd -P');
    expect(pwd.stdout.trim()).toBe(resolve(project));

    // And what the shell writes is what the file plane reads.
    await shell.exec('echo from-the-shell > shell-wrote.txt');
    expect(await readText(rt, 'shell-wrote.txt')).toBe('from-the-shell\n');
  });

  test('what a command may have changed is snapshotted, and the snapshot names that directory', async () => {
    const { state, project } = roots('cwd-plane-checkpoints');
    writeFileSync(join(project, 'before.txt'), 'the state to restore\n');
    // Checkpoint storage is global per agent name, so this fixture mints a
    // unique name. A stable test name would read valid stores from prior runs.
    const rt = agentRuntime(state, `checkpointer-${basename(dirname(state))}`, project);
    createAgentConfigStore(rt.storage.sql).setShellApprovalMode('allow_all');
    const checkpoints = rt.checkpoints;
    if (!checkpoints) throw new Error('a bound runtime must have a checkpoint engine');
    if (!(await checkpoints.status()).available) return; // no git on this box

    await rt.shell?.exec('echo mutated > before.txt');

    // The dedup is per directory, so one entry — and it names the bound
    // directory. Before, an unbound workspace shell was wrapped too and handed
    // the engine the agent's database FILE as its working directory.
    const entries = await checkpoints.list({ limit: 10 });
    expect(entries.map((entry) => entry.dir)).toEqual([resolve(project)]);
  });
});

describe('what an opened workspace puts where', () => {
  test('SOUL and memory are read from the agent plane and never appear in the directory', async () => {
    const { state, project } = roots('cwd-plane-opened');
    const { rt, info } = await openedWorkspace(state, 'jarvis', project);

    // Both come off the private plane: a shared directory holds neither, so
    // reading them there would have reported an empty identity.
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

    // Unbound, the two planes are one tree: the mount table wraps it, so the
    // objects differ while the bytes do not.
    const agentState = rt.agentStateVfs;
    if (!agentState) throw new Error('every runtime states where its own state lives');
    expect(await agentState.readFile('untracked.txt', { encoding: 'utf8' })).toBe('in the database');
  });

  test('offers a node home only when the plane it would confine is its own', async () => {
    const { state, project } = roots('cwd-plane-nodehome');

    // The in-SQLite plane carries the privileged view and the uid rows a
    // private node home is made of.
    expect(agentRuntime(state, 'unbound').nodeHome).toBeDefined();
    // A physical directory carries neither, so the host is withheld and a node
    // states that it shares the origin plane instead.
    expect(agentRuntime(state, 'bound', project).nodeHome).toBeUndefined();
  });
});
