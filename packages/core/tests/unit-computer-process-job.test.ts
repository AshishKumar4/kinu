/**
 * A process the computer's `startProcess` starts is a job of the actor's from its start, as the workspace's is (Main's
 * decision, 2026-10-20): its spec names the job and its variables carry the job's id, its end as the box tells it
 * completes the job and wakes the agent, and one no job took is stopped.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  BackgroundJobRunner, BackgroundJobStore, createSandboxExecutor, initBackgroundJobsTable, JOB_STAMP_ENV, MAX_CONCURRENT_DETACHED_JOBS,
  WORKSPACE_ROOT, ComputerProcessEnds, jobState, type ExecutorProviderSurface, type SandboxHandle,
} from '../src/index';
import { executorNamespace, routedByCwd } from '../src/tools/executor-operations';
import { serveFile } from '../src/tools/file-operations';
import { hostedToolFiles } from '../src/execution/approval';
import { standardMounts, withMountTable } from '../src/vfs/mounts';
import { cloudPlanes } from '../src/vfs/resolve';
import { TurnFileLedger } from '../src/vfs/file-ledger';
import { TurnContextBudget } from '../src/context-budget';
import { createMemoryVfs, seedFiles } from '@kinu.run/test-utils/vfs';
import type { ProgrammaticTurn } from '../src/types/backend-host';
import type { Schedule } from '../src/types/primitives';
import { createTestActors, hostDeliveries } from '@kinu.run/test-utils';
import { makeExecRaw, makeSql } from './helpers';
import { sandboxHandleLifecycle } from './helpers/sandbox-handle-lifecycle';

/** The actor's jobs over its own database, their fibers run inline, their wakes the turns they queue. */
function actorJobs() {
  const db = new Database(':memory:');
  initBackgroundJobsTable(makeExecRaw(db));
  const sql = makeSql(db);
  const store = new BackgroundJobStore(sql, createTestActors(sql, makeExecRaw(db)).main);
  const runs: Promise<unknown>[] = [];
  const woke: ProgrammaticTurn[] = [];

  const fiber: Schedule['fiber'] = async (_name, fn) => {
    const run = fn({ stash: () => {}, snapshot: null });
    runs.push(run);

    return await run;
  };

  const host = {
    broadcast: () => {},
    enqueueTurn: async (turn: ProgrammaticTurn) => {
      woke.push(turn);

      return { status: 'queued' as const };
    },
  };

  return { runner: new BackgroundJobRunner({ store, fiber, inbox: hostDeliveries(host).signals }), store, woke, settled: () => Promise.all(runs) };
}

/**
 * A computer whose box starts one process, and the workspace's register its end is told to, as the box's heartbeat tells
 * it (`ComputerProcessEnds`, over the actor's own job rows). `runs`: the job an earlier start of the same command still
 * runs as, which the box answers.
 */
function computerBox(jobs: ReturnType<typeof actorJobs>, runs?: string) {
  const starts: { command: string; job: string | undefined; stamp: string | undefined }[] = [];
  const stopped: string[] = [];

  const ends = new ComputerProcessEnds({
    state: (jobId) => jobState(jobs.store.get(jobId)?.status),
    complete: (jobId, end) => jobs.runner.complete(jobId, { processId: 'proc-dev', ...end }),
  });

  const handle: SandboxHandle = {
    ...sandboxHandleLifecycle,
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    startSupervisedProcess: async (command, opts) => {
      starts.push({ command, job: opts?.job, stamp: opts?.env?.[JOB_STAMP_ENV] });

      return { processId: 'proc-dev', ...((runs ?? opts?.job) !== undefined && { job: runs ?? opts?.job }) };
    },
    stopSupervisedProcess: async (processId) => {
      stopped.push(processId);

      return { stopped: true };
    },
    readFile: async () => ({}), writeFile: async () => {}, listFiles: async () => ({ files: [] }), deleteFile: async () => {},
    exposePort: async (port) => ({ url: `https://preview.example.com/${String(port)}`, port, route: { reached: true } }),
    unexposePort: async () => {}, getExposedPorts: async () => [],
  };

  const processJobs = {
    adopt: (request: Parameters<typeof jobs.runner.adopt>[0]) => jobs.runner.adopt(request), ended: (jobId: string) => ends.ended(jobId), state: (jobId: string) => ends.state(jobId),
  };

  return { handle, starts, stopped, ends, processJobs };
}

const Started = v.object({ processId: v.string(), jobId: v.string() });

