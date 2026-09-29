import { afterEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import * as v from 'valibot';
import { fakeMossaic, git, gitEnv, initRepo, scratchDir } from '@kinu.run/test-utils';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  ChangeSetCache,
  getExecutorDiff,
  getWorkspaceDiff,
  resetWorkspaceBaseline,
  restoreWorkspaceBaseline,
  type WorkspaceBaselines,
  type WorkspaceDiffResult,
} from '../src/read-models/workspace-diff';
import type { ExecutorProvider, ExecutionRouter } from '../src/execution/types';
import { MAX_LINES_PER_FILE } from '../src/vfs/diff';
import { PLATFORM_CATALOG } from '../src/platform-catalog';
import { createTestRuntime } from './helpers';
import { commandResult, type CommandResult } from '../src/execution/exec-result';
import { agentCred, provisionAgentHome, subordinateAgentName } from '../src/vfs/agent-home';
import { withMountTable } from '../src/vfs/mounts';
import type { WorkspaceBundle } from '../src/vfs/nimbus-workspace';
import type { AgentRuntime } from '../src/types/agent-runtime';
import { WORKSPACE_ROOT } from '../src/vfs/workspace-path';
import { createRecordingLogger, setDiagnosticsSink } from '../src/obs/index';
import { mossaicVfs } from '../src/vfs/mossaic-vfs';
import { sharedDriveMount } from '../src/vfs/shared-drive';

/**
 * The workspace's store, read as the session user, as the orchestrator serves Diffs. The test runtime writes its
 * scaffold on its first file call, which a review taken before it would list as the agent's work.
 */
async function baselinesOf(rt: AgentRuntime, workspace: Pick<WorkspaceBundle, 'session'>): Promise<WorkspaceBaselines> {
  await rt.storage.vfs.exists('scaffold/agent.js');

  return { store: (await workspace.session()).vfs, cred: CRED_SESSION_USER };
}

/** The git view never reads the workspace's own change-set. */
async function noWorkspace(): Promise<WorkspaceDiffResult> {
  throw new Error('the git view read the workspace change-set');
}

/** A PNG signature and a NUL byte: binary to the change-set. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

afterEach(() => { setSystemTime(); });

/** One millisecond for a write, a capture and a same-size rewrite, as one request's frozen clock gives them. */
const ONE_MILLISECOND = Date.parse('2026-09-24T00:00:00.000Z');

/** A sandbox executor whose shell is `/bin/sh` in `cwd` (dash here, as the CLI runs it), in the clean git environment:
 *  under a git hook the inherited GIT_DIR points at the developer's checkout. */
function shellIn(cwd: string): ExecutionRouter {
  const provider: ExecutorProvider = {
    name: 'sandbox', kind: 'sandbox', capabilities: new Set(['git']), filesOwner: 'agent',
    homeDir: async () => '/workspace',
    isAvailable: () => true, connect: async () => {}, disconnect: async () => {},
    tools: {
      exec: {
        description: 'test shell',
        execute: async (...args) => {
          const [command] = v.parse(v.tuple([v.string()]), args);
          const result = Bun.spawnSync(['/bin/sh', '-lc', command], { cwd, env: gitEnv(), stdout: 'pipe', stderr: 'pipe' });

          return commandResult({ stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode });
        },
      },
    },
  };

  return {
    register: () => {}, unregister: () => {},
    getProvider: (name) => name === 'sandbox' ? provider : undefined,
    getProviders: () => [], listExecutors: () => [],
  };
}

