import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspace } from '../src/identity/create.js';
import {
  captureWorkspaceBaseline,
  getExecutorDiff,
  getWorkspaceDiff,
  initWorkspaceBaselineTable,
  readWorkspaceFiles,
  resetWorkspaceBaseline,
} from '../src/read-models/workspace-diff.js';
import type { ExecutorProvider, ExecutionRouter } from '../src/execution/types.js';
import { createTestRuntime, makeAgentDatabase } from './helpers.js';

const TEST_LLM = { name: 'test', baseURL: 'http://localhost:0', headers: {}, model: 'test-model' };

describe('workspace diff lifecycle', () => {
  test('workspace birth captures seed files before any agent work', async () => {
    const db = new Database(':memory:');
    const rt = await createWorkspace(makeAgentDatabase(db), {
      name: 'atlas', purpose: 'Test output lifecycle.', llm: TEST_LLM,
    });

    expect((await getWorkspaceDiff(rt)).files).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS count FROM vfs_baseline WHERE active = 1 AND path <> ''").get()).toEqual({ count: 4 });
  });

  test('work completed before the first Output read remains visible', async () => {
    const { rt } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    await rt.storage.vfs.exists('scaffold/agent.js');
    await resetWorkspaceBaseline(rt);

    await rt.storage.vfs.writeFile('finished-before-output.txt', 'done');
    const result = await getWorkspaceDiff(rt);

    expect(result.baselineJustCaptured).toBe(false);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      path: 'finished-before-output.txt', status: 'added', added: 1, removed: 0,
    });
  });

  test('an intentionally empty baseline is stable and reads never move it', async () => {
    const { rt } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    await rt.storage.vfs.exists('scaffold/agent.js');
    await rt.storage.vfs.writeFile('already-there.txt', 'v1');

    const first = await getWorkspaceDiff(rt);
    const second = await getWorkspaceDiff(rt);

    expect(first.files.map((file) => file.path)).toContain('already-there.txt');
    expect(second.files).toEqual(first.files);
  });

  test('dependency and repository metadata cannot consume the snapshot file budget', async () => {
    const { rt } = createTestRuntime();
    await rt.storage.vfs.mkdir('.git', { recursive: true });
    await rt.storage.vfs.mkdir('node_modules/pkg', { recursive: true });
    for (let i = 0; i < 401; i++) {
      await rt.storage.vfs.writeFile(`.git/object-${i}`, 'metadata');
      await rt.storage.vfs.writeFile(`node_modules/pkg/file-${i}.js`, 'dependency');
    }
    await rt.storage.vfs.writeFile('app.ts', 'export const visible = true;');

    const files = await readWorkspaceFiles(rt);

    expect(files['app.ts']).toBe('export const visible = true;');
    expect(Object.keys(files).some((path) => path.startsWith('.git/'))).toBe(false);
    expect(Object.keys(files).some((path) => path.startsWith('node_modules/'))).toBe(false);
  });

  test('excluded binary and oversized files cannot consume the text snapshot budget', async () => {
    const { rt } = createTestRuntime();
    for (let i = 0; i < 401; i++) {
      await rt.storage.vfs.writeFile(`binary-${i}.dat`, new Uint8Array([0, i % 255]));
    }
    await rt.storage.vfs.writeFile('app.ts', 'export const visible = true;');

    const files = await readWorkspaceFiles(rt);

    expect(files['app.ts']).toBe('export const visible = true;');
    expect(Object.keys(files).some((path) => path.startsWith('binary-'))).toBe(false);
  });

  test('failed baseline replacement keeps the previous generation active and reports the error', () => {
    const { rt, db } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    captureWorkspaceBaseline(rt, { 'old.txt': 'old' });
    db.exec(`CREATE TRIGGER reject_bad_baseline BEFORE INSERT ON vfs_baseline
      WHEN NEW.path = 'bad.txt' BEGIN SELECT RAISE(FAIL, 'forced baseline failure'); END`);

    expect(() => captureWorkspaceBaseline(rt, { 'good.txt': 'good', 'bad.txt': 'bad' })).toThrow('forced baseline failure');
    const active = db.query("SELECT path, content FROM vfs_baseline WHERE active = 1 AND path <> ''").all();
    expect(active).toEqual([{ path: 'old.txt', content: 'old' }]);
  });

  test('a directory traversal failure is surfaced instead of becoming an empty diff', async () => {
    const { rt } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    captureWorkspaceBaseline(rt, { 'kept.txt': 'before' });
    rt.storage.vfs.readdir = async () => {
      throw new Error('authoritative VFS unavailable');
    };

    await expect(getWorkspaceDiff(rt)).rejects.toThrow('could not read directory');
  });

  test('a file read failure cannot advance or partially replace the active baseline', async () => {
    const { rt, db } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    captureWorkspaceBaseline(rt, { 'kept.txt': 'before' });
    await rt.storage.vfs.writeFile('kept.txt', 'after');
    const readFile = rt.storage.vfs.readFile.bind(rt.storage.vfs);
    rt.storage.vfs.readFile = async (path, options) => {
      if (path === 'kept.txt') throw new Error('read interrupted');
      return readFile(path, options);
    };

    await expect(resetWorkspaceBaseline(rt)).rejects.toThrow('could not read "kept.txt"');
    const active = db.query("SELECT path, content FROM vfs_baseline WHERE active = 1 AND path <> ''").all();
    expect(active).toEqual([{ path: 'kept.txt', content: 'before' }]);
  });

  test('a failed git subcommand is an Output error, never an empty successful diff', async () => {
    const responses = ['/repo', 'yes', 'Error (exit 128)\nfatal: index corrupt'];
    const provider: ExecutorProvider = {
      name: 'sandbox', kind: 'sandbox', capabilities: new Set(['git']),
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

    const result = await getExecutorDiff(rt, 'sandbox');

    expect(result.files).toEqual([]);
    expect(result.error).toContain('index corrupt');
  });

  test('repeated git diff reads include untracked work without changing the real index', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'proteus-output-diff-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'proteus@example.invalid'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Proteus Test'], { cwd: repo });
    writeFileSync(join(repo, 'tracked.txt'), 'before\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: repo });
    writeFileSync(join(repo, 'tracked.txt'), 'after\n');
    writeFileSync(join(repo, 'untracked file.txt'), 'new\n');

    const exec = async (command: string): Promise<string> => {
      const result = Bun.spawnSync(['bash', '-lc', command], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
      const stdout = result.stdout.toString();
      const stderr = result.stderr.toString();
      if (result.exitCode === 0) return stdout || (stderr ? stderr : '(no output)');
      return `Error (exit ${result.exitCode})${stdout ? `\n--- stdout ---\n${stdout}` : ''}${stderr ? `\n--- stderr ---\n${stderr}` : ''}`;
    };
    const provider: ExecutorProvider = {
      name: 'sandbox', kind: 'sandbox', capabilities: new Set(['git']),
      isAvailable: () => true, connect: async () => {}, disconnect: async () => {},
      tools: {
        exec: {
          description: 'test shell',
          execute: async (...args) => {
            const [command] = v.parse(v.tuple([v.string()]), args);
            return exec(command);
          },
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
    const before = readFileSync(join(repo, '.git/index'));

    const first = await getExecutorDiff(rt, 'sandbox');
    const second = await getExecutorDiff(rt, 'sandbox');
    const after = readFileSync(join(repo, '.git/index'));

    expect(first.files.map((file) => file.path)).toEqual(['tracked.txt', 'untracked file.txt']);
    expect(second.files).toEqual(first.files);
    expect(after.equals(before)).toBe(true);
  });
});
