import { exists, readText as nimbusReadText, type Awaitable, writeText } from '@nimbus-sh/core/vfs/vfs.js';
/** Workspace plane bound to a physical directory: peers share canonical files on disk while identity stays in each agent's database. */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import * as v from 'valibot';
import type { AgentRuntime, DeferredApprovalChannel, LLMProviderConfig, ShellApprovalOutcome, WriteEvent, WriteObserver } from '@kinu.run/core';
import { ConversationSearchStore, buildBuiltinTools, discoverSkills, initWorkspaceSchema, reviewCommand, SLATES_ROOT, WORKSPACE_ROOT, actorHomeName } from '@kinu.run/core';
import { isVfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { createWorkspace } from '@kinu.run/core/workspace-birth';
import { present, scratchDir, toolExecute } from '@kinu.run/test-utils';
import {
  createCLIRuntime, createHostShell, makeWorkspaceSchemaSql, shareLocalWorkspacePlane,
  type CLIRuntime,
} from '../src/runtime';
import { createHeadRuntime } from './actor-fixture';
import { registerLocalActor } from '@kinu.run/core';
import { openWorkspaceCLI } from '../src/open';
import { PROVIDER_CREDENTIAL_ENV, SESSION_CREDENTIAL_ENV } from '../src/model-resolver';

/** Every name the harness reads a credential from, as the declaring modules name them. */
const HARNESS_CREDENTIAL_NAMES: readonly string[] = [
  ...Object.values(PROVIDER_CREDENTIAL_ENV), ...SESSION_CREDENTIAL_ENV,
];

const DevicePlanSchema = v.object({ env: v.record(v.string(), v.string()) });

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
    llm: DUMMY_LLM, agentName: name,
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
  const raw = await nimbusReadText(rt.storage.vfs, path);

  return raw;
}

