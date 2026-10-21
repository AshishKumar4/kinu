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
  type ComputerProcessEnd, type SandboxHandle,
} from '../src/index';
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

/** A computer whose box starts one process and whose end the test tells, as the box's heartbeat would. */
function computerBox() {
  const starts: { command: string; job: string | undefined; stamp: string | undefined }[] = [];
  const stopped: string[] = [];
  const ends = new Map<string, ReturnType<typeof Promise.withResolvers<ComputerProcessEnd>>>();

  const endOf = (jobId: string) => {
    const known = ends.get(jobId) ?? Promise.withResolvers<ComputerProcessEnd>();
    ends.set(jobId, known);

    return known;
  };

  const handle: SandboxHandle = {
    ...sandboxHandleLifecycle,
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    startSupervisedProcess: async (command, opts) => {
      starts.push({ command, job: opts?.job, stamp: opts?.env?.[JOB_STAMP_ENV] });

      return { processId: 'proc-dev' };
    },
    stopSupervisedProcess: async (processId) => {
      stopped.push(processId);

      return { stopped: true };
    },
    readFile: async () => ({}), writeFile: async () => {}, listFiles: async () => ({ files: [] }), deleteFile: async () => {},
    exposePort: async (port) => ({ url: `https://preview.example.com/${String(port)}`, port, route: { reached: true } }),
    unexposePort: async () => {}, getExposedPorts: async () => [],
  };

  return { handle, starts, stopped, end: (jobId: string, end: ComputerProcessEnd) => { endOf(jobId).resolve(end); }, ended: async (jobId: string) => await endOf(jobId).promise };
}

const Started = v.object({ processId: v.string(), jobId: v.string() });

describe("the computer's startProcess, each process a job of the actor's", () => {
  test('starts as its job, named on its spec and in its variables; its end completes the job and wakes the agent', async () => {
    const jobs = actorJobs();
    const box = computerBox();
    const computer = createSandboxExecutor(box.handle, { processJobs: { adopt: (request) => jobs.runner.adopt(request), ended: box.ended } });

    const { processId, jobId } = v.parse(Started, await computer.tools.startProcess.execute('npm run dev', { cwd: '/workspace/app' }));

    expect({ processId, starts: box.starts }).toEqual({ processId: 'proc-dev', starts: [{ command: 'npm run dev', job: jobId, stamp: jobId }] });
    expect(jobs.store.get(jobId)).toMatchObject({ kind: 'startProcess', status: 'running' });
    expect(jobs.woke).toEqual([]);

    box.end(jobId, { exitCode: 1, tail: 'Error: listen EADDRINUSE: address already in use :::3000\n' });
    await jobs.settled();

    expect(jobs.store.get(jobId)).toMatchObject({ status: 'completed', result: expect.stringContaining('EADDRINUSE') });
    expect(jobs.woke.map((turn) => turn.text)).toEqual([expect.stringContaining(`Background startProcess job ${jobId} completed`)]);
  });

  test('a process no job takes is stopped, and the call says it ran and was stopped', async () => {
    const jobs = actorJobs();
    const box = computerBox();

    for (let n = 0; n < MAX_CONCURRENT_DETACHED_JOBS; n += 1) jobs.runner.create('shell', { command: 'sleep' }, 'build', new AbortController());
    const computer = createSandboxExecutor(box.handle, { processJobs: { adopt: (request) => jobs.runner.adopt(request), ended: box.ended } });

    expect(await computer.tools.startProcess.execute('npm run dev')).toMatchObject({ success: false, reason: 'cancelled', error: expect.stringContaining('stopped') });
    expect(box.stopped).toEqual(['proc-dev']);
  });

  test('without the actor\'s jobs, a process is no job, as before', async () => {
    const box = computerBox();
    const computer = createSandboxExecutor(box.handle);

    expect(await computer.tools.startProcess.execute('npm run dev')).toEqual({ processId: 'proc-dev' });
    expect(box.starts).toEqual([{ command: 'npm run dev', job: undefined, stamp: undefined }]);
  });
});