describe("the computer's startProcess, each process a job of the actor's", () => {
  // Review of the computer process jobs, 2026-10-21: the end was asked before the job's row existed, and the register
  // read that as settled, so every job completed at its start, empty, while its process ran.
  test('starts as its job, which runs while its process does; its end completes it and wakes the agent once', async () => {
    const jobs = actorJobs();
    const box = computerBox(jobs);
    const computer = createSandboxExecutor(box.handle, { processJobs: box.processJobs });

    const { processId, jobId } = v.parse(Started, await computer.tools.startProcess.execute('npm run dev', { cwd: '/workspace/app' }));
    await Promise.resolve();

    expect({ processId, starts: box.starts }).toEqual({ processId: 'proc-dev', starts: [{ command: 'npm run dev', job: jobId, stamp: jobId }] });
    expect(jobs.store.get(jobId)).toMatchObject({ kind: 'startProcess', status: 'running' });
    expect(jobs.woke).toEqual([]);

    await box.ends.record(jobId, { exitCode: 1, tail: 'Error: listen EADDRINUSE: address already in use :::3000\n' });
    await jobs.settled();

    expect(jobs.store.get(jobId)).toMatchObject({ status: 'completed', result: expect.stringContaining('EADDRINUSE') });
    expect(jobs.woke.map((turn) => turn.text)).toEqual([expect.stringContaining(`Background startProcess job ${jobId} completed`)]);
  });

  // Review, 2026-10-21: the incident was acknowledged when the end reached the waiting promise, before any row held it;
  // a restart then lost the end, and its resume waited for one that never came again.
  test('an end told is on the job row before the telling answers', async () => {
    const jobs = actorJobs();
    const box = computerBox(jobs);
    const computer = createSandboxExecutor(box.handle, { processJobs: box.processJobs });
    const { jobId } = v.parse(Started, await computer.tools.startProcess.execute('npm run dev'));

    await box.ends.record(jobId, { exitCode: 0, tail: 'ready\n' });

    expect(jobs.store.get(jobId)).toMatchObject({ status: 'completed', result: expect.stringContaining('ready') });
  });

  test('a process no job takes is stopped, and the call says it ran and was stopped', async () => {
    const jobs = actorJobs();
    const box = computerBox(jobs);

    for (let n = 0; n < MAX_CONCURRENT_DETACHED_JOBS; n += 1) jobs.runner.create('shell', { command: 'sleep' }, 'build', new AbortController());
    const computer = createSandboxExecutor(box.handle, { processJobs: box.processJobs });

    expect(await computer.tools.startProcess.execute('npm run dev')).toMatchObject({ success: false, reason: 'cancelled', error: expect.stringContaining('stopped') });
    expect(box.stopped).toEqual(['proc-dev']);
  });

  // Review, 2026-10-21: a start of a command still running reused its process and took it for a second job, so the
  // first never heard its end.
  test('a start of a command that still runs as a job answers that job, and makes no second', async () => {
    const jobs = actorJobs();
    const box = computerBox(jobs, 'bgjob-earlier');
    const computer = createSandboxExecutor(box.handle, { processJobs: box.processJobs });

    await jobs.runner.adopt({
      jobId: 'bgjob-earlier', kind: 'startProcess', mode: 'build', controller: new AbortController(), promise: box.ends.ended('bgjob-earlier'),
      input: { command: 'npm run dev', cwd: '/workspace', processId: 'proc-dev', machine: 'computer', job: 'bgjob-earlier' },
    });

    expect(await computer.tools.startProcess.execute('npm run dev')).toEqual({ processId: 'proc-dev', jobId: 'bgjob-earlier' });
    expect(jobs.store.list(20).filter((job) => job.kind === 'startProcess').map((job) => job.id)).toEqual(['bgjob-earlier']);
  });

  // Third review, 2026-10-21: a start whose reply came after a second start of the same command had made its job made it
  // again; with the second start in the actor's last job slot, it was refused, and stopped the process.
  test("a start whose reply comes after a second start made its job answers that job, and stops nothing", async () => {
    const jobs = actorJobs();
    const box = computerBox(jobs);
    const reached = Promise.withResolvers<void>();
    const replied = Promise.withResolvers<void>();
    let first: string | undefined;

    const handle: SandboxHandle = {
      ...box.handle,
      startSupervisedProcess: async (_command, opts) => {
        if (first !== undefined) return { processId: 'proc-dev', job: first };
        first = opts?.job;
        reached.resolve();
        await replied.promise;

        return { processId: 'proc-dev', ...(first !== undefined && { job: first }) };
      },
    };

    for (let n = 1; n < MAX_CONCURRENT_DETACHED_JOBS; n += 1) jobs.runner.create('shell', { command: 'sleep' }, 'build', new AbortController());
    const computer = createSandboxExecutor(handle, { processJobs: box.processJobs });
    const earlier = computer.tools.startProcess.execute('npm run dev');

    await reached.promise;
    const later = await computer.tools.startProcess.execute('npm run dev');

    replied.resolve();
    const made = v.parse(Started, later).jobId;

    expect(first).toBe(made);
    expect(await earlier).toEqual({ processId: 'proc-dev', jobId: made });
    expect(box.stopped).toEqual([]);
    expect(jobs.store.list(20).filter((job) => job.kind === 'startProcess').map((job) => job.id)).toEqual([made]);
  });

  // Second review, 2026-10-21: a first start whose reply was lost left its process running under a job never made; a
  // start after it answered that job, and its end met no row.
  test("a start of a command whose first start lost its reply makes that start's job, under the id its process carries", async () => {
    const jobs = actorJobs();
    const box = computerBox(jobs, 'bgjob-lost');
    const computer = createSandboxExecutor(box.handle, { processJobs: box.processJobs });

    expect(await computer.tools.startProcess.execute('npm run dev')).toEqual({ processId: 'proc-dev', jobId: 'bgjob-lost' });
    expect(jobs.store.get('bgjob-lost')).toMatchObject({ kind: 'startProcess', status: 'running' });

    await box.ends.record('bgjob-lost', { exitCode: 0, tail: 'done\n' });
    expect(jobs.store.get('bgjob-lost')).toMatchObject({ status: 'completed' });
  });

  test('without the actor\'s jobs, a process is no job, as before', async () => {
    const box = computerBox(actorJobs());
    const computer = createSandboxExecutor(box.handle);

    expect(await computer.tools.startProcess.execute('npm run dev')).toEqual({ processId: 'proc-dev' });
    expect(box.starts).toEqual([{ command: 'npm run dev', job: undefined, stamp: undefined }]);
  });
});

