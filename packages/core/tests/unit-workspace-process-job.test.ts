/**
 * A workspace process job after its workspace object restarted (Nimbus ask 65): Nimbus starts a dev server or a node
 * resident again under the exec id it was started with, so the job is watched while a process carrying its id runs, and
 * a cancel stops that process. One nothing started again ends as work that cannot pick up.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { BackgroundJobRunner, BackgroundJobStore, initBackgroundJobsTable, type NimbusSandboxHandle } from '../src/index';
import { isWorkspaceProcessJob, stopWorkspaceProcessJob, workspaceProcessJobRuns } from '../src/jobs/workspace-process';
import type { Schedule } from '../src/types/primitives';
import { createTestActors, handClock, hostDeliveries } from '@kinu.run/test-utils';
import { makeExecRaw, makeSql } from './helpers';

interface Listed { readonly pid: number; readonly state: string; readonly execId?: string }

/** A workspace box whose process list is `listed`, as the session answers it, and which records each kill. */
function workspaceBox(listed: Listed[]) {
  const killed: number[] = [];

  const box: NimbusSandboxHandle = {
    ready: async () => {},
    exec: async () => { throw new Error('this box runs no command'); },
    processes: {
      list: async () => listed.map((process) => ({ ...process })),
      kill: async (pid) => {
        killed.push(pid);
        const at = listed.findIndex((process) => process.pid === pid);

        if (at >= 0) listed.splice(at, 1);

        return undefined;
      },
    },
  };

  return { box, killed };
}

/** The actor's job table with one workspace process job a previous activation started and left running. */
function restartedWorkspace(listed: Listed[]) {
  const db = new Database(':memory:');
  initBackgroundJobsTable(makeExecRaw(db));
  const sql = makeSql(db);
  const store = new BackgroundJobStore(sql, createTestActors(sql, makeExecRaw(db)).main);
  const input = { command: 'npm run dev', processId: '41', machine: 'workspace' };

  store.create({ id: 'job-dev', kind: 'startProcess', workMode: 'build', input: JSON.stringify(input), now: 0 });
  const { box, killed } = workspaceBox(listed);
  const runs: Promise<unknown>[] = [];
  const clock = handClock(1);

  const fiber: Schedule['fiber'] = async (_name, fn) => {
    const run = fn({ stash: () => {}, snapshot: null });
    runs.push(run);

    return await run;
  };

  const row = (jobId: string) => {
    const stored = store.get(jobId);

    return stored === null ? null : { kind: stored.kind, input: JSON.parse(store.getInput(jobId) ?? 'null') };
  };

  // As the actor wires its runner (actor-agent.ts): its workspace box is asked by the job's exec id.
  const runner = new BackgroundJobRunner({
    store, fiber, clock, inbox: hostDeliveries({ broadcast: () => {}, enqueueTurn: async () => ({ status: 'queued' as const }) }).signals,
    stillRunning: async (job) => isWorkspaceProcessJob(row(job.id)) && await workspaceProcessJobRuns(box, job.id),
    onCancelled: async (jobId) => { await stopWorkspaceProcessJob(row(jobId), box, jobId); },
  });

  return { runner, store, killed, clock, settled: () => Promise.all(runs) };
}

describe('a workspace process job across its workspace restart', () => {
  test('is watched while the process Nimbus started again under its exec id runs, and ends when that does', async () => {
    const listed: Listed[] = [{ pid: 57, state: 'running', execId: 'job-dev' }, { pid: 58, state: 'running', execId: 'job-other' }];
    const workspace = restartedWorkspace(listed);

    await workspace.runner.recoverOrphans();
    expect(workspace.store.get('job-dev')?.status).toBe('running');

    listed.splice(0, 1);
    await workspace.clock.whenArmed(1);
    workspace.clock.tick();
    await workspace.settled();

    expect(workspace.store.get('job-dev')).toMatchObject({ status: 'completed', result: expect.stringContaining('kept running through a restart') });
  });

  test("a viewer's job is found by its marked exec id, and its cancel stops that process alone", async () => {
    const listed: Listed[] = [{ pid: 57, state: 'running', execId: 'viewer-job-dev' }, { pid: 58, state: 'running', execId: 'job-other' }];
    const workspace = restartedWorkspace(listed);

    await workspace.runner.recoverOrphans();
    expect(await workspace.runner.cancel('job-dev')).toBe(true);
    await workspace.settled();

    expect(workspace.killed).toEqual([57]);
    expect(workspace.store.get('job-dev')?.status).toBe('cancelled');
  });

  test('one whose process nothing started again ends as work that cannot pick up', async () => {
    const workspace = restartedWorkspace([{ pid: 57, state: 'exited', execId: 'job-dev' }]);

    await workspace.runner.recoverOrphans();
    await workspace.settled();

    expect(workspace.store.get('job-dev')).toMatchObject({ status: 'failed', error: expect.stringContaining('cannot pick up') });
  });
});
