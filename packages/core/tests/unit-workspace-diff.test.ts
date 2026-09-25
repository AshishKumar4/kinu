import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { git, gitEnv, initRepo, scratchDir } from '@kinu.run/test-utils';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorkspace } from '../src/identity/create';
import {
  getExecutorDiff,
  getWorkspaceDiff,
  initWorkspaceBaselineTable,
  resetWorkspaceBaseline,
  restoreWorkspaceBaseline,
} from '../src/read-models/workspace-diff';
import type { ExecutorProvider, ExecutionRouter } from '../src/execution/types';
import type { SqlValue } from '../src/types/primitives';
import { MAX_LINES_PER_FILE } from '../src/vfs/diff';
import { PLATFORM_CATALOG } from '../src/platform-catalog';
import { createTestRuntime } from './helpers';
import { commandResult, type CommandResult } from '../src/execution/exec-result';

const TEST_LLM = { name: 'test', baseURL: 'http://localhost:0', headers: {}, model: 'test-model' };

/** A PNG signature and a NUL byte: binary to the change-set. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

afterEach(() => { setSystemTime(); });

/** One millisecond for a write, a capture and a same-size rewrite, as one request's frozen clock gives them. */
const ONE_MILLISECOND = Date.parse('2026-09-24T00:00:00.000Z');