// Owner decision, 2026-10-20 ("Run where the files live"): a program's `workspace.startProcess` whose cwd is the
// computer's starts on the computer, through its own member, in its own terms; the workspace's member is not asked.
describe("a program's workspace.startProcess", () => {
  test("whose cwd is the computer's starts there, in the computer's terms; any other starts in the workspace", async () => {
    const box = computerBox(actorJobs());
    const computerFiles = createMemoryVfs().vfs;
    await seedFiles(computerFiles, { '/workspace/app/package.json': '{}' });
    const mounted = withMountTable(createMemoryVfs().vfs, standardMounts((name) => (name === 'computer' ? { files: computerFiles, isAvailable: () => true } : undefined)));
    const plane = hostedToolFiles(mounted, cloudPlanes(WORKSPACE_ROOT), { mode: () => 'strict' });
    const files = serveFile(() => ({ vfs: plane, home: WORKSPACE_ROOT, planes: cloudPlanes(WORKSPACE_ROOT), ledger: new TurnFileLedger(), budget: new TurnContextBudget() }));
    const workspaceStarts: unknown[] = [];

    const workspace = {
      name: 'workspace', positionalArgs: true, capabilities: new Set(['process_long']), fileRoot: async () => ({ root: '' }),
      tools: {
        startProcess: {
          description: 'start',
          execute: async (...args: unknown[]) => {
            workspaceStarts.push(args);

            return { processId: 'nimbus-1' };
          },
        },
      },
    } satisfies ExecutorProviderSurface;

    const namespaces = routedByCwd([executorNamespace(workspace, files), executorNamespace(createSandboxExecutor(box.handle), files)]);
    const start = namespaces.find((namespace) => namespace.name === 'workspace')?.tools['startProcess'];

    expect(await start?.execute('npm run dev', { cwd: '/computer/workspace/app' })).toEqual({ processId: 'proc-dev' });
    expect(await start?.execute('npm run build', { cwd: 'notes' })).toEqual({ processId: 'nimbus-1' });
    expect(box.starts.map((started) => started.command)).toEqual(['npm run dev']);
    expect(workspaceStarts).toEqual([['npm run build', { cwd: 'notes' }]]);
  });
});