describe('workspace diff lifecycle', () => {
  test('work completed before the first Output read remains visible', async () => {
    const { rt, workspace } = createTestRuntime();
    const baselines = await baselinesOf(rt, workspace);
    await resetWorkspaceBaseline(rt, baselines);

    await rt.storage.vfs.writeFile('finished-before-output.txt', 'done');
    const result = await getWorkspaceDiff(rt, baselines);

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      path: 'finished-before-output.txt', status: 'added', added: 1, removed: 0,
    });
  });

  test('a Nimbus runtime install and one written file read as exactly one change', async () => {
    const { rt, workspace } = createTestRuntime();
    const baselines = await baselinesOf(rt, workspace);
    await resetWorkspaceBaseline(rt, baselines);

    // The text files `nimbus install python` wrote on kinu.run, 2026-09-23.
    const runtime = '.nimbus/runtimes/cpython/3.13.14';

    for (const path of ['bin/python', 'bin/python3', 'etc/ssl/cert.pem', 'lib/python3.13/os.py', 'LICENSE', 'manifest.json']) {
      await rt.storage.vfs.mkdir(`${runtime}/${path}`.replace(/\/[^/]+$/, ''), { recursive: true });
      await rt.storage.vfs.writeFile(`${runtime}/${path}`, `${path}\n`);
    }

    await rt.storage.vfs.writeFile('hello.py', 'print(42)\n');

    expect((await getWorkspaceDiff(rt, baselines)).files.map((file) => `${file.status} ${file.path}`)).toEqual(['added hello.py']);
  });

  test('a workspace past four hundred files still diffs', async () => {
    // Nimbus's diff examines only the paths written since the review; the workerd complexity subject measures that.
    const { rt, workspace } = createTestRuntime();
    const baselines = await baselinesOf(rt, workspace);
    await rt.storage.vfs.mkdir('s', { recursive: true });

    for (let i = 0; i < 450; i++) await rt.storage.vfs.writeFile(`s/f-${i}.txt`, `line ${i}\n`);
    await resetWorkspaceBaseline(rt, baselines);
    await rt.storage.vfs.writeFile('s/f-7.txt', 'line 7\nchanged\n');

    expect((await getWorkspaceDiff(rt, baselines)).files.map((file) => `${file.status} ${file.path}`)).toEqual(['changed s/f-7.txt']);
  });

  test('a file past one row is listed as changed and large, without a body', async () => {
    const { rt, workspace } = createTestRuntime();
    const baselines = await baselinesOf(rt, workspace);
    const row = PLATFORM_CATALOG['do.sqlite.row_bytes'].limit.value;
    await rt.storage.vfs.writeFile('big.log', 'x'.repeat(row));
    await resetWorkspaceBaseline(rt, baselines);
    await rt.storage.vfs.writeFile('big.log', 'y'.repeat(row + 1));

    expect((await getWorkspaceDiff(rt, baselines)).files).toEqual([
      { path: 'big.log', status: 'changed', added: 0, removed: 0, lines: [], omitted: 'large' },
    ]);
  });

  test('binary files the agent adds, overwrites or deletes are listed as binary; an untouched one is not', async () => {
    const { rt, workspace } = createTestRuntime();
    const baselines = await baselinesOf(rt, workspace);
    await rt.storage.vfs.writeFile('logo.png', PNG);
    await rt.storage.vfs.writeFile('old.png', PNG);
    await rt.storage.vfs.writeFile('notes.txt', 'plain\n');
    await resetWorkspaceBaseline(rt, baselines);
    await rt.storage.vfs.writeFile('chart.png', PNG);
    await rt.storage.vfs.writeFile('notes.txt', PNG);
    await rt.storage.vfs.unlink('old.png');

    expect((await getWorkspaceDiff(rt, baselines)).files).toEqual([
      { path: 'chart.png', status: 'added', added: 0, removed: 0, lines: [], omitted: 'binary' },
      { path: 'notes.txt', status: 'changed', added: 0, removed: 0, lines: [], omitted: 'binary' },
      { path: 'old.png', status: 'removed', added: 0, removed: 0, lines: [], omitted: 'binary' },
    ]);
  });

  test('a binary file whose bytes are unchanged stays off the list when its mtime moves; one with other bytes is on it', async () => {
    const { rt, workspace } = createTestRuntime();
    const baselines = await baselinesOf(rt, workspace);
    await rt.storage.vfs.writeFile('logo.png', PNG);
    await rt.storage.vfs.writeFile('chart.png', PNG);
    await resetWorkspaceBaseline(rt, baselines);
    // Both written again since, a second later: the same bytes for the logo, one more byte for the chart.
    setSystemTime(Date.now() + 1000);
    await rt.storage.vfs.writeFile('logo.png', PNG);
    await rt.storage.vfs.writeFile('chart.png', new Uint8Array([...PNG, 0]));

    expect((await getWorkspaceDiff(rt, baselines)).files).toEqual([
      { path: 'chart.png', status: 'changed', added: 0, removed: 0, lines: [], omitted: 'binary' },
    ]);
  });

  test('a file whose mode alone changed stays off the list; one whose bytes changed is on it', async () => {
    const { rt, workspace } = createTestRuntime();
    const baselines = await baselinesOf(rt, workspace);
    await rt.storage.vfs.writeFile('run.sh', 'echo hi\n');
    await rt.storage.vfs.writeFile('notes.md', 'one\n');
    await resetWorkspaceBaseline(rt, baselines);
    // Nimbus's diff lists a mode change as modified: the change-set compares the bytes.
    (await workspace.session()).vfs.as(CRED_SESSION_USER).chmod(`${WORKSPACE_ROOT}/run.sh`, 0o744);
    await rt.storage.vfs.writeFile('notes.md', 'two\n');

    expect((await getWorkspaceDiff(rt, baselines)).files.map((file) => `${file.status} ${file.path}`)).toEqual(['changed notes.md']);
  });

  test('a same-size rewrite in the millisecond its baseline was captured is read, not trusted', async () => {
    setSystemTime(ONE_MILLISECOND);
    const { rt, workspace } = createTestRuntime();
    const baselines = await baselinesOf(rt, workspace);
    await rt.storage.vfs.writeFile('hello.py', 'print(42)\n');
    await resetWorkspaceBaseline(rt, baselines);
    await rt.storage.vfs.writeFile('hello.py', 'print(43)\n');

    expect((await getWorkspaceDiff(rt, baselines)).files.map((file) => `${file.status} ${file.path}`)).toEqual(['changed hello.py']);
  });

  test('a review re-reads a file rewritten in the previous capture\'s millisecond, so it keeps what the file held', async () => {
    setSystemTime(ONE_MILLISECOND);
    const { rt, workspace } = createTestRuntime();
    const baselines = await baselinesOf(rt, workspace);
    await rt.storage.vfs.writeFile('hello.py', 'print(42)\n');
    await resetWorkspaceBaseline(rt, baselines);
    await rt.storage.vfs.writeFile('hello.py', 'print(43)\n');
    setSystemTime(ONE_MILLISECOND + 1000);
    await resetWorkspaceBaseline(rt, baselines);
    setSystemTime(ONE_MILLISECOND + 2000);
    await rt.storage.vfs.writeFile('hello.py', 'print(42)\n');

    expect((await getWorkspaceDiff(rt, baselines)).files.map((file) => `${file.status} ${file.path}`)).toEqual(['changed hello.py']);
  });

  test('a workspace without a baseline starts tracking at its first read, then shows exactly what it writes', async () => {
    const { rt, workspace } = createTestRuntime();
    const baselines = await baselinesOf(rt, workspace);
    await rt.storage.vfs.writeFile('already-there.txt', 'v1');
    const before = Date.now();

    const first = await getWorkspaceDiff(rt, baselines);

    expect(first.files).toEqual([]);
    expect(first.trackedSince).toBeGreaterThanOrEqual(before);

    await rt.storage.vfs.writeFile('written-after.txt', 'new');
    const second = await getWorkspaceDiff(rt, baselines);

    expect(second.files.map((file) => `${file.status} ${file.path}`)).toEqual(['added written-after.txt']);
    expect(second.trackedSince).toBe(first.trackedSince);
  });

  test('dependency and repository trees are never reviewed', async () => {
    const { rt, workspace } = createTestRuntime();
    const baselines = await baselinesOf(rt, workspace);
    await resetWorkspaceBaseline(rt, baselines);
    await rt.storage.vfs.mkdir('.git', { recursive: true });
    await rt.storage.vfs.mkdir('node_modules/pkg', { recursive: true });
    await rt.storage.vfs.writeFile('.git/object-1', 'metadata');
    await rt.storage.vfs.writeFile('node_modules/pkg/file-1.js', 'dependency');
    await rt.storage.vfs.writeFile('app.ts', 'export const visible = true;');

    expect((await getWorkspaceDiff(rt, baselines)).files.map((file) => `${file.status} ${file.path}`)).toEqual(['added app.ts']);
  });

  test('the change-set is every agent\'s home and the slates: never /usr, /tmp, a mount or platform state', async () => {
    const { rt, workspace } = createTestRuntime();
    const baselines = await baselinesOf(rt, workspace);
    const drive = mossaicVfs(fakeMossaic().tenant('owner'));
    rt.storage.vfs = withMountTable(rt.storage.vfs, [sharedDriveMount(() => drive, () => 'no Drive in this test')]);
    const identity = { uid: 2001, gid: 2001 };
    const home = provisionAgentHome((await workspace.privileged()).root, subordinateAgentName('builder'), identity);
    const session = await workspace.session();
    const builder = session.vfs.as(agentCred(identity));
    const kernel = session.vfs.as(CRED_KERNEL);
    await resetWorkspaceBaseline(rt, baselines);

    await rt.storage.vfs.writeFile('notes.md', 'one\n');
    builder.writeFile(`${home}/draft.md`, 'draft\n');
    builder.writeFile(`${home}/.kinu/context/run.json`, '{}');
    builder.mkdir(`${home}/private`, { mode: 0o700 });
    builder.writeFile(`${home}/private/key`, 'secret');
    builder.mkdir('/slates/board', { recursive: true });
    builder.writeFile('/slates/board/app.tsx', 'export default null;\n');
    await drive.writeFile('/notes.md', 'from the Drive\n');
    kernel.mkdir('/etc/kinu-slate-content', { recursive: true });
    kernel.writeFile('/etc/kinu-slate-content/blob', 'stored');
    kernel.mkdir('/tmp', { recursive: true });
    kernel.writeFile('/tmp/build.log', 'scratch\n');
    kernel.mkdir('/usr/local/lib', { recursive: true });
    kernel.writeFile('/usr/local/lib/tool.py', 'installed\n');

    expect((await getWorkspaceDiff(rt, baselines)).files.map((file) => `${file.status} ${file.path}`)).toEqual([
      `added ${home}/draft.md`, 'added /slates/board/app.tsx', 'added notes.md',
    ]);
  });

  test('hidden files and folders are never reviewed: not in the working directory, a hire\'s home or a slate', async () => {
    const { rt, workspace } = createTestRuntime();
    const baselines = await baselinesOf(rt, workspace);
    const identity = { uid: 2001, gid: 2001 };
    const home = provisionAgentHome((await workspace.privileged()).root, subordinateAgentName('builder'), identity);
    const builder = (await workspace.session()).vfs.as(agentCred(identity));
    await resetWorkspaceBaseline(rt, baselines);

    await rt.storage.vfs.writeFile('.env', 'TOKEN=1\n');
    await rt.storage.vfs.writeFile('notes.md', 'one\n');
    builder.writeFile(`${home}/.bashrc`, 'alias ll=ls\n');
    builder.mkdir(`${home}/.config/tool`, { recursive: true });
    builder.writeFile(`${home}/.config/tool/settings.json`, '{}');
    builder.writeFile(`${home}/draft.md`, 'draft\n');
    builder.mkdir('/slates/board/.build', { recursive: true });
    builder.writeFile('/slates/board/.build/out.js', 'built');
    builder.writeFile('/slates/board/index.html', '<p>board</p>\n');

    expect((await getWorkspaceDiff(rt, baselines)).files.map((file) => `${file.status} ${file.path}`)).toEqual([
      `added ${home}/draft.md`, 'added /slates/board/index.html', 'added notes.md',
    ]);
  });

  test('a symbolic link is listed as itself, its target as its text, and never followed', async () => {
    const { rt, workspace } = createTestRuntime();
    const baselines = await baselinesOf(rt, workspace);
    const identity = { uid: 2001, gid: 2001 };
    const home = provisionAgentHome((await workspace.privileged()).root, subordinateAgentName('builder'), identity);
    const session = await workspace.session();
    const builder = session.vfs.as(agentCred(identity));
    const user = session.vfs.as(CRED_SESSION_USER);
    await rt.storage.vfs.writeFile('notes.md', 'one\n');
    await resetWorkspaceBaseline(rt, baselines);

    await rt.storage.vfs.mkdir('.config', { recursive: true });
    await rt.storage.vfs.writeFile('.config/secret.txt', 'TOKEN=1\n');
    builder.mkdir(`${home}/node_modules/pkg`, { recursive: true });
    builder.writeFile(`${home}/node_modules/pkg/index.js`, 'installed\n');
    user.symlink(`${WORKSPACE_ROOT}/.config`, `${WORKSPACE_ROOT}/cfg`);
    user.symlink(`${home}/node_modules`, `${WORKSPACE_ROOT}/deps`);
    user.symlink(WORKSPACE_ROOT, `${WORKSPACE_ROOT}/loop`);
    user.symlink('notes.md', `${WORKSPACE_ROOT}/alias.md`);

    const listed = (await getWorkspaceDiff(rt, baselines)).files;
    expect(listed.map((file) => `${file.status} ${file.path}: ${file.lines.map((line) => line.text).join('|')}`)).toEqual([
      'added alias.md: notes.md',
      `added cfg: ${WORKSPACE_ROOT}/.config`,
      `added deps: ${home}/node_modules`,
      `added loop: ${WORKSPACE_ROOT}`,
    ]);

    await resetWorkspaceBaseline(rt, baselines);
    await rt.storage.vfs.unlink('alias.md');
    await rt.storage.vfs.writeFile('alias.md', 'notes.md');
    expect((await getWorkspaceDiff(rt, baselines)).files.map((file) => `${file.status} ${file.path}`)).toEqual(['changed alias.md']);
  });

  test('a slates/ folder the working directory holds after the move stays its own', async () => {
    const { rt, workspace } = createTestRuntime();
    const baselines = await baselinesOf(rt, workspace);
    await rt.storage.vfs.mkdir('slates', { recursive: true });
    await rt.storage.vfs.writeFile('slates/todo.md', 'mine\n');
    await resetWorkspaceBaseline(rt, baselines);

    expect((await getWorkspaceDiff(rt, baselines)).files).toEqual([]);
  });

  test('a poll while nothing reviewed moved walks nothing; a write, a shell write, a rename away or a review reads again', async () => {
    const { rt, workspace } = createTestRuntime();
    const baselines = await baselinesOf(rt, workspace);
    const changes = new ChangeSetCache(() => {});
    let delivered = Promise.withResolvers<void>();

    workspace.onFilesChanged((paths) => {
      changes.touched(paths);
      delivered.resolve();
    });
    await rt.storage.vfs.writeFile('notes.md', 'one\n');
    await resetWorkspaceBaseline(rt, baselines);
    let walked = 0;

    const landed = async (write: () => Promise<void>): Promise<void> => {
      delivered = Promise.withResolvers<void>();
      await write();
      await delivered.promise;
    };

    const poll = async (): Promise<{ readonly walked: boolean; readonly listed: string[] }> => {
      walked = 0;

      const listed = (await changes.read(() => {
        walked += 1;

        return getWorkspaceDiff(rt, baselines);
      })).files.map((file) => `${file.status} ${file.path}`);

      return { walked: walked !== 0, listed };
    };

    expect(await poll()).toEqual({ walked: true, listed: [] });
    expect(await poll()).toEqual({ walked: false, listed: [] });
    await landed(() => rt.storage.vfs.writeFile('.cache/state.json', '{}'));
    expect(await poll()).toEqual({ walked: false, listed: [] });
    await landed(() => rt.storage.vfs.writeFile('notes.md', 'two\n'));
    expect(await poll()).toEqual({ walked: true, listed: ['changed notes.md'] });
    await landed(async () => { await workspace.shell.exec('echo from the shell > shell.txt'); });
    expect(await poll()).toEqual({ walked: true, listed: ['changed notes.md', 'added shell.txt'] });
    await landed(() => workspace.vfs.rename(`${WORKSPACE_ROOT}/shell.txt`, '/tmp/shell.txt'));
    expect(await poll()).toEqual({ walked: true, listed: ['changed notes.md'] });
    await resetWorkspaceBaseline(rt, baselines);
    changes.moved();
    expect(await poll()).toEqual({ walked: true, listed: [] });
  });

  test('a move tells the pages once until a read settles, and a write Changes does not review tells nobody', async () => {
    // Unseen, the Changes tab reads only when told. A frame per write, or per read started, would start a walk per
    // write beside the one running.
    const { rt, workspace } = createTestRuntime();
    const baselines = await baselinesOf(rt, workspace);
    // Booting the workspace writes its home and scaffold, which a listener would hear.
    await resetWorkspaceBaseline(rt, baselines);
    let told = 0;
    const changes = new ChangeSetCache(() => { told += 1; });
    let delivered = Promise.withResolvers<void>();

    workspace.onFilesChanged((paths) => {
      changes.touched(paths);
      delivered.resolve();
    });

    const landed = async (write: () => Promise<void>): Promise<void> => {
      delivered = Promise.withResolvers<void>();
      await write();
      await delivered.promise;
    };

    const read = async (): Promise<void> => { await changes.read(() => getWorkspaceDiff(rt, baselines)); };

    await read();
    await landed(() => rt.storage.vfs.writeFile('.cache/state.json', '{}'));
    expect(told).toBe(0);
    await landed(() => rt.storage.vfs.writeFile('notes.md', 'one\n'));
    await landed(() => rt.storage.vfs.writeFile('more.md', 'two\n'));
    expect(told).toBe(1);
    await read();
    await landed(async () => { await workspace.shell.exec('echo from the shell > shell.txt'); });
    expect(told).toBe(2);

    // A write that lands during a walk is told when the walk settles, not beside it.
    let toldMidWalk = -1;

    await changes.read(async () => {
      const result = await getWorkspaceDiff(rt, baselines);
      await landed(() => rt.storage.vfs.writeFile('late.md', 'three\n'));
      toldMidWalk = told;

      return result;
    });
    expect([toldMidWalk, told]).toEqual([2, 3]);
    await read();
    changes.moved();
    expect(told).toBe(4);
  });

  test('an appended log is diffed exactly, however long the file is', async () => {
    const { rt, workspace } = createTestRuntime();
    const baselines = await baselinesOf(rt, workspace);
    // Under the admission gate but far over what whole-file alignment affords; only the differing region is aligned.
    const lines = 8000;
    const before = Array.from({ length: lines }, (_, i) => `${i % 10}`.repeat(9)).join('\n');
    await rt.storage.vfs.writeFile('agent.log', before);
    await resetWorkspaceBaseline(rt, baselines);
    await rt.storage.vfs.writeFile('agent.log', `${before}\nappended`);

    const result = await getWorkspaceDiff(rt, baselines);

    const file = result.files.find((f) => f.path === 'agent.log');

    if (!file) throw new Error('the changed file must appear in the change-set');
    expect(file.status).toBe('changed');
    expect(file.added).toBe(1);
    expect(file.removed).toBe(0);
    expect(file.lines.length).toBe(MAX_LINES_PER_FILE);
    expect(file.truncated).toBe(true);
  });

  test('a wholly rewritten long file is listed with true totals rather than dropped', async () => {
    const { rt, workspace } = createTestRuntime();
    const baselines = await baselinesOf(rt, workspace);
    // No shared head or tail, so the differing region is the whole file and the bound applies.
    const lines = 8000;
    const before = Array.from({ length: lines }, (_, i) => `${i % 10}`.repeat(9)).join('\n');
    const after = Array.from({ length: lines }, (_, i) => `${(i % 10) + 1}`.repeat(9)).join('\n');
    await rt.storage.vfs.writeFile('bundle.min.js', before);
    await resetWorkspaceBaseline(rt, baselines);
    await rt.storage.vfs.writeFile('bundle.min.js', after);

    const result = await getWorkspaceDiff(rt, baselines);

    const file = result.files.find((f) => f.path === 'bundle.min.js');

    if (!file) throw new Error('the oversized file must still appear in the change-set');
    expect(file.status).toBe('changed');
    expect(file.truncated).toBe(true);
    expect(file.lines).toEqual([]);
    // Coarse but true: every line out, every line in.
    expect(file.removed).toBe(lines);
    expect(file.added).toBe(lines);
  });

  test('a failed snapshot publication preserves the prior diff and its Undo target', async () => {
    const { rt, workspace } = createTestRuntime();
    const baselines = await baselinesOf(rt, workspace);
    await rt.storage.vfs.writeFile('notes.md', 'zero');
    await resetWorkspaceBaseline(rt, baselines);
    const first = await getWorkspaceDiff(rt, baselines);
    await rt.storage.vfs.writeFile('notes.md', 'one');
    await resetWorkspaceBaseline(rt, baselines);
    await rt.storage.vfs.writeFile('notes.md', 'two');
    const before = await getWorkspaceDiff(rt, baselines);
    const failure = new Error('snapshot publication refused');
    const snapshot = spyOn(baselines.store, 'snapshot').mockImplementationOnce(() => { throw failure; });

    try {
      await expect(resetWorkspaceBaseline(rt, baselines)).rejects.toBe(failure);
    } finally {
      snapshot.mockRestore();
    }

    expect(await getWorkspaceDiff(rt, baselines)).toEqual(before);
    expect(await restoreWorkspaceBaseline(rt, baselines)).toMatchObject({ ok: true });
    const restored = await getWorkspaceDiff(rt, baselines);
    expect(restored.baseline).toBe(first.baseline);
    expect(restored.files.map((file) => ({ path: file.path, text: file.lines.map((line) => line.text) })))
      .toEqual([{ path: 'notes.md', text: ['zero', 'two'] }]);
    expect(await restoreWorkspaceBaseline(rt, baselines)).toMatchObject({ ok: false });
  });

  test.each(['undo', 'review'] as const)('cleanup failure reports a published review and preserves the next %s', async (next) => {
    const { rt, workspace } = createTestRuntime();
    const baselines = await baselinesOf(rt, workspace);
    const CLOCK = Date.parse('2026-09-28T12:00:00Z');
    setSystemTime(new Date(CLOCK));
    await rt.storage.vfs.writeFile('notes.md', 'zero');
    await resetWorkspaceBaseline(rt, baselines);
    const first = await getWorkspaceDiff(rt, baselines);
    setSystemTime(new Date(CLOCK + 10));
    const staleName = `diffs:${rt.actor.actorId}:${first.baseline}`;
    await rt.storage.vfs.writeFile('notes.md', 'one');
    await resetWorkspaceBaseline(rt, baselines);
    const previous = await getWorkspaceDiff(rt, baselines);
    await rt.storage.vfs.writeFile('notes.md', 'two');
    const priorDiff = await getWorkspaceDiff(rt, baselines);
    const log = createRecordingLogger();
    const restoreLog = setDiagnosticsSink(log);
    const failure = new Error('snapshot cleanup refused');
    const drop = spyOn(baselines.store, 'dropSnapshotAsync').mockRejectedValueOnce(failure);
    setSystemTime(new Date(CLOCK + 20));

    try {
      const result = await resetWorkspaceBaseline(rt, baselines);
      expect(result).toMatchObject({ ok: true, cleanupFailures: [{ snapshot: staleName, code: 'io' }] });
      expect(log.emitted).toContainEqual(expect.objectContaining({
        event: 'workspace.review_cleanup_failed', code: 'io', fields: { snapshot: staleName },
        cause: expect.stringContaining(failure.message),
      }));
    } finally {
      drop.mockRestore();
      restoreLog();
    }

    const published = await getWorkspaceDiff(rt, baselines);
    expect(published.baseline).not.toBe(previous.baseline);
    expect(published.files).toEqual([]);
    expect(baselines.store.snapshots().some((snapshot) => snapshot.name === staleName)).toBe(true);

    if (next === 'undo') {
      expect(await restoreWorkspaceBaseline(rt, baselines)).toMatchObject({ ok: true });
      expect(await getWorkspaceDiff(rt, baselines)).toEqual(priorDiff);
      expect(await restoreWorkspaceBaseline(rt, baselines)).toMatchObject({ ok: false });
    } else {
      setSystemTime(new Date(CLOCK + 30));
      await rt.storage.vfs.writeFile('notes.md', 'three');
      expect(await resetWorkspaceBaseline(rt, baselines)).toMatchObject({ ok: true, cleanupFailures: [] });
      const latest = await getWorkspaceDiff(rt, baselines);
      const retained = baselines.store.snapshots().filter((snapshot) => snapshot.name.startsWith(`diffs:${rt.actor.actorId}:`));
      expect(retained.map((snapshot) => snapshot.name).sort()).toEqual(
        [published.baseline, latest.baseline].map((id) => `diffs:${rt.actor.actorId}:${id}`).sort(),
      );
      expect(await restoreWorkspaceBaseline(rt, baselines)).toMatchObject({ ok: true });
      expect((await getWorkspaceDiff(rt, baselines)).baseline).toBe(published.baseline);
    }
  });

  test('Mark reviewed can be undone once: the changes it cleared come back, measured from the earlier review', async () => {
    const { rt, workspace } = createTestRuntime();
    const baselines = await baselinesOf(rt, workspace);
    const earlier = await resetWorkspaceBaseline(rt, baselines);
    await rt.storage.vfs.writeFile('notes.md', 'one\n');
    // The baseline a note names: a review moves it, and Undo brings it back.
    const noted = (await getWorkspaceDiff(rt, baselines)).baseline;
    await resetWorkspaceBaseline(rt, baselines);
    const reviewed = await getWorkspaceDiff(rt, baselines);

    expect(reviewed.files).toEqual([]);
    expect(reviewed.baseline).not.toBe(noted);
    expect(await restoreWorkspaceBaseline(rt, baselines)).toEqual({ ok: true, capturedAt: earlier.capturedAt });

    const restored = await getWorkspaceDiff(rt, baselines);

    expect(restored.files.map((file) => `${file.status} ${file.path}`)).toEqual(['added notes.md']);
    expect(restored.trackedSince).toBe(earlier.capturedAt);
    expect(restored.baseline).toBe(noted);
    expect(await restoreWorkspaceBaseline(rt, baselines)).toMatchObject({ ok: false });
  });

  test('a failed git subcommand is an Output error, never an empty successful diff', async () => {
    const responses: CommandResult[] = [{ reason: 'io', error: 'Error (exit 128)\nfatal: index corrupt' }];

    const provider: ExecutorProvider = {
      name: 'sandbox', kind: 'sandbox', capabilities: new Set(['git']), filesOwner: 'agent',
      homeDir: async () => '/workspace',
      isAvailable: () => true, connect: async () => {}, disconnect: async () => {},
      tools: {
        exec: {
          description: 'failing git shell',
          execute: async () => responses.shift() ?? '(no output)',
        },
      },
    };

    const router: ExecutionRouter = {
      register: () => {}, unregister: () => {},
      getProvider: (name) => name === 'sandbox' ? provider : undefined,
      getProviders: () => [], listExecutors: () => [],
    };

    const { rt } = createTestRuntime();
    rt.executionRouter = router;

    const result = await getExecutorDiff(rt, 'sandbox', noWorkspace);

    expect(result.files).toEqual([]);
    expect(result.error).toContain('index corrupt');
  });

  test('repeated git diff reads include untracked work without changing the real index, measured from HEAD', async () => {
    const repo = scratchDir('workspace-diff');
    initRepo(repo);
    writeFileSync(join(repo, 'tracked.txt'), 'before\n');
    git(repo, 'add', 'tracked.txt');
    git(repo, 'commit', '-qm', 'seed');
    writeFileSync(join(repo, 'tracked.txt'), 'after\n');
    writeFileSync(join(repo, 'untracked file.txt'), 'new\n');

    const { rt } = createTestRuntime();
    rt.executionRouter = shellIn(repo);
    const before = readFileSync(join(repo, '.git/index'));

    const first = await getExecutorDiff(rt, 'sandbox', noWorkspace);
    const second = await getExecutorDiff(rt, 'sandbox', noWorkspace);
    const after = readFileSync(join(repo, '.git/index'));
    const folder = basename(repo);

    expect(first.files.map((file) => file.path)).toEqual([`${folder}/tracked.txt`, `${folder}/untracked file.txt`]);
    expect(first.repositories).toEqual([folder]);
    expect(first.baseline).toBe(`${folder}@${git(repo, 'rev-parse', 'HEAD').trim()}`);
    expect(second.files).toEqual(first.files);
    expect(after.equals(before)).toBe(true);
  });

  test('the git view lists every repository within reach of the working directory, each under its folder', async () => {
    const cwd = scratchDir('git-view');

    const repository = (at: string, files: Readonly<Record<string, string>>, commit = true): string => {
      const root = join(cwd, at);
      mkdirSync(root, { recursive: true });
      initRepo(root);

      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      }

      if (commit) {
        git(root, 'add', '-A');
        git(root, 'commit', '-qm', 'seed');
      }

      return root;
    };

    const api = repository('api', { 'app.ts': 'one\n', '.gitignore': 'dist/\n' });
    const lib = repository('api/vendor/lib', { 'lib.ts': 'one\n' });
    repository('web', { 'index.html': '<p>web</p>\n' }, false);
    const deep = repository('a/b/c/deep', { 'far.ts': 'one\n' });
    const hidden = repository('.config/tool', { 'settings.json': '{}\n' });
    const installed = repository('node_modules/pkg', { 'index.js': 'one\n' });
    writeFileSync(join(api, 'app.ts'), 'two\n');
    writeFileSync(join(api, 'new.ts'), 'new\n');
    mkdirSync(join(api, 'dist'));
    writeFileSync(join(api, 'dist/bundle.js'), 'built\n');
    writeFileSync(join(lib, 'lib.ts'), 'two\n');

    for (const outside of [deep, hidden, installed]) writeFileSync(join(outside, 'changed.txt'), 'not listed\n');
    mkdirSync(join(cwd, 'notes'));
    writeFileSync(join(cwd, 'notes/todo.md'), 'no repository\n');

    const { rt } = createTestRuntime();
    rt.executionRouter = shellIn(cwd);
    const view = await getExecutorDiff(rt, 'sandbox', noWorkspace);

    expect(view.error).toBeUndefined();
    expect(view.repositories).toEqual(['api', 'api/vendor/lib', 'web']);
    expect(view.files.map((file) => `${file.status} ${file.path}`)).toEqual([
      'changed api/app.ts', 'added api/new.ts', 'changed api/vendor/lib/lib.ts', 'added web/index.html',
    ]);

    rt.executionRouter = shellIn(join(cwd, 'notes'));
    expect(await getExecutorDiff(rt, 'sandbox', noWorkspace)).toEqual({ files: [], mode: 'git', notGitRepo: true });
  });

  test('a working directory inside a repository shows that repository, and the ones below it', async () => {
    const mono = join(scratchDir('git-enclosing'), 'mono');
    mkdirSync(join(mono, 'sub/inner'), { recursive: true });
    initRepo(mono);
    writeFileSync(join(mono, 'root.txt'), 'one\n');
    writeFileSync(join(mono, 'sub/f.txt'), 'one\n');
    git(mono, 'add', '-A');
    git(mono, 'commit', '-qm', 'seed');
    initRepo(join(mono, 'sub/inner'));
    writeFileSync(join(mono, 'root.txt'), 'two\n');
    writeFileSync(join(mono, 'sub/f.txt'), 'two\n');
    writeFileSync(join(mono, 'sub/inner/in.txt'), 'new\n');

    const { rt } = createTestRuntime();
    rt.executionRouter = shellIn(join(mono, 'sub'));
    const view = await getExecutorDiff(rt, 'sandbox', noWorkspace);

    expect(view.error).toBeUndefined();
    expect(view.repositories).toEqual(['mono', 'mono/sub/inner']);
    expect(view.files.map((file) => `${file.status} ${file.path}`)).toEqual([
      'changed mono/root.txt', 'changed mono/sub/f.txt', 'added mono/sub/inner/in.txt',
    ]);
  });

  test('a file name with quotes, spaces, a newline or non-ASCII letters is shown as it is on disk', async () => {
    const cwd = scratchDir('git-names');
    const odd = ['a b.txt', 'naïve.txt', 'qu"o\'te.txt', 'back\\slash.txt', 'tab\there.txt', 'line\nbreak.txt'];
    const repo = join(cwd, 'r');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);

    for (const name of odd) writeFileSync(join(repo, name), 'one\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'seed');

    for (const name of odd) {
      writeFileSync(join(repo, name), 'two\n');
      writeFileSync(join(repo, `new ${name}`), 'new\n');
    }

    const { rt } = createTestRuntime();
    rt.executionRouter = shellIn(cwd);
    const view = await getExecutorDiff(rt, 'sandbox', noWorkspace);

    expect(view.error).toBeUndefined();
    expect(view.files.map((file) => `${file.status} ${file.path} +${String(file.added)}`).sort()).toEqual([
      ...odd.map((name) => `changed r/${name} +1`),
      ...odd.map((name) => `added r/new ${name} +1`),
    ].sort());
  });

  test('a folder name with a newline is one folder, never two phantom repositories', async () => {
    const cwd = scratchDir('git-newline');
    const repo = join(cwd, 'nl\nname', 'r2');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    writeFileSync(join(repo, 'x.txt'), 'new\n');

    const { rt } = createTestRuntime();
    rt.executionRouter = shellIn(cwd);
    const view = await getExecutorDiff(rt, 'sandbox', noWorkspace);

    expect(view.error).toBeUndefined();
    expect(view.repositories).toEqual(['nl\nname/r2']);
    expect(view.files.map((file) => `${file.status} ${file.path}`)).toEqual(['added nl\nname/r2/x.txt']);
  });
});