describe('workspace diff lifecycle', () => {
  test('workspace birth captures seed files before any agent work', async () => {
    const db = new Database(':memory:');

    const rt = await createWorkspace(db, {
      name: 'atlas', purpose: 'Test output lifecycle.', llm: TEST_LLM,
    });

    expect((await getWorkspaceDiff(rt)).files).toEqual([]);

    const baseline = db.query<{ path: string }, []>(
      "SELECT path FROM vfs_baseline_manifest WHERE active = 1 AND path <> '' ORDER BY path",
    ).all().map((row) => row.path);

    expect(baseline).toContain('scaffold/agent.js.v0');
  });

  test('work completed before the first Output read remains visible', async () => {
    const { rt } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    await rt.storage.vfs.exists('scaffold/agent.js');
    await resetWorkspaceBaseline(rt);

    await rt.storage.vfs.writeFile('finished-before-output.txt', 'done');
    const result = await getWorkspaceDiff(rt);

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      path: 'finished-before-output.txt', status: 'added', added: 1, removed: 0,
    });
  });

  test('a Nimbus runtime install and one written file read as exactly one change', async () => {
    const { rt } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    await rt.storage.vfs.exists('scaffold/agent.js');
    await resetWorkspaceBaseline(rt);

    // The text files `nimbus install python` wrote on kinu.run, 2026-09-23.
    const runtime = '.nimbus/runtimes/cpython/3.13.14';

    for (const path of ['bin/python', 'bin/python3', 'etc/ssl/cert.pem', 'lib/python3.13/os.py', 'LICENSE', 'manifest.json']) {
      await rt.storage.vfs.mkdir(`${runtime}/${path}`.replace(/\/[^/]+$/, ''), { recursive: true });
      await rt.storage.vfs.writeFile(`${runtime}/${path}`, `${path}\n`);
    }

    await rt.storage.vfs.writeFile('hello.py', 'print(42)\n');

    expect((await getWorkspaceDiff(rt)).files.map((file) => `${file.status} ${file.path}`)).toEqual(['added hello.py']);
  });

  test('a workspace past four hundred files still diffs, reading only the file that moved', async () => {
    // Written, reviewed and rewritten in three requests: a file written in the review's own millisecond is read again.
    setSystemTime(ONE_MILLISECOND);
    const { rt } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    await rt.storage.vfs.mkdir('s', { recursive: true });

    for (let i = 0; i < 450; i++) await rt.storage.vfs.writeFile(`s/f-${i}.txt`, `line ${i}\n`);
    setSystemTime(ONE_MILLISECOND + 1000);
    await resetWorkspaceBaseline(rt);
    setSystemTime(ONE_MILLISECOND + 2000);
    await rt.storage.vfs.writeFile('s/f-7.txt', 'line 7\nchanged\n');
    const readFile = rt.storage.vfs.readFile.bind(rt.storage.vfs);
    const read: string[] = [];

    rt.storage.vfs.readFile = async (path, options) => {
      read.push(path);

      return readFile(path, options);
    };

    expect((await getWorkspaceDiff(rt)).files.map((file) => `${file.status} ${file.path}`)).toEqual(['changed s/f-7.txt']);
    expect(read).toEqual(['s/f-7.txt']);
  });

  test('a file past one row is listed as changed and large, without a body', async () => {
    const { rt } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    const row = PLATFORM_CATALOG['do.sqlite.row_bytes'].limit.value;
    await rt.storage.vfs.writeFile('big.log', 'x'.repeat(row));
    await resetWorkspaceBaseline(rt);
    await rt.storage.vfs.writeFile('big.log', 'y'.repeat(row + 1));

    expect((await getWorkspaceDiff(rt)).files).toEqual([
      { path: 'big.log', status: 'changed', added: 0, removed: 0, lines: [], omitted: 'large' },
    ]);
  });

  test('binary files the agent adds, overwrites or deletes are listed as binary; an untouched one is not', async () => {
    const { rt } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    await rt.storage.vfs.writeFile('logo.png', PNG);
    await rt.storage.vfs.writeFile('old.png', PNG);
    await rt.storage.vfs.writeFile('notes.txt', 'plain\n');
    await resetWorkspaceBaseline(rt);
    await rt.storage.vfs.writeFile('chart.png', PNG);
    await rt.storage.vfs.writeFile('notes.txt', PNG);
    await rt.storage.vfs.unlink('old.png');

    expect((await getWorkspaceDiff(rt)).files).toEqual([
      { path: 'chart.png', status: 'added', added: 0, removed: 0, lines: [], omitted: 'binary' },
      { path: 'notes.txt', status: 'changed', added: 0, removed: 0, lines: [], omitted: 'binary' },
      { path: 'old.png', status: 'removed', added: 0, removed: 0, lines: [], omitted: 'binary' },
    ]);
  });

  test('a binary file whose bytes are unchanged stays off the list when its mtime moves; one with other bytes is on it', async () => {
    const { rt, db } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    await rt.storage.vfs.writeFile('logo.png', PNG);
    await rt.storage.vfs.writeFile('chart.png', PNG);
    await resetWorkspaceBaseline(rt);
    // Both written again since: the same bytes for the logo, one more byte for the chart.
    db.exec(`UPDATE vfs_baseline_manifest SET mtime_ms = mtime_ms - 1000 WHERE path <> ''`);
    await rt.storage.vfs.writeFile('chart.png', new Uint8Array([...PNG, 0]));

    expect((await getWorkspaceDiff(rt)).files).toEqual([
      { path: 'chart.png', status: 'changed', added: 0, removed: 0, lines: [], omitted: 'binary' },
    ]);
  });

  test('a baseline captured before binary files were listed shows them as added until the next review, and loses nothing', async () => {
    const { rt, db } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    await rt.storage.vfs.writeFile('logo.png', PNG);
    await rt.storage.vfs.writeFile('hello.py', 'print(42)\n');
    await resetWorkspaceBaseline(rt);
    // What that capture wrote: no generation row, and no row for a binary file.
    db.exec('DELETE FROM vfs_baseline_generation');
    db.exec(`DELETE FROM vfs_baseline_manifest WHERE path = 'logo.png'`);
    await rt.storage.vfs.writeFile('hello.py', 'print(43)\n');

    const listed = async (): Promise<string[]> => (await getWorkspaceDiff(rt)).files.map((file) => `${file.status} ${file.path}`);

    expect(await listed()).toEqual(['changed hello.py', 'added logo.png']);
    await resetWorkspaceBaseline(rt);
    expect(await listed()).toEqual([]);
    expect(restoreWorkspaceBaseline(rt)).toMatchObject({ ok: true });
    expect(await listed()).toEqual(['changed hello.py', 'added logo.png']);
  });

  test('a same-size rewrite in the millisecond its baseline was captured is read, not trusted', async () => {
    setSystemTime(ONE_MILLISECOND);
    const { rt } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    await rt.storage.vfs.writeFile('hello.py', 'print(42)\n');
    await resetWorkspaceBaseline(rt);
    await rt.storage.vfs.writeFile('hello.py', 'print(43)\n');

    expect((await getWorkspaceDiff(rt)).files.map((file) => `${file.status} ${file.path}`)).toEqual(['changed hello.py']);
  });

  test('a review re-reads a file rewritten in the previous capture\'s millisecond, so it keeps what the file held', async () => {
    setSystemTime(ONE_MILLISECOND);
    const { rt } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    await rt.storage.vfs.writeFile('hello.py', 'print(42)\n');
    await resetWorkspaceBaseline(rt);
    await rt.storage.vfs.writeFile('hello.py', 'print(43)\n');
    setSystemTime(ONE_MILLISECOND + 1000);
    await resetWorkspaceBaseline(rt);
    setSystemTime(ONE_MILLISECOND + 2000);
    await rt.storage.vfs.writeFile('hello.py', 'print(42)\n');

    expect((await getWorkspaceDiff(rt)).files.map((file) => `${file.status} ${file.path}`)).toEqual(['changed hello.py']);
  });

  test('a workspace without a baseline starts tracking at its first read, then shows exactly what it writes', async () => {
    const { rt } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    await rt.storage.vfs.exists('scaffold/agent.js');
    await rt.storage.vfs.writeFile('already-there.txt', 'v1');
    const before = Date.now();

    const first = await getWorkspaceDiff(rt);

    expect(first.files).toEqual([]);
    expect(first.trackedSince).toBeGreaterThanOrEqual(before);

    await rt.storage.vfs.writeFile('written-after.txt', 'new');
    const second = await getWorkspaceDiff(rt);

    expect(second.files.map((file) => `${file.status} ${file.path}`)).toEqual(['added written-after.txt']);
    expect(second.trackedSince).toBe(first.trackedSince);
  });

  test('dependency and repository trees are never reviewed', async () => {
    const { rt } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    await resetWorkspaceBaseline(rt);
    await rt.storage.vfs.mkdir('.git', { recursive: true });
    await rt.storage.vfs.mkdir('node_modules/pkg', { recursive: true });
    await rt.storage.vfs.writeFile('.git/object-1', 'metadata');
    await rt.storage.vfs.writeFile('node_modules/pkg/file-1.js', 'dependency');
    await rt.storage.vfs.writeFile('app.ts', 'export const visible = true;');

    expect((await getWorkspaceDiff(rt)).files.map((file) => `${file.status} ${file.path}`)).toEqual(['added app.ts']);
  });

  test('the change-set never holds more than one baseline body at a time', async () => {
    const { rt } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);

    for (let i = 0; i < 20; i++) await rt.storage.vfs.writeFile(`f-${i}.txt`, `v1 ${i}`);
    await resetWorkspaceBaseline(rt);
    await rt.storage.vfs.writeFile('f-7.txt', 'v2 7');

    // The invariant is peak residency: baseline bodies must arrive one at a time.
    const sql = rt.storage.sql;
    let baselineRowsRead = 0;
    let peakBodiesInOneResult = 0;
    rt.storage.sql = <T>(query: TemplateStringsArray, ...values: SqlValue[]): T[] => {
      const rows = sql<T>(query, ...values);
      const text = query.join('?');

      if (text.includes('vfs_baseline_manifest')) baselineRowsRead += rows.length;

      if (text.includes('content FROM vfs_baseline_blob')) {
        peakBodiesInOneResult = Math.max(peakBodiesInOneResult, rows.length);
      }

      return rows;
    };

    const result = await getWorkspaceDiff(rt);

    expect(result.files.map((f) => f.path)).toEqual(['f-7.txt']);
    // Denominator: the baseline holds every file, so a peak of one is a real bound.
    expect(baselineRowsRead).toBeGreaterThan(20);
    expect(peakBodiesInOneResult).toBe(1);
  });

  test('an appended log is diffed exactly, however long the file is', async () => {
    const { rt } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    // Under the admission gate but far over what whole-file alignment affords; only the differing region is aligned.
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
    expect(file.lines.length).toBe(MAX_LINES_PER_FILE);
    expect(file.truncated).toBe(true);
  });

  test('a wholly rewritten long file is listed with true totals rather than dropped', async () => {
    const { rt } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    // No shared head or tail, so the differing region is the whole file and the bound applies.
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
    // Coarse but true: every line out, every line in.
    expect(file.removed).toBe(lines);
    expect(file.added).toBe(lines);
  });

  test('failed baseline replacement keeps the previous generation active and reports the error', async () => {
    const { rt, db } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    await rt.storage.vfs.writeFile('old.txt', 'old');
    await resetWorkspaceBaseline(rt);
    await rt.storage.vfs.writeFile('bad.txt', 'bad');
    db.exec(`CREATE TRIGGER reject_bad_baseline BEFORE INSERT ON vfs_baseline_manifest
      WHEN NEW.path = 'bad.txt' BEGIN SELECT RAISE(FAIL, 'forced baseline failure'); END`);

    await expect(resetWorkspaceBaseline(rt)).rejects.toThrow('forced baseline failure');

    const rows = db.query<{ path: string; content: string; active: number }, []>(
      `SELECT m.path, b.content, m.active FROM vfs_baseline_manifest m
        LEFT JOIN vfs_baseline_blob b ON b.hash = m.hash WHERE m.path <> ''`,
    ).all();

    // The failed generation is neither active nor left behind; the previous one keeps its content.
    expect(rows.filter((r) => r.path === 'bad.txt')).toEqual([]);
    expect(rows.filter((r) => r.active === 0)).toEqual([]);
    expect(rows.find((r) => r.path === 'old.txt')).toMatchObject({ content: 'old', active: 1 });
  });

  test('Mark reviewed can be undone once: the changes it cleared come back, measured from the earlier review', async () => {
    const { rt } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    const earlier = await resetWorkspaceBaseline(rt);
    await rt.storage.vfs.writeFile('notes.md', 'one\n');
    // The baseline a note names: a review moves it, and Undo brings it back.
    const noted = (await getWorkspaceDiff(rt)).baseline;
    await resetWorkspaceBaseline(rt);
    const reviewed = await getWorkspaceDiff(rt);

    expect(reviewed.files).toEqual([]);
    expect(reviewed.baseline).not.toBe(noted);
    expect(restoreWorkspaceBaseline(rt)).toEqual({ ok: true, capturedAt: earlier.capturedAt });

    const restored = await getWorkspaceDiff(rt);

    expect(restored.files.map((file) => `${file.status} ${file.path}`)).toEqual(['added notes.md']);
    expect(restored.trackedSince).toBe(earlier.capturedAt);
    expect(restored.baseline).toBe(noted);
    expect(restoreWorkspaceBaseline(rt)).toMatchObject({ ok: false });
  });

  test('a review that fails leaves the one before it undoable, and keeps no older generation', async () => {
    const { rt, db } = createTestRuntime();
    initWorkspaceBaselineTable(rt.storage.execRaw);
    await rt.storage.vfs.writeFile('old.txt', 'old');
    await resetWorkspaceBaseline(rt);
    await resetWorkspaceBaseline(rt);
    await rt.storage.vfs.writeFile('between.txt', 'between');
    await resetWorkspaceBaseline(rt);
    await rt.storage.vfs.writeFile('bad.txt', 'bad');
    db.exec(`CREATE TRIGGER reject_bad_baseline BEFORE INSERT ON vfs_baseline_manifest
      WHEN NEW.path = 'bad.txt' BEGIN SELECT RAISE(FAIL, 'forced baseline failure'); END`);

    await expect(resetWorkspaceBaseline(rt)).rejects.toThrow('forced baseline failure');

    const generations = db.query<{ generations: number }, []>('SELECT COUNT(DISTINCT generation) AS generations FROM vfs_baseline_manifest').get();

    expect(generations).toEqual({ generations: 2 });
    expect(restoreWorkspaceBaseline(rt)).toMatchObject({ ok: true });
    expect((await getWorkspaceDiff(rt)).files.map((file) => `${file.status} ${file.path}`)).toEqual(['added bad.txt', 'added between.txt']);
    expect(restoreWorkspaceBaseline(rt)).toMatchObject({ ok: false });
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
      `SELECT m.path, b.content, m.active FROM vfs_baseline_manifest m
        LEFT JOIN vfs_baseline_blob b ON b.hash = m.hash WHERE m.path <> ''`,
    ).all();

    expect(rows.filter((r) => r.active === 0)).toEqual([]);
    expect(rows.find((r) => r.path === 'kept.txt')).toMatchObject({ content: 'before', active: 1 });
  });

  test('a failed git subcommand is an Output error, never an empty successful diff', async () => {
    const responses: CommandResult[] = ['/repo', '3f2a1c0b9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b', { reason: 'io', error: 'Error (exit 128)\nfatal: index corrupt' }];

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

  test('repeated git diff reads include untracked work without changing the real index, measured from HEAD', async () => {
    const repo = scratchDir('workspace-diff');
    initRepo(repo);
    writeFileSync(join(repo, 'tracked.txt'), 'before\n');
    git(repo, 'add', 'tracked.txt');
    git(repo, 'commit', '-qm', 'seed');
    writeFileSync(join(repo, 'tracked.txt'), 'after\n');
    writeFileSync(join(repo, 'untracked file.txt'), 'new\n');

    // Needs the clean git environment: under a git hook the inherited GIT_DIR points at the developer's checkout.
    const exec = async (command: string): Promise<CommandResult> => {
      const result = Bun.spawnSync(['bash', '-lc', command], {
        cwd: repo, env: gitEnv(), stdout: 'pipe', stderr: 'pipe',
      });

      return commandResult({ stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode });
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
    expect(first.baseline).toBe(git(repo, 'rev-parse', 'HEAD').trim());
    expect(second.files).toEqual(first.files);
    expect(after.equals(before)).toBe(true);
  });
});