async function refusalOf<T>(op: () => Awaitable<T>): Promise<string> {
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

    await writeText(first.storage.vfs, 'shared.txt', 'written by first');

    expect(await readText(second, 'shared.txt')).toBe('written by first');
    expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('written by first');

    await writeText(second.storage.vfs, 'src/deep/file.ts', 'export const x = 1;\n');
    expect(await readText(first, 'src/deep/file.ts')).toBe('export const x = 1;\n');
  });

  test('a file the user created is already there for both of them', async () => {
    const { state, project } = roots('cwd-plane-existing');
    writeFileSync(join(project, 'AGENTS.md'), '# House rules\n');
    const first = agentRuntime(state, 'first', project);
    const second = agentRuntime(state, 'second', project);

    expect(await readText(first, 'AGENTS.md')).toBe('# House rules\n');
    expect(await readText(second, 'AGENTS.md')).toBe('# House rules\n');
    expect((await first.storage.vfs.readdir('.')).map(({ name }) => name)).toContain('AGENTS.md');
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
    expect(await exists(secondState, 'memory/notes.md')).toBe(false);

    expect(readdirSync(project)).toEqual([]);
  });

  test('a subordinate writes into the shared directory and keeps its own actor-scoped stores', async () => {
    const { state, project } = roots('cwd-plane-subordinate');
    const parent = agentRuntime(state, 'parent', project);
    const binding = registerLocalActor(parent.actor, { name: 'child', creationId: 'child-birth', origin: 'agent', lifetime: 'durable' });
    const physicalName = actorHomeName({ origin: 'agent', storageKey: binding.storageKey });

    const child = await shareLocalWorkspacePlane(
      createCLIRuntime(parent.db, { llm: null, cwd: project, facet: physicalName, actorBinding: binding }),
      parent, physicalName,
    );

    await writeText(child.storage.vfs, 'from-child.txt', 'child was here');
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
    await writeText(head.storage.vfs, 'head-output.md', 'what the head found');
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
  test('bare virtual homes cannot remove or rename the bound project directory', async () => {
    for (const home of ['/home/main', '/home/user']) {
      const { state, project } = roots('cwd-plane-home-anchor');
      const rt = agentRuntime(state, 'solo', project);
      const rename = present(rt.storage.vfs.rename?.bind(rt.storage.vfs), 'the mounted rename route');
      const removeTree = present(rt.storage.vfs.removeRecursive?.bind(rt.storage.vfs), 'the mounted removal route');
      await writeText(rt.storage.vfs, 'keep.txt', 'the project survives');

      await expect(rename(home, join(project, '..', 'renamed'))).rejects.toMatchObject({ code: 'EPERM' });
      await expect(rt.storage.vfs.unlink(home)).rejects.toMatchObject({ code: 'EACCES' });
      await expect(removeTree(home)).rejects.toMatchObject({ code: 'EACCES' });
      expect(readFileSync(join(project, 'keep.txt'), 'utf8')).toBe('the project survives');
      expect(statSync(project).isDirectory()).toBe(true);
    }
  });

  test('every address family the tree produces names the same bytes', async () => {
    const { state, project } = roots('cwd-plane-addresses');
    const rt = agentRuntime(state, 'solo', project);

    await writeText(rt.storage.vfs, 'notes/one.md', 'one');

    // Relative, the advertised workspace root, and the real host path.
    expect(await readText(rt, 'notes/one.md')).toBe('one');
    expect(await readText(rt, `${WORKSPACE_ROOT}/notes/one.md`)).toBe('one');
    expect(await readText(rt, join(project, 'notes/one.md'))).toBe('one');

    expect((await rt.storage.vfs.readdir('/')).map(({ name }) => name)).toContain('notes');
    expect((await rt.storage.vfs.readdir(WORKSPACE_ROOT)).map(({ name }) => name)).toContain('notes');
  });

  test('a slate the agent writes at /slates is in the project\'s own slates/ folder', async () => {
    const { state, project } = roots('cwd-plane-slates');
    const rt = agentRuntime(state, 'solo', project);

    await writeText(rt.storage.vfs, `${SLATES_ROOT}/widgets/package.json`, '{"main":"server.ts"}');

    expect(readFileSync(join(project, 'slates/widgets/package.json'), 'utf8')).toBe('{"main":"server.ts"}');
    expect((await rt.storage.vfs.readdir(SLATES_ROOT)).map(({ name }) => name)).toEqual(['widgets']);
  });

  /** The agent's `file` tool and codemode's `workspace.writeFile`, with a user who answers `answer`. */
  function agentTools(rt: CLIRuntime, answer: () => ShellApprovalOutcome | null) {
    const asked: string[] = [];

    rt.setShellApprovalChannel?.(async (request) => {
      asked.push(request.command);

      return answer();
    });

    const file = toolExecute(present(buildBuiltinTools({ rt, workMode: 'build', conversations: new ConversationSearchStore(rt.storage.sql, rt.actor, (sessionId) => rt.stores.history.transcript(sessionId)) }).file, 'the file tool'));
    const writeFile = present(rt.executionRouter?.getProvider('workspace'), 'the workspace executor').tools.writeFile;

    return { file, writeFile: (path: string, content: string) => present(writeFile, 'workspace.writeFile').execute(path, content), asked };
  }

  test('a relative path that climbs out of the directory is a host path outside it, and its write waits for the user', async () => {
    const { state, project } = roots('cwd-plane-climb');
    const outside = join(dirname(project), 'outside.txt');
    const rt = agentRuntime(state, 'solo', project);
    const { file, asked } = agentTools(rt, () => 'deny');

    await expect(file({ action: 'write', path: '../outside.txt', content: 'climbed' })).rejects.toMatchObject({ code: 'denied' });
    expect(asked).toEqual([`file write ${outside}`]);
    expect(existsSync(outside)).toBe(false);
  });

  test('the agent reads outside the directory unasked; its change there waits for the user, and runs once allowed', async () => {
    const { state, project } = roots('cwd-plane-outside');
    const beside = dirname(project);
    const notes = join(beside, 'notes.txt');
    writeFileSync(notes, 'beside the project\n');
    const rt = agentRuntime(state, 'solo', project);
    let answer: ShellApprovalOutcome = 'deny';
    const { file, writeFile, asked } = agentTools(rt, () => answer);

    expect(await file({ action: 'read', path: notes })).toEqual(expect.stringContaining('beside the project'));
    expect(asked).toEqual([]);

    const created = join(beside, 'created.txt');
    await expect(file({ action: 'write', path: created, content: 'unasked' })).rejects.toMatchObject({ code: 'denied' });
    expect(await writeFile(join(beside, 'codemode.txt'), 'unasked')).toMatchObject({ error: expect.stringContaining('write-outside-directory') });
    // A new directory outside is itself a change; the one a write lands in already exists.
    await expect(file({ action: 'write', path: join(beside, 'fresh', 'a.txt'), content: 'unasked' })).rejects.toMatchObject({ code: 'denied' });
    expect(asked).toEqual([`file write ${created}`, `file write ${join(beside, 'codemode.txt')}`, `file mkdir ${join(beside, 'fresh')}`]);
    expect([existsSync(created), existsSync(join(beside, 'codemode.txt')), existsSync(join(beside, 'fresh'))]).toEqual([false, false, false]);

    answer = 'allow';
    expect(await file({ action: 'write', path: created, content: 'approved' })).toMatchObject({ ok: true });
    expect(readFileSync(created, 'utf8')).toBe('approved');
    expect(await file({ action: 'write', path: join(project, 'inside.txt'), content: 'own' })).toMatchObject({ ok: true });
    expect(asked).toHaveLength(4);
  });

  test('with nobody to ask, the agent\'s change outside the directory is refused, never parked, while a shell command parks', async () => {
    const { state, project } = roots('cwd-plane-outside-unattended');
    const created = join(dirname(project), 'created.txt');
    const rt = agentRuntime(state, 'solo', project);
    const { file } = agentTools(rt, () => null);
    const parked: string[] = [];

    const deferrals: DeferredApprovalChannel = {
      park: async (request) => {
        parked.push(request.command);

        return { run: false, reason: 'unavailable', message: `NOT RUN — queued: ${request.command}` };
      },
      settle: async () => {},
    };

    rt.setApprovalDeferrals?.(deferrals);

    await expect(file({ action: 'write', path: created, content: 'unattended' })).rejects.toMatchObject({ code: 'unavailable' });
    expect((await present(rt.shell, 'the placed shell').exec('rm -rf build')).stderr).toContain('NOT RUN — queued');

    expect(parked).toEqual(['rm -rf build']);
    expect(existsSync(created)).toBe(false);
  });

  test('a standing deny_all refuses the agent\'s change there, and nobody is asked', async () => {
    const { state, project } = roots('cwd-plane-outside-deny');
    const notes = join(dirname(project), 'notes.txt');
    writeFileSync(notes, 'kept\n');
    const rt = agentRuntime(state, `outside-deny-${basename(dirname(state))}`, project);
    rt.actor.config.setShellApprovalMode('deny_all');
    const { file, asked } = agentTools(rt, () => 'allow');

    await file({ action: 'read', path: notes });
    await expect(file({ action: 'write', path: notes, content: 'replaced' })).rejects.toMatchObject({ code: 'denied' });
    expect(asked).toEqual([]);
    expect(readFileSync(notes, 'utf8')).toBe('kept\n');
  });

  test('a file that looks like a secret is read under the shell\'s rule for `cat`', async () => {
    const { state, project } = roots('cwd-plane-secret-read');
    writeFileSync(join(project, '.env'), 'TOKEN=planted\n');
    writeFileSync(join(project, 'README.md'), '# the project\n');
    const rt = agentRuntime(state, 'solo', project);
    const { file } = agentTools(rt, () => null);
    rt.actor.config.setShellApprovalMode('deny_all');

    expect((await present(rt.shell, 'the placed shell').exec('cat .env')).exitCode).not.toBe(0);
    await expect(file({ action: 'read', path: '.env' })).rejects.toMatchObject({ code: 'denied' });
    expect(await file({ action: 'read', path: 'README.md' })).toEqual(expect.stringContaining('# the project'));

    rt.actor.config.setShellApprovalMode('strict');
    expect(await file({ action: 'read', path: '.env' })).toEqual(expect.stringContaining('TOKEN=planted'));
  });

  test('a directory whose own name contains dots is not mistaken for an escape', async () => {
    const { state, project } = roots('cwd-plane-dotnames');
    const rt = agentRuntime(state, 'solo', project);

    await writeText(rt.storage.vfs, '..hidden/file.txt', 'still inside');
    expect(readFileSync(join(project, '..hidden/file.txt'), 'utf8')).toBe('still inside');
  });

  test('a skill in the bound directory is discovered: the shared Drive this runtime lacks is absent, not an escape', async () => {
    const { state, project } = roots('cwd-plane-skills');
    mkdirSync(join(project, 'skills'), { recursive: true });
    writeFileSync(join(project, 'skills', 'review.md'), '---\nname: review\ndescription: Review a change\n---\nName every risk.\n');
    const rt = agentRuntime(state, 'solo', project);

    const found = await discoverSkills(rt.storage.vfs, { admissionTokens: 100_000 });

    expect(found.skills.find((skill) => skill.name === 'review')?.source).toBe('vfs');
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

  test('a command that can wreck the user\'s files is put to them first; the in-SQLite workspace is the agent\'s own', async () => {
    const { state, project } = roots('cwd-plane-local-harm');
    mkdirSync(join(project, 'doomed'));
    writeFileSync(join(project, 'doomed', 'kept.txt'), 'the user\'s work\n');
    writeFileSync(join(project, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    const commands = ['sudo -n true', 'rm -rf doomed', 'git reset --hard', 'chmod u+s tool'];

    const askedOn = (rt: CLIRuntime): string[] => {
      const asked: string[] = [];
      rt.setShellApprovalChannel?.(async (request) => {
        asked.push(request.command);

        return 'deny';
      });

      return asked;
    };

    // Checkpoint storage is global per agent name; a stable name would read stores from prior runs.
    const placed = agentRuntime(state, `local-harm-${basename(dirname(state))}`, project);
    const askedPlaced = askedOn(placed);

    for (const command of commands) await present(placed.shell, 'the placed shell').exec(command);

    expect(askedPlaced).toEqual(commands);
    expect(readdirSync(join(project, 'doomed'))).toEqual(['kept.txt']);
    expect(statSync(join(project, 'tool')).mode & 0o4000).toBe(0);

    const unplaced = agentRuntime(state, 'local-harm-unplaced');
    const askedUnplaced = askedOn(unplaced);
    await writeText(unplaced.storage.vfs, 'doomed/kept.txt', 'the agent\'s scratch\n');

    for (const command of commands) await present(unplaced.shell, 'the in-SQLite shell').exec(command);

    expect(askedUnplaced).toEqual([]);
    expect(await exists(unplaced.storage.vfs, 'doomed')).toBe(false);

    // Both executors are named 'workspace'; the rules follow what each declares it holds.
    const declared = (rt: CLIRuntime) => present(rt.executionRouter?.getProvider('workspace'), 'the workspace executor').filesOwner;

    expect(reviewCommand('rm -rf ~/x', declared(placed)).decision).toBe('gate');
    expect(reviewCommand('rm -rf ~/x', declared(unplaced)).decision).toBe('allow');
  });

  test('no tier passes on a planted credential; the host shell keeps the user\'s own settings', async () => {
    const { project } = roots('cwd-plane-env-backends');
    const [home, agentHome, agentTmp] = ['home', 'agents/ws/home', 'agents/ws/tmp'].map((dir) => join(project, dir));

    for (const dir of [home, agentHome, agentTmp]) mkdirSync(dir ?? project, { recursive: true });

    const daemon = v.parse(
      v.object({ ENV_ALLOWLIST: v.array(v.string()), plan: v.function() }),
      createRequire(import.meta.url)(join(import.meta.dir, '../../pc-agent/src/sandbox.js')),
    );

    // Candidates from both backends and the live environment, each derived credential carrying a canary. Every
    // tier is handed this source; this process's env is never written, since a planted proxy reroutes other tests.
    const candidates = new Set([...HARNESS_CREDENTIAL_NAMES, ...daemon.ENV_ALLOWLIST, ...Object.keys(process.env)]);
    const userSettings = { SSH_AUTH_SOCK: `/run/agent-${crypto.randomUUID()}.sock`, HTTPS_PROXY: 'http://proxy.test:3128' };

    const source = {
      ...Object.fromEntries([...candidates].map((name) => [
        name, HARNESS_CREDENTIAL_NAMES.includes(name) ? `planted:${name}` : process.env[name] ?? `probe:${name}`,
      ])),
      ...userSettings,
    };

    const hostShell = await createHostShell(project, source).exec('env');
    const rawDevice = v.parse(DevicePlanSchema, daemon.plan({ tier: 'raw', deviceHome: project, command: 'env', cwd: project, source })).env;

    expect(hostShell.stdout.split('\n').filter((line) => line.includes('planted:'))).toEqual([]);
    expect(Object.entries(rawDevice).filter(([, value]) => value.startsWith('planted:'))).toEqual([]);
    expect(Object.entries(userSettings).filter(([name, value]) => !hostShell.stdout.includes(`${name}=${value}\n`))).toEqual([]);

    // The sandboxed device tier passes named variables only, so a secret no rule names stays out as well.
    const secret = `npm_${crypto.randomUUID().replaceAll('-', '')}`;

    const sandboxed = JSON.stringify(daemon.plan({
      tier: 'sandboxed', platform: 'linux', home, agentHome, agentTmp, deviceHome: project, roots: [project], cwd: project,
      command: 'env', source: { ...source, NPM_TOKEN: secret }, statusFd: 3,
    }));

    expect({ secret: sandboxed.includes(secret), planted: sandboxed.includes('planted:') }).toEqual({ secret: false, planted: false });
  });

  test('what a command may have changed is snapshotted, and the snapshot names that directory', async () => {
    const { state, project } = roots('cwd-plane-checkpoints');
    writeFileSync(join(project, 'before.txt'), 'the state to restore\n');
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

  test('a file write snapshots the bound directory, never a marked directory above it', async () => {
    const { state, project } = roots('cwd-plane-file-checkpoint');
    // A marker above the workspace: snapshotting there would stage every file beside the workspace too.
    writeFileSync(join(dirname(project), 'package.json'), '{}\n');
    const rt = agentRuntime(state, `file-checkpointer-${basename(dirname(state))}`, project);
    const checkpoints = rt.checkpoints;

    if (!checkpoints) throw new Error('a bound runtime must have a checkpoint engine');

    if (!(await checkpoints.status()).available) return; // no git on this box

    await writeText(rt.storage.vfs, 'notes/plan.md', 'ship it\n');

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
    await writeText(rt.storage.vfs, 'README.md', '# the project\n');

    expect(readdirSync(project)).toEqual(['README.md']);
    expect(await exists(rt.storage.vfs, 'SOUL.md')).toBe(false);
    expect(await exists(rt.storage.vfs, 'memory/MEMORY.md')).toBe(false);
    expect(await exists(rt.storage.vfs, 'scaffold/agent.js')).toBe(false);

    const agentState = rt.agentStateVfs;

    if (!agentState) throw new Error('an opened workspace must expose its own state plane');
    expect(await exists(agentState, 'SOUL.md')).toBe(true);
    expect(await exists(agentState, 'memory/MEMORY.md')).toBe(true);
    expect(await exists(agentState, 'scaffold/agent.js')).toBe(true);
  });
});

describe('the agent\'s own state in a placed workspace', () => {
  test('memory, SOUL.md and the scaffold read at /agent, and nothing writes through it', async () => {
    const { state, project } = roots('cwd-plane-agent-view');
    const { rt } = await openedWorkspace(state, 'jarvis', project);
    await rt.memory.append('memory/MEMORY.md', '\nlearned something\n');
    await rt.identity.scaffold.write('// evolved\n');
    const soul = String(await nimbusReadText(present(rt.agentStateVfs, 'the agent state plane'), 'SOUL.md'));

    expect((await rt.storage.vfs.readdir('/agent')).map(({ name }) => name).sort()).toEqual(['SOUL.md', 'memory', 'scaffold']);
    expect(await readText(rt, '/agent/SOUL.md')).toBe(soul);
    expect(await readText(rt, '/agent/memory/MEMORY.md')).toContain('learned something');
    expect(await readText(rt, '/agent/scaffold/agent.js')).toBe('// evolved\n');
    expect(await exists(rt.storage.vfs, '/agent/workspace.db')).toBe(false);

    expect(await refusalOf(() => writeText(rt.storage.vfs, '/agent/memory/MEMORY.md', 'forged'))).toBe('EROFS');
    expect(await refusalOf(() => writeText(rt.storage.vfs, '/agent/SOUL.md', 'forged'))).toBe('EROFS');
    expect(await refusalOf(() => rt.storage.vfs.unlink('/agent/scaffold/agent.js'))).toBe('EROFS');
    expect(await refusalOf(() => rt.storage.vfs.mkdir('/agent/memory/more', { recursive: true }))).toBe('EROFS');
    expect(await readText(rt, '/agent/SOUL.md')).toBe(soul);
    expect(readdirSync(project)).toEqual([]);
  });
});

describe('a runtime with no directory bound', () => {
  test('keeps the in-SQLite plane and writes nothing to the filesystem', async () => {
    const { state } = roots('cwd-plane-unbound');
    const rt = agentRuntime(state, 'solo');

    expect(rt.cwd ?? null).toBeNull();
    await writeText(rt.storage.vfs, 'untracked.txt', 'in the database');
    expect(await readText(rt, 'untracked.txt')).toBe('in the database');
    expect(existsSync(join(process.cwd(), 'untracked.txt'))).toBe(false);

    // Unbound, the two planes are one tree: the objects differ, the bytes do not.
    const agentState = rt.agentStateVfs;

    if (!agentState) throw new Error('every runtime states where its own state lives');
    expect(await nimbusReadText(agentState, 'untracked.txt')).toBe('in the database');
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
  const planned = buildBuiltinTools({ rt, workMode: 'plan', conversations: new ConversationSearchStore(rt.storage.sql, rt.actor, (sessionId) => rt.stores.history.transcript(sessionId)) });
  const file = planned.file;

  if (file === undefined) throw new Error('No Plan file tool');
  const inspect = toolExecute(file);
  expect(await inspect({ action: 'list', path: '.' })).toMatchObject({ entries: expect.arrayContaining(['inspect.txt']) });
  expect(await inspect({ action: 'stat', path: 'inspect.txt' })).toMatchObject({ isDir: false, size: 18 });
  expect(await inspect({ action: 'search', path: 'inspect.txt', query: 'needle' })).toMatchObject({ matches: [{ line: 2, text: 'needle' }] });
  expect(await inspect({ action: 'read', path: 'inspect.txt' })).toEqual(expect.stringContaining('needle'));
  await expect(inspect({ action: 'write', path: 'inspect.txt', content: 'changed' })).rejects.toMatchObject({ code: 'denied' });
  expect(readFileSync(join(project, 'inspect.txt'), 'utf8')).toBe('alpha\nneedle\nomega');
  const buildFile = buildBuiltinTools({ rt, workMode: 'build', conversations: new ConversationSearchStore(rt.storage.sql, rt.actor, (sessionId) => rt.stores.history.transcript(sessionId)) }).file;

  if (buildFile === undefined) throw new Error('No Build file tool');
  const build = toolExecute(buildFile);
  await build({ action: 'read', path: 'inspect.txt' });
  expect(await build({ action: 'write', path: 'inspect.txt', content: 'built' })).toMatchObject({ ok: true });
  expect(readFileSync(join(project, 'inspect.txt'), 'utf8')).toBe('built');
});

test('a file the agent writes is named local:// when the directory is the workspace, vfs:// when it is not', async () => {
  const { state, project } = roots('cwd-plane-reference');

  const write = (rt: CLIRuntime) => {
    const file = buildBuiltinTools({ rt, workMode: 'build', conversations: new ConversationSearchStore(rt.storage.sql, rt.actor, (sessionId) => rt.stores.history.transcript(sessionId)) }).file;

    if (file === undefined) throw new Error('No Build file tool');

    return toolExecute(file)({ action: 'write', path: 'notes/plan.md', content: 'ship it' });
  };

  expect(await write(agentRuntime(state, 'bound', project))).toMatchObject({ ok: true, reference: 'local://notes/plan.md' });
  expect(readFileSync(join(project, 'notes/plan.md'), 'utf8')).toBe('ship it');
  expect(await write(agentRuntime(state, 'unbound'))).toMatchObject({ ok: true, reference: 'vfs://notes/plan.md' });
});

describe('SOUL.md is the owner\'s', () => {
  const forgeries = ['printf forged > SOUL.md', 'rm -f SOUL.md', 'mv SOUL.md gone.md', 'chmod 666 SOUL.md', 'printf forged > f && mv -f f SOUL.md'];

  test('no agent file or shell forgery reaches the next turn in a workspace opened without a directory', async () => {
    const { state } = roots('soul-owner');
    const dbPath = join(state, 'jarvis', 'agent.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    await createWorkspace(db, { name: 'jarvis', purpose: 'Test agent jarvis', llm: DUMMY_LLM });
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM });
    const ownerSoul = present(rt.ownerSoul, 'the owner soul reader');
    const born = present(await ownerSoul(), 'the born soul');

    await expect(writeText(rt.storage.vfs, 'SOUL.md', 'forged')).rejects.toThrow();

    for (const command of forgeries) {
      await present(rt.shell, 'the workspace shell').exec(command);

      expect(await ownerSoul()).toBe(born);
      expect(await readText(rt, 'SOUL.md')).toBe(born);
    }
  });

});
