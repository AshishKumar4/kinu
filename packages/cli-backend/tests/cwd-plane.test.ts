import { exists, readText as nimbusReadText, type Awaitable, writeText } from '@nimbus-sh/core/vfs/vfs.js';
/** Workspace plane bound to a physical directory: peers share canonical files on disk while identity stays in each agent's database. */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync, readlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import * as v from 'valibot';
import type { AgentRuntime, DeferredApprovalChannel, LLMProviderConfig, ShellApprovalOutcome, WriteEvent, WriteObserver } from '@kinu.run/core';
import { ConversationSearchStore, buildBuiltinTools, discoverSkills, initWorkspaceSchema, reviewCommand, WORKSPACE_ROOT, actorHomeName } from '@kinu.run/core';
import { isVfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { createWorkspace } from '@kinu.run/core/workspace-birth';
import { present, scratchDir, spawnTest, toolExecute } from '@kinu.run/test-utils';
import {
  createCLIRuntime, createHostShell, makeWorkspaceSchemaSql, shareLocalWorkspacePlane,
  type CLIRuntime, workspaceHome, soulIn,
} from '../src/runtime';
import { createHeadRuntime } from './actor-fixture';
import { registerLocalActor } from '@kinu.run/core';
import { openWorkspaceCLI } from '../src/open';
import { compactedScreenshots, screenshot } from '../../compaction/tests/helpers';
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

/** A workspace's database as `kinu create` publishes it: in WAL a commit waits on no fsync. */
function published(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');

  return db;
}

function agentRuntime(state: string, name: string, cwd: string): LocalAgent {
  const dbPath = join(state, name, 'agent.db');
  mkdirSync(dirname(dbPath), { recursive: true });

  const config: Parameters<typeof createCLIRuntime>[1] = {
    llm: DUMMY_LLM, agentName: name, cwd,
  };

  const db = published(dbPath);

  return Object.assign(createCLIRuntime(db, config), { db, dbPath });
}

/** Opened the way the CLI opens one: the only path through openWorkspaceCLI's plane choices. */
async function openedWorkspace(state: string, name: string, cwd: string) {
  const dbPath = join(state, name, 'agent.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = published(dbPath);
  await createWorkspace(db, { name, purpose: `Test agent ${name}`, llm: DUMMY_LLM, home: workspaceHome(db) });
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

    const child = shareLocalWorkspacePlane(
      createCLIRuntime(parent.db, { llm: null, cwd: project, facet: physicalName, actorBinding: binding }),
      parent,
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

    // The split hears this head's changes where they land, named as the shell names them.
    expect(written.map((event) => event.path)).toEqual([join(project, 'head-output.md')]);

    const headShell = head.shell;

    if (!headShell) throw new Error('a head over a bound directory runs the host shell');
    const env = await headShell.exec('pwd; echo "$HOME"; echo "$TMPDIR"');
    expect(env.stdout.trim().split('\n')).toEqual([
      resolve(project),
      join(state, 'parent', 'home', `head-${head.actor.storageKey}`),
      join(state, 'parent', 'home', `head-${head.actor.storageKey}`, 'tmp'),
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

describe('listing the bound directory', () => {
  test('names a FIFO by its kind: a listing says file for a regular file only, so Nimbus stats only what it cannot name', async () => {
    const { state, project } = roots('cwd-plane-kinds');
    const rt = agentRuntime(state, 'solo', project);
    writeFileSync(join(project, 'plain.txt'), 'x');
    expect(await spawnTest(['mkfifo', join(project, 'pipe')]).exited).toBe(0);

    const kinds = (await rt.storage.vfs.readdir(project)).filter((entry) => ['plain.txt', 'pipe'].includes(entry.name));

    expect(kinds.map((entry) => `${entry.name}:${entry.type}`).sort()).toEqual(['pipe:fifo', 'plain.txt:file']);
  });
});

describe('addressing the bound directory', () => {
  test('neither the folder nor the agent\'s own space can be removed or renamed away', async () => {
    const { state, project } = roots('cwd-plane-home-anchor');
    const rt = agentRuntime(state, 'solo', project);
    const space = join(state, 'solo');
    const rename = present(rt.storage.vfs.rename?.bind(rt.storage.vfs), 'the mounted rename route');
    const removeTree = present(rt.storage.vfs.removeRecursive?.bind(rt.storage.vfs), 'the mounted removal route');
    await writeText(rt.storage.vfs, 'keep.txt', 'the project survives');

    await expect(rename(project, join(state, 'renamed'))).rejects.toMatchObject({ code: 'EACCES' });
    await expect(rt.storage.vfs.unlink(project)).rejects.toMatchObject({ code: 'EACCES' });
    await expect(removeTree(project)).rejects.toMatchObject({ code: 'EACCES' });
    // The own space is a mount point of the one namespace, which answers as POSIX does one.
    await expect(rename(space, join(state, 'renamed'))).rejects.toMatchObject({ code: 'EBUSY' });
    await expect(rt.storage.vfs.unlink(space)).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(removeTree(space)).rejects.toMatchObject({ code: 'EBUSY' });

    expect(readFileSync(join(project, 'keep.txt'), 'utf8')).toBe('the project survives');
    expect(existsSync(join(space, 'agent.db'))).toBe(true);
    // A plane with no rename carries it as mv does, and a refused carry leaves nothing behind.
    expect(readdirSync(state).filter((entry) => entry.startsWith('.nimbus-move-') || entry === 'renamed')).toEqual([]);
  });

  // One namespace, the shell's: an absolute path is the machine's, so the own space is its real path or `vfs://`.
  test('a relative path and the real path name the folder\'s file; the own space is its real path or vfs://', async () => {
    const { state, project } = roots('cwd-plane-addresses');
    const rt = agentRuntime(state, 'solo', project);
    const space = join(state, 'solo');

    await writeText(rt.storage.vfs, 'notes/one.md', 'one');
    await writeText(rt.toolFiles, 'vfs://home/main/notes/own.md', 'own');

    expect(await readText(rt, 'notes/one.md')).toBe('one');
    expect(await readText(rt, join(project, 'notes/one.md'))).toBe('one');
    expect(await readText(rt, join(space, 'home/main/notes/own.md'))).toBe('own');
    expect(readdirSync(join(project, 'notes'))).toEqual(['one.md']);
    expect(await refusalOf(() => rt.storage.vfs.readdir(`${WORKSPACE_ROOT}/notes`))).toBe('ENOENT');
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

  // Release review, 2026-10-05: a link in the folder or the own space to a directory outside let a write through it land
  // outside unasked, because the reach judged the path as written and node:fs followed the link.
  // Release review, 2026-10-05: listing vfs:// left out local, though vfs://local/x read the folder.
  test('the own space lists the folder as local, and every name for a folder file reads it', async () => {
    const { state, project } = roots('cwd-plane-local');
    writeFileSync(join(project, 'same.txt'), 'one copy');
    const rt = agentRuntime(state, 'solo', project);
    const { file } = agentTools(rt, () => 'deny');

    expect(await file({ action: 'list', path: 'vfs://' })).toMatchObject({ entries: expect.arrayContaining(['local']) });
    expect(await file({ action: 'list', path: 'vfs://local' })).toMatchObject({ entries: expect.arrayContaining(['same.txt']) });

    for (const path of ['local://same.txt', 'vfs://local/same.txt', join(state, 'solo', 'local', 'same.txt')]) {
      expect(await file({ action: 'read', path })).toEqual(expect.stringContaining('one copy'));
    }
  });

  test('a write through a link in the folder or the own space lands where the link points, and is asked there', async () => {
    const { state, project } = roots('cwd-plane-link');
    const outside = join(dirname(project), 'outside');
    mkdirSync(outside);
    const rt = agentRuntime(state, 'solo', project);
    symlinkSync(outside, join(project, 'linked'));
    symlinkSync(outside, join(state, 'solo', 'linked'));
    symlinkSync(join(outside, 'dangling.txt'), join(project, 'dangling'));
    const { file, asked } = agentTools(rt, () => 'deny');
    const landed = realpathSync(outside);

    for (const path of ['local://linked/new.txt', 'vfs://linked/own.txt', 'local://dangling']) {
      await expect(file({ action: 'write', path, content: 'escaped' })).rejects.toMatchObject({ code: 'denied' });
    }

    expect(asked).toEqual([`file write ${join(landed, 'new.txt')}`, `file write ${join(landed, 'own.txt')}`, `file write ${join(landed, 'dangling.txt')}`]);
    expect(readdirSync(outside)).toEqual([]);

    // Removing a link changes only the folder: it is not followed, so it is not asked.
    await rt.toolFiles.unlink('local://linked');
    expect([existsSync(join(project, 'linked')), existsSync(outside)]).toEqual([false, true]);
    expect(asked).toHaveLength(3);
  });

  // Release review, 2026-10-05: the own space's physical spelling of the folder, <space>/local/..., reached the folder
  // through its mount while the approval judged it as the own space, so a write through the folder's link went outside unasked.
  test('every spelling of a path through the folder\'s link is asked where it lands, and a plain one lands in the folder', async () => {
    const { state, project } = roots('cwd-plane-spellings');
    const outside = join(dirname(project), 'outside');
    mkdirSync(outside);
    const rt = agentRuntime(state, 'solo', project);
    const space = join(state, 'solo');
    symlinkSync(outside, join(project, 'linked'));
    const { file, asked } = agentTools(rt, () => 'deny');
    const spellings = ['local://linked/a.txt', 'vfs://local/linked/a.txt', join(space, 'local', 'linked', 'a.txt'), join(project, 'linked', 'a.txt'), 'linked/a.txt'];

    for (const path of spellings) {
      await expect(file({ action: 'write', path, content: 'escaped' })).rejects.toMatchObject({ code: 'denied' });
    }

    expect(asked).toEqual(spellings.map(() => `file write ${join(realpathSync(outside), 'a.txt')}`));
    expect(readdirSync(outside)).toEqual([]);

    await file({ action: 'write', path: join(space, 'local', 'plain.txt'), content: 'in the folder' });
    // `<space>/local` is the folder's link, so the shell follows it as the file tool does.
    expect([readFileSync(join(project, 'plain.txt'), 'utf8'), readlinkSync(join(space, 'local'))]).toEqual(['in the folder', project]);

    await rt.toolFiles.unlink(join(space, 'local', 'linked'));
    expect([existsSync(join(project, 'linked')), existsSync(outside), asked.length]).toEqual([false, true, spellings.length]);
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

  test('a skill in the own space is discovered: the shared Drive this runtime lacks is absent, not an escape', async () => {
    const { state, project } = roots('cwd-plane-skills');
    mkdirSync(join(state, 'solo', 'home', 'main', 'skills'), { recursive: true });
    writeFileSync(join(state, 'solo', 'home', 'main', 'skills', 'review.md'), '---\nname: review\ndescription: Review a change\n---\nName every risk.\n');
    const rt = agentRuntime(state, 'solo', project);

    const found = await discoverSkills(rt.ownFiles, { admissionTokens: 100_000 });

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

  test('a command that can wreck the user\'s files is put to them first', async () => {
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

    // The rules follow what the executor declares it holds: the user's files.
    const declared = present(placed.executionRouter?.getProvider('workspace'), 'the workspace executor').filesOwner;
    expect(reviewCommand('rm -rf ~/x', declared).decision).toBe('gate');
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
  test('SOUL.md, the memory notes and the scaffold are files of main\'s home; the folder holds none of them', async () => {
    const { state, project } = roots('cwd-plane-opened');
    const { rt, info } = await openedWorkspace(state, 'jarvis', project);

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

    const home = join(state, 'jarvis', 'home', 'main');

    expect(readFileSync(join(home, 'memory/MEMORY.md'), 'utf8')).toContain('learned something');
    expect(readFileSync(join(home, 'scaffold/agent.js'), 'utf8')).toBe('// evolved\n');
    expect(readFileSync(join(home, 'SOUL.md'), 'utf8')).toBe(info.soul);
  });
});

describe('the agent\'s own state in a placed workspace', () => {
  // A note changes through the memory tool and a loop through its versioned writer; the file tool only reads them.
  test('the file tool reads the memory notes and the scaffold where they are, and never writes them', async () => {
    const { state, project } = roots('cwd-plane-agent-state');
    const { rt } = await openedWorkspace(state, 'jarvis', project);
    await rt.memory.append('memory/MEMORY.md', '\nlearned something\n');
    await rt.identity.scaffold.write('// evolved\n');
    const home = join(state, 'jarvis', 'home', 'main');

    expect(await readText(rt, join(home, 'memory/MEMORY.md'))).toContain('learned something');
    expect(await nimbusReadText(rt.toolFiles, 'vfs://home/main/scaffold/agent.js')).toBe('// evolved\n');

    expect(await refusalOf(() => writeText(rt.toolFiles, 'vfs://home/main/memory/MEMORY.md', 'forged'))).toBe('EROFS');
    expect(await refusalOf(() => rt.storage.vfs.unlink(join(home, 'scaffold/agent.js')))).toBe('EROFS');
    expect(await refusalOf(() => rt.storage.vfs.mkdir(join(home, 'memory/more'), { recursive: true }))).toBe('EROFS');
    expect(readFileSync(join(home, 'memory/MEMORY.md'), 'utf8')).toContain('learned something');
    expect(readdirSync(project)).toEqual([]);
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

test('a file the agent writes in its folder is named local://', async () => {
  const { state, project } = roots('cwd-plane-reference');

  const write = (rt: CLIRuntime) => {
    const file = buildBuiltinTools({ rt, workMode: 'build', conversations: new ConversationSearchStore(rt.storage.sql, rt.actor, (sessionId) => rt.stores.history.transcript(sessionId)) }).file;

    if (file === undefined) throw new Error('No Build file tool');

    return toolExecute(file)({ action: 'write', path: 'notes/plan.md', content: 'ship it' });
  };

  expect(await write(agentRuntime(state, 'bound', project))).toMatchObject({ ok: true, reference: 'local://notes/plan.md' });
  expect(readFileSync(join(project, 'notes/plan.md'), 'utf8')).toBe('ship it');
});

// 2026-10-04: a folder agent's /home/main and /slates were the project folder itself. The own space is real files
// beside the database (`~/.kinu/<workspace>/`), named vfs:// there as on the cloud; the folder is local://.
test('the agent\'s own space is real files beside its database, and only its work lands in the folder', async () => {
  const { state, project } = roots('cwd-plane-own-space');
  const rt = agentRuntime(state, 'solo', project);
  const space = join(state, 'solo');
  const file = toolExecute(present(buildBuiltinTools({ rt, workMode: 'build', conversations: new ConversationSearchStore(rt.storage.sql, rt.actor, (sessionId) => rt.stores.history.transcript(sessionId)) }).file, 'the file tool'));

  expect(await file({ action: 'write', path: 'vfs://slates/board/index.ts', content: 'board' })).toMatchObject({ reference: 'vfs://slates/board/index.ts' });
  expect(await file({ action: 'write', path: join(space, 'slates/widgets/package.json'), content: '{}' })).toMatchObject({ ok: true });
  expect(await file({ action: 'write', path: 'vfs://home/main/notes.md', content: 'scratch' })).toMatchObject({ ok: true });
  expect(await file({ action: 'write', path: 'src/app.ts', content: 'work' })).toMatchObject({ reference: 'local://src/app.ts' });

  expect(readFileSync(join(space, 'slates/board/index.ts'), 'utf8')).toBe('board');
  expect(readFileSync(join(space, 'slates/widgets/package.json'), 'utf8')).toBe('{}');
  expect(readFileSync(join(space, 'home/main/notes.md'), 'utf8')).toBe('scratch');
  expect(readFileSync(join(project, 'src/app.ts'), 'utf8')).toBe('work');
  expect(readdirSync(project)).toEqual(['src']);
  expect(await file({ action: 'read', path: 'vfs://skills/slates/SKILL.md' })).toContain('slate');
  expect(await file({ action: 'read', path: join(space, 'home/main/notes.md') })).toContain('scratch');
  // The shell is the machine's, and its HOME is the one `~` names.
  expect((await present(rt.shell, 'the shell').exec('echo "$HOME"')).stdout.trim()).toBe(rt.planes.home);
});

// The attachment rung's link (better-compact 0.3.0) names the own space's file, so the agent opens a moved-out
// screenshot again from the folder it works in. The cloud's twin is cf-backend's unit-attachment-links.
test('the file tool shows the agent a screenshot the rung moved out, from the link it left in the own space', async () => {
  const { state, project } = roots('cwd-plane-attachment');
  const rt = agentRuntime(state, 'shots', project);
  const { links } = await compactedScreenshots(rt);
  const file = present(buildBuiltinTools({ rt, conversations: new ConversationSearchStore(rt.storage.sql, rt.actor, (sessionId) => rt.stores.history.transcript(sessionId)) }).file, 'the file tool');
  const read = await toolExecute(file)({ action: 'read', path: links[0] ?? '' });

  expect(links[0]).toStartWith('vfs://home/main/attachments/');
  expect(existsSync(join(state, 'shots', (links[0] ?? '').slice('vfs://'.length)))).toBe(true);
  expect(await present(file.toModelOutput, 'the image output')({ toolCallId: 'reopen', input: {}, output: read })).toEqual({
    type: 'content',
    value: [{ type: 'text', text: `${links[0]}: image/png 1280x800, 40000 bytes` }, { type: 'file', data: { type: 'data', data: screenshot(0) }, mediaType: 'image/png' }],
  });
});

// The notes and the scaffold are real files now, so nothing on the machine's side may reach past their read-only mounts.
describe('main\'s state keeps its writer, whatever path reaches it', () => {
  test('a link in the folder to the memory notes reads them, and a write or removal through it is refused', async () => {
    const { state, project } = roots('cwd-plane-state-link');
    const { rt } = await openedWorkspace(state, 'jarvis', project);
    await rt.memory.append('memory/MEMORY.md', '\nlearned something\n');
    const memory = join(state, 'jarvis', 'home', 'main', 'memory');
    symlinkSync(memory, join(project, 'notes-link'));
    const file = toolExecute(present(buildBuiltinTools({ rt, workMode: 'build', conversations: new ConversationSearchStore(rt.storage.sql, rt.actor, (sessionId) => rt.stores.history.transcript(sessionId)) }).file, 'the file tool'));

    expect(await file({ action: 'read', path: 'notes-link/MEMORY.md' })).toContain('learned something');
    await expect(file({ action: 'write', path: 'notes-link/MEMORY.md', content: 'forged' })).rejects.toThrow('EROFS');
    expect(await refusalOf(() => writeText(rt.storage.vfs, join(project, 'notes-link/MEMORY.md'), 'forged'))).toBe('EROFS');
    expect(await refusalOf(() => rt.storage.vfs.unlink(join(project, 'notes-link/MEMORY.md')))).toBe('EROFS');
    expect(readFileSync(join(memory, 'MEMORY.md'), 'utf8')).toContain('learned something');
  });

  test('removing or moving main\'s home is refused before any of its notes or its scaffold goes', async () => {
    const { state, project } = roots('cwd-plane-state-remove');
    const { rt } = await openedWorkspace(state, 'jarvis', project);
    const home = join(state, 'jarvis', 'home', 'main');

    const plane = present(rt.storage.vfs.removeRecursive && rt.storage.vfs.rename ? rt.storage.vfs : undefined, 'a plane that removes and moves');

    expect(await refusalOf(() => plane.removeRecursive?.(home))).toBe('EBUSY');
    expect(await refusalOf(() => plane.rename?.(join(home, 'memory'), join(project, 'stolen')))).toBe('EBUSY');
    expect(existsSync(join(home, 'memory/MEMORY.md'))).toBe(true);
    expect(existsSync(join(home, 'scaffold/agent.js'))).toBe(true);
  });
});

// Locally a shell edits a note beside the memory tool: a search finds the words the note holds now, and only those.
describe('the memory notes, edited by the shell', () => {
  test('a search finds the new word an edit put in, not the old one, and a removed note leaves no hit', async () => {
    const { state, project } = roots('cwd-plane-memory-journey');
    const { rt } = await openedWorkspace(state, 'jarvis', project);
    const note = join(state, 'jarvis', 'home', 'main', 'memory', 'deploy.md');
    await rt.memory.write('memory/deploy.md', 'wrangler staging deploy succeeded\n');
    await rt.memory.index('memory/deploy.md');
    await rt.memory.write('memory/cache.md', 'redis eviction tuned for staging\n');
    await rt.memory.index('memory/cache.md');
    const shell = present(rt.shell, 'the workspace shell');

    expect((await shell.exec(`printf 'kubernetes ingress now fronts staging\\n' > '${note}'`)).exitCode).toBe(0);
    expect((await rt.memory.search('kubernetes', 5)).map((hit) => hit.path)).toEqual(['memory/deploy.md']);
    expect(await rt.memory.search('wrangler', 5)).toEqual([]);

    expect((await shell.exec(`rm '${note}'`)).exitCode).toBe(0);
    expect(await rt.memory.search('kubernetes', 5)).toEqual([]);
    expect((await rt.memory.search('staging', 1)).map((hit) => hit.path)).toEqual(['memory/cache.md']);
  });
});

describe('SOUL.md is the workspace\'s own file', () => {
  // SOUL.md is a real file of the own space: the agent edits it from its file tool or its shell, and the next turn reads it.
  test('an edit of SOUL.md, by the file tool or the shell, is the soul the next turn reads', async () => {
    const { state, project } = roots('soul-owner');
    const dbPath = join(state, 'jarvis', 'agent.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = published(dbPath);
    await createWorkspace(db, { name: 'jarvis', purpose: 'Test agent jarvis', llm: DUMMY_LLM, home: workspaceHome(db) });
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM, cwd: project });
    expect(soulIn(rt.space)).toContain('Test agent jarvis');

    await writeText(rt.toolFiles, 'vfs://home/main/SOUL.md', '# by the file tool\n');
    expect(soulIn(rt.space)).toBe('# by the file tool\n');
    const shell = await present(rt.shell, 'the workspace shell').exec(`printf '# by the shell\\n' > '${join(rt.space, 'home/main/SOUL.md')}'`);

    expect(shell.exitCode).toBe(0);
    expect(soulIn(rt.space)).toBe('# by the shell\n');
  });

});
