import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { git, gitEnv, initRepo, scratchDir } from '@kinu/test-utils';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorkspace } from '../src/identity/create';
import {
  getExecutorDiff,
  getWorkspaceDiff,
  initWorkspaceBaselineTable,
  resetWorkspaceBaseline,
} from '../src/read-models/workspace-diff';
import type { ExecutorProvider, ExecutionRouter } from '../src/execution/types';
import type { SqlValue } from '../src/types/primitives';
import { MAX_LINES_PER_FILE } from '../src/vfs/diff';
import { collectWorkspaceTextFiles, createTestRuntime, makeAgentDatabase } from './helpers';

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

    const files = await collectWorkspaceTextFiles(rt);

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

    const files = await collectWorkspaceTextFiles(rt);

    expect(files['app.ts']).toBe('export const visible = true;');
    expect(Object.keys(files).some((path) => path.startsWith('binary-'))).toBe(false);
  });

  test('the change-set never holds more than one baseline body at a time', async () => {
    const { rt } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    for (let i = 0; i < 20; i++) await rt.storage.vfs.writeFile(`f-${i}.txt`, `v1 ${i}`);
    await resetWorkspaceBaseline(rt);
    await rt.storage.vfs.writeFile('f-7.txt', 'v2 7');

    // The invariant is PEAK RESIDENCY, not total reads: comparing a file against
    // its baseline necessarily reads that baseline, but the bodies must arrive
    // one at a time. The old shape returned every body in ONE array and held it
    // beside the whole workspace map and the diff output — three copies, each up
    // to 400 x 256 KiB = 102.4 MiB, against a ~200 MiB silent-reset wall. So
    // what is measured here is the largest number of bodies any single query
    // result carried.
    //
    // Matched on the query's own text rather than by inspecting row shapes,
    // because `content FROM vfs_baseline` appears in BOTH the per-path read and
    // the batch read it replaced — so the measurement is not silently vacuous
    // against the shape it exists to rule out. The path-list query and the
    // INSERTs do not contain it.
    const sql = rt.storage.sql;
    let baselineRowsRead = 0;
    let peakBodiesInOneResult = 0;
    rt.storage.sql = <T>(query: TemplateStringsArray, ...values: SqlValue[]): T[] => {
      const rows = sql<T>(query, ...values);
      const text = query.join('?');
      if (text.includes('vfs_baseline')) baselineRowsRead += rows.length;
      if (text.includes('content FROM vfs_baseline')) {
        peakBodiesInOneResult = Math.max(peakBodiesInOneResult, rows.length);
      }
      return rows;
    };

    const result = await getWorkspaceDiff(rt);

    expect(result.files.map((f) => f.path)).toEqual(['f-7.txt']);
    // Denominator: the baseline really does hold every file, so a peak of one
    // is a bound and not an empty table.
    expect(baselineRowsRead).toBeGreaterThan(20);
    expect(peakBodiesInOneResult).toBe(1);
  });

  test('an appended log is diffed exactly, however long the file is', async () => {
    const { rt } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    // 8,000 short lines: under the 256 KiB admission gate, far over what a
    // whole-file alignment can afford. Only the differing region is aligned, and
    // an append has none on the baseline side.
    const lines = 8000;
    const before = Array.from({ length: lines }, (_, i) => `${i % 10}`.repeat(9)).join('\n');
    await rt.storage.vfs.writeFile('agent.log', before);
    await resetWorkspaceBaseline(rt);
    await rt.storage.vfs.writeFile('agent.log', `${before}\nappended`);

    const result = await getWorkspaceDiff(rt);

    const file = result.files.find((f) => f.path === 'agent.log');
    if (!file) throw new Error('the changed file must appear in the change-set');
    expect(file.status).toBe('changed');
    expect(file.added).toBe(1);
    expect(file.removed).toBe(0);
    // The body is bounded, and says so.
    expect(file.lines.length).toBe(MAX_LINES_PER_FILE);
    expect(file.truncated).toBe(true);
  });

  test('a wholly rewritten long file is listed with true totals rather than dropped', async () => {
    const { rt } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    // No shared head or tail, so the differing region IS the file and the bound
    // is what stands between this and a table the isolate cannot hold.
    const lines = 8000;
    const before = Array.from({ length: lines }, (_, i) => `${i % 10}`.repeat(9)).join('\n');
    const after = Array.from({ length: lines }, (_, i) => `${(i % 10) + 1}`.repeat(9)).join('\n');
    await rt.storage.vfs.writeFile('bundle.min.js', before);
    await resetWorkspaceBaseline(rt);
    await rt.storage.vfs.writeFile('bundle.min.js', after);

    const result = await getWorkspaceDiff(rt);

    const file = result.files.find((f) => f.path === 'bundle.min.js');
    if (!file) throw new Error('the oversized file must still appear in the change-set');
    expect(file.status).toBe('changed');
    expect(file.truncated).toBe(true);
    expect(file.lines).toEqual([]);
    // Coarse but true: every line out, every line in. Nothing here claims an
    // alignment that was never computed.
    expect(file.removed).toBe(lines);
    expect(file.added).toBe(lines);
  });

  test('failed baseline replacement keeps the previous generation active and reports the error', async () => {
    const { rt, db } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    await rt.storage.vfs.writeFile('old.txt', 'old');
    await resetWorkspaceBaseline(rt);
    await rt.storage.vfs.writeFile('bad.txt', 'bad');
    db.exec(`CREATE TRIGGER reject_bad_baseline BEFORE INSERT ON vfs_baseline
      WHEN NEW.path = 'bad.txt' BEGIN SELECT RAISE(FAIL, 'forced baseline failure'); END`);

    await expect(resetWorkspaceBaseline(rt)).rejects.toThrow('forced baseline failure');
    const rows = db.query<{ path: string; content: string; active: number }, []>(
      "SELECT path, content, active FROM vfs_baseline WHERE path <> ''",
    ).all();
    // The generation that failed is neither active nor left behind, and the
    // previous one still holds the content it was captured with.
    expect(rows.filter((r) => r.path === 'bad.txt')).toEqual([]);
    expect(rows.filter((r) => r.active === 0)).toEqual([]);
    expect(rows.find((r) => r.path === 'old.txt')).toMatchObject({ content: 'old', active: 1 });
  });

  test('a directory traversal failure is surfaced instead of becoming an empty diff', async () => {
    const { rt } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    await rt.storage.vfs.writeFile('kept.txt', 'before');
    await resetWorkspaceBaseline(rt);
    rt.storage.vfs.readdir = async () => {
      throw new Error('authoritative VFS unavailable');
    };

    await expect(getWorkspaceDiff(rt)).rejects.toThrow('could not read directory');
  });

  test('a file read failure cannot advance or partially replace the active baseline', async () => {
    const { rt, db } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    await rt.storage.vfs.writeFile('kept.txt', 'before');
    await resetWorkspaceBaseline(rt);
    await rt.storage.vfs.writeFile('kept.txt', 'after');
    const readFile = rt.storage.vfs.readFile.bind(rt.storage.vfs);
    rt.storage.vfs.readFile = async (path, options) => {
      if (path === 'kept.txt') throw new Error('read interrupted');
      return readFile(path, options);
    };

    await expect(resetWorkspaceBaseline(rt)).rejects.toThrow('could not read "kept.txt"');
    const rows = db.query<{ path: string; content: string; active: number }, []>(
      "SELECT path, content, active FROM vfs_baseline WHERE path <> ''",
    ).all();
    expect(rows.filter((r) => r.active === 0)).toEqual([]);
    // Still the captured content, not the unreadable newer one.
    expect(rows.find((r) => r.path === 'kept.txt')).toMatchObject({ content: 'before', active: 1 });
  });

  test('a failed git subcommand is an Output error, never an empty successful diff', async () => {
    const responses = ['/repo', 'yes', 'Error (exit 128)\nfatal: index corrupt'];
    const provider: ExecutorProvider = {
      name: 'sandbox', kind: 'sandbox', capabilities: new Set(['git']),
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

    const result = await getExecutorDiff(rt, 'sandbox');

    expect(result.files).toEqual([]);
    expect(result.error).toContain('index corrupt');
  });

  test('repeated git diff reads include untracked work without changing the real index', async () => {
    const repo = scratchDir('workspace-diff');
    initRepo(repo);
    writeFileSync(join(repo, 'tracked.txt'), 'before\n');
    git(repo, 'add', 'tracked.txt');
    git(repo, 'commit', '-qm', 'seed');
    writeFileSync(join(repo, 'tracked.txt'), 'after\n');
    writeFileSync(join(repo, 'untracked file.txt'), 'new\n');

    // The shell the executor tool stands in for. It runs `git` too, so it needs
    // the same clean environment: under a git hook the inherited GIT_DIR points
    // the diff at the developer's checkout instead of `repo`.
    const exec = async (command: string): Promise<string> => {
      const result = Bun.spawnSync(['bash', '-lc', command], {
        cwd: repo, env: gitEnv(), stdout: 'pipe', stderr: 'pipe',
      });
      const stdout = result.stdout.toString();
      const stderr = result.stderr.toString();
      if (result.exitCode === 0) return stdout || (stderr ? stderr : '(no output)');
      return `Error (exit ${result.exitCode})${stdout ? `\n--- stdout ---\n${stdout}` : ''}${stderr ? `\n--- stderr ---\n${stderr}` : ''}`;
    };
    const provider: ExecutorProvider = {
      name: 'sandbox', kind: 'sandbox', capabilities: new Set(['git']),
      homeDir: async () => '/workspace',
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
