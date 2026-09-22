// BackgroundJobRunner lifecycle over a fake fiber and fake BackendHost, no DO.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  BackgroundJobRunner, JobNotResumable, MAX_CONCURRENT_DETACHED_JOBS,
  type JobHarvester, type JobResumer,
} from '../src/jobs/runner';
import { Inbox } from '../src/orchestrator/inbox';
import {
  BackgroundJobStore, initBackgroundJobsTable, BACKGROUND_POLICY, DeviceRequestOwnership,
  type BackgroundPolicy, type BackgroundJob, type InvocationSurface,
} from '../src/jobs/index';
import { jobRedriveResumeGate } from '../src/heads/reconcile';
import { buildDrainBatch, EventLog, initEventsHubTables } from '../src/events/hub/index';
import type { BackendHost, ProgrammaticTurn } from '../src/types/backend-host';
import type { Schedule, SqlExecutor, SqlValue } from '../src/types/primitives';
import type { JsonValue } from '../src/utils/json';
import { recoveryBackoffMs } from '../src/utils/recovery-backoff';
import { makeSql, makeExecRaw, makeSqlExec, storesFor } from './helpers';
import { createTestRuntime, createTestActors, toolExecute } from '@kinu.run/test-utils';
import { buildBuiltinTools } from '../src/tools/builtins';
import { inWorkMode } from '../src/execution/work-mode';

/** Runs the body inline; exposes in-flight bodies so a test can await detach completion. */
function fakeFiber() {
  const stashes: JsonValue[] = [];
  const runs: Promise<unknown>[] = [];

  const fiber: Schedule['fiber'] = async (_name, fn) => {
    const body = fn({ stash: (data) => { stashes.push(data); }, snapshot: null });
    runs.push(body);

    return body;
  };

  return { fiber, stashes, runs, settled: () => Promise.all(runs) };
}

function fakeHost() {
  const enqueued: ProgrammaticTurn[] = [];
  let status: 'queued' | 'skipped' = 'queued';
  let rejection: Error | null = null;

  const host: BackendHost = {
    broadcast: () => {},
    enqueueTurn: async (i) => {
      enqueued.push(i);

      if (rejection) throw rejection;

      return { status };
    },
    turnInFlight: () => false,
    setTimer: () => {},
  };

  return {
    host,
    enqueued,
    setStatus: (s: 'queued' | 'skipped') => { status = s; rejection = null; },
    setRejection: (error: Error) => { rejection = error; },
  };
}

/** `db` lets a second process (a restart) open the same durable rows. */
function setup(opts: {
  resume?: JobResumer; policy?: BackgroundPolicy; db?: Database; harvest?: JobHarvester;
  onDetached?: ((jobId: string, requestIds: readonly string[]) => Promise<void> | void) | null;
  onCancelled?: ((jobId: string) => Promise<void> | void) | null;
  scheduleResume?: (atMs: number) => Promise<void> | void;
} = {}) {
  const db = opts.db ?? new Database(':memory:');
  initBackgroundJobsTable(makeExecRaw(db));
  // Switchable fault: teardown closing the database under a live fiber.
  const realSql = makeSql(db);
  const storeFault = { closed: false };
  // Actor bound to the underlying handle, not the fault wrapper, so fault cases reach settlement.
  const actors = createTestActors(realSql, makeExecRaw(db));
  const actor = actors.main;

  const sql = (<T = unknown>(strings: TemplateStringsArray, ...values: SqlValue[]): T[] => {
    if (storeFault.closed) throw new Error('Cannot use a closed database');

    return realSql<T>(strings, ...values);
  }) satisfies SqlExecutor;

  const store = new BackgroundJobStore(sql, actor);
  const hubSql = makeSqlExec(db);
  initEventsHubTables(hubSql);
  const eventLog = new EventLog(hubSql, actor);
  const { fiber, stashes, runs, settled } = fakeFiber();
  const { host, enqueued, setStatus, setRejection } = fakeHost();
  const logs: Array<{ e: string; d?: string }> = [];
  const notified: Array<{ id: string; status: string }> = [];
  let drainSchedules = 0;

  const policy = opts.policy;

  const runnerDeps = {
    store, fiber, inbox: new Inbox(host), eventLog,
    scheduleDrain: () => { drainSchedules++; },
    logActivity: (e: string, d?: string) => logs.push({ e, d }),
    onSettled: (job: BackgroundJob) => notified.push({ id: job.id, status: job.status }),
    onDetached: opts.onDetached,
    onCancelled: opts.onCancelled,
    resume: opts.resume,
    policy: policy === undefined ? undefined : () => policy,
    harvest: opts.harvest,
    scheduleResume: opts.scheduleResume,
  };

  const runner = new BackgroundJobRunner(runnerDeps);

  return {
    runner, runnerDeps, store, eventLog, stashes, runs, settled, host, enqueued,
    setStatus, setRejection, logs, notified, drainSchedules: () => drainSchedules,
    storeFault, db, actors,
  };
}

describe('BackgroundJobRunner.detach — settle/fail → wake', () => {
  test('resolving work settles the job + wakes a synthesis turn (once)', async () => {
    const { runner, store, eventLog, enqueued, stashes, settled, notified } = setup();
    const id = runner.create('think', { q: 1 }, 'build', new AbortController());
    expect(store.get(id)?.status).toBe('running');

    runner.detach(id, 'think', Promise.resolve('the answer'));
    await settled();

    const job = store.get(id);
    expect(job?.status).toBe('completed');
    expect(job?.result).toBe('"the answer"');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].text).toContain(id);
    expect(enqueued[0].text).toContain('completed');
    expect(enqueued[0].metadata?.kinuEvent).toBe('background_job');
    expect(enqueued[0].metadata?.status).toBe('completed');
    expect(stashes).toEqual([
      { phase: 'running', jobId: id, kind: 'think' },
      { phase: 'settled', jobId: id, kind: 'think' },
    ]);
    expect(notified).toEqual([{ id, status: 'completed' }]);
    expect(eventLog.pending()).toEqual([]);
  });

  test('starts its durable fiber only after external work is transferred to the job', async () => {
    const handoff = Promise.withResolvers<void>();
    const transferred: string[] = [];

    const { runner, store, stashes, settled } = setup({
      onDetached: async (jobId) => {
        transferred.push(jobId);
        await handoff.promise;
      },
    });

    const controller = new AbortController();
    const deps = runner.thresholdDeps({}, 'build', controller);
    const detaching = deps.onThreshold('shell', Promise.resolve('done'));
    await Promise.resolve();
    expect(transferred).toHaveLength(1);
    expect(stashes).toEqual([]);

    handoff.resolve();
    const outcome = await detaching;
    expect(outcome.detached).toBe(true);
    await settled();
    expect(store.list(2).some((job) => job.status === 'completed')).toBe(true);
  });

  test('rejecting work fails the job + the wake says failed', async () => {
    const { runner, store, enqueued, settled, notified } = setup();
    const id = runner.create('shell', {}, 'build', new AbortController());
    runner.detach(id, 'shell', Promise.reject(new Error('boom')));
    await settled();

    expect(store.get(id)?.status).toBe('failed');
    expect(store.get(id)?.error).toBe('boom');
    expect(enqueued[0].text).toContain('failed');
    expect(enqueued[0].text).toContain('boom');
    expect(enqueued[0].metadata?.status).toBe('failed');
    expect(notified).toEqual([{ id, status: 'failed' }]);
  });

  test('both settle and fail reach logActivity, not just start/cancel/resume', async () => {
    const { runner, settled, logs } = setup();
    const ok = runner.create('think', {}, 'build', new AbortController());
    runner.detach(ok, 'think', Promise.resolve('answer'));
    const bad = runner.create('shell', {}, 'build', new AbortController());
    runner.detach(bad, 'shell', Promise.reject(new Error('boom')));
    await settled();

    const okLog = logs.find((l) => l.e === 'bg_job_settled' && l.d?.startsWith(ok));
    expect(okLog?.d).toBe(`${ok} completed`);
    const badLog = logs.find((l) => l.e === 'bg_job_settled' && l.d?.startsWith(bad));
    expect(badLog?.d).toBe(`${bad} failed — boom`);
  });

  test('a skipped wake publishes a self-trusted retry event for the standard drain', async () => {
    const { runner, store, eventLog, setStatus, logs, settled, drainSchedules } = setup();
    setStatus('skipped');
    const id = runner.create('think', {}, 'build', new AbortController());
    runner.detach(id, 'think', Promise.resolve('ok'));
    await settled();

    expect(store.get(id)?.status).toBe('completed');
    expect(logs.find((l) => l.e === 'bg_job_wake_skipped')).toBeTruthy();
    const pending = eventLog.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ variant: 'timer', trust: 'self', priority: 'normal' });
    const wake = pending[0];

    if (!wake || wake.variant !== 'timer'
      || (wake.payload_visibility !== 'full' && wake.payload_visibility !== 'redact')) {
      throw new Error('expected a readable timer wake event');
    }

    expect(wake.payload.trigger_id).toBe(`background-job-wake:${id}`);
    expect(buildDrainBatch(pending)?.text).toContain(`agent.jobResult('${id}')`);
    expect(drainSchedules()).toBe(1);
  });

  test('a rejected wake publishes the same durable retry event', async () => {
    const { runner, eventLog, setRejection, settled, drainSchedules } = setup();
    setRejection(new Error('queue unavailable'));
    const id = runner.create('shell', {}, 'build', new AbortController());
    runner.detach(id, 'shell', Promise.resolve('ok'));
    await settled();

    const pending = eventLog.pending();
    expect(pending).toHaveLength(1);
    expect(buildDrainBatch(pending)?.ids).toEqual([pending[0].id]);
    expect(buildDrainBatch(pending)?.text).toContain(id);
    expect(drainSchedules()).toBe(1);
  });

  test('a retry-ledger failure surfaces from wake', async () => {
    const { runner, store, eventLog, setRejection } = setup();
    setRejection(new Error('queue unavailable'));
    const id = runner.create('shell', {}, 'build', new AbortController());
    store.settle(id, 0, '"saved"', Date.now());
    eventLog.publish = () => { throw new Error('ledger unavailable'); };

    await expect(runner.wake(id)).rejects.toThrow('ledger unavailable');
  });

  test('an undeliverable wake still drives the fiber to a terminal snapshot', async () => {
    const { runner, store, eventLog, stashes, settled, setRejection } = setup();
    setRejection(new Error('queue unavailable'));
    eventLog.publish = () => { throw new Error('ledger unavailable'); };

    const id = runner.create('think', {}, 'build', new AbortController());

    runner.detach(id, 'think', Promise.resolve('the answer'));
    // Fibers delete their recovery row in `finally`, so a rejected body never reaches onFiberRecovered.
    await settled();

    expect(store.get(id)?.status).toBe('completed');
    expect(store.get(id)?.result).toBe('"the answer"');
    expect(stashes.at(-1)).toEqual({ phase: 'settled', jobId: id, kind: 'think' });
  });

  test('a store write that fails mid-settlement still reaches a terminal status', async () => {
    const { runner, store, stashes, settled, notified } = setup();
    const id = runner.create('think', {}, 'build', new AbortController());
    store.settle = () => { throw new Error('storage unavailable'); };

    runner.detach(id, 'think', Promise.resolve('the answer'));
    await settled();

    expect(store.get(id)?.status).toBe('failed');
    expect(store.get(id)?.error).toBe('storage unavailable');
    expect(notified).toEqual([{ id, status: 'failed' }]);
    expect(stashes.at(-1)).toEqual({ phase: 'settled', jobId: id, kind: 'think' });
  });
});

describe('BackgroundJobRunner.create — descriptive labels', () => {
  test('a backgrounded search labels the task it is running', () => {
    const { runner, store } = setup();
    const id = runner.create('agents', { action: 'swarm', task: 'investigate the flaky test' }, 'build', new AbortController());
    expect(store.get(id)?.label).toBe('search: investigate the flaky test');
  });

  test('a run call labels the runtime + command', () => {
    const { runner, store } = setup();
    const id = runner.create('shell', { runtime: 'sandbox', command: 'npm test' }, 'build', new AbortController());
    expect(store.get(id)?.label).toBe('sandbox: npm test');
  });

  test('an eval call labels the code snippet', () => {
    const { runner, store } = setup();
    const id = runner.create('eval', { code: '  const x = await workspace.readFile("/a");\n  return x;' }, 'build', new AbortController());
    expect(store.get(id)?.label).toBe('const x = await workspace.readFile("/a");\n  return x;');
  });

  test('an unrecognized shape gets no label rather than a guess', () => {
    const { runner, store } = setup();
    const id = runner.create('agents', { action: 'hire', agent: 'x' }, 'build', new AbortController());
    expect(store.get(id)?.label).toBeNull();
  });
});

describe('BackgroundJobRunner.cancel — operator hard-cancel', () => {
  test.each([undefined, null])('without an external owner (%p), cancel aborts, marks cancelled, and wakes once', async (external) => {
    const { runner, store, enqueued, settled } = setup({ onDetached: external, onCancelled: external });
    const controller = new AbortController();
    const id = runner.create('shell', {}, 'build', controller);
    const work = Promise.withResolvers<never>();
    runner.detach(id, 'shell', work.promise);

    expect(await runner.cancel(id)).toBe(true);
    expect(store.get(id)?.status).toBe('cancelled');
    expect(controller.signal.aborted).toBe(true);
    expect(await runner.cancel(id)).toBe(false);

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.text).toContain('CANCELLED by the operator');
    expect(enqueued[0]?.text).toContain('no result to collect');

    work.reject(new Error('aborted'));
    await settled();
    expect(store.get(id)?.status).toBe('cancelled');
    expect(enqueued).toHaveLength(1);
  });

  test('cancelling one detached job cancels only its transferred external work', async () => {
    const cancelled: string[] = [];
    const { runner, settled } = setup({ onCancelled: async (jobId) => { cancelled.push(jobId); } });
    const id = runner.create('shell', {}, 'build', new AbortController());
    const work = Promise.withResolvers<never>();
    runner.detach(id, 'shell', work.promise);

    expect(await runner.cancel(id)).toBe(true);
    expect(cancelled).toEqual([id]);

    work.reject(new Error('aborted'));
    await settled();
  });

  test('keeps a job retryable when its transferred external work cannot be cancelled', async () => {
    let attempts = 0;

    const { runner, store, settled } = setup({
      onCancelled: async () => {
        attempts += 1;

        if (attempts === 1) throw new Error('device unavailable');
      },
    });

    const controller = new AbortController();
    const id = runner.create('shell', {}, 'build', controller);
    const work = Promise.withResolvers<never>();
    runner.detach(id, 'shell', work.promise);

    expect(await runner.cancel(id)).toBe(false);
    expect(store.get(id)?.status).toBe('running');
    expect(controller.signal.aborted).toBe(false);
    expect(await runner.cancel(id)).toBe(true);
    expect(store.get(id)?.status).toBe('cancelled');
    expect(controller.signal.aborted).toBe(true);

    work.reject(new Error('aborted'));
    await settled();
  });

  // Settle during the external-cancel await must not record `completed` over the cancel.
  test('work that RESOLVES while the external cancel is confirming does not settle over it', async () => {
    const confirm = Promise.withResolvers<void>();
    const { runner, store, settled, enqueued } = setup({ onCancelled: () => confirm.promise });
    const id = runner.create('shell', {}, 'build', new AbortController());
    const work = Promise.withResolvers<string>();
    runner.detach(id, 'shell', work.promise);

    const cancelling = runner.cancel(id);
    work.resolve('the command finished anyway');
    await settled();
    expect(store.get(id)?.status).toBe('running');

    confirm.resolve();
    expect(await cancelling).toBe(true);
    expect(store.get(id)?.status).toBe('cancelled');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.text).toContain('no result to collect');
  });

  test('work that REJECTS in that same window is not recorded failed either', async () => {
    const confirm = Promise.withResolvers<void>();
    const { runner, store, settled, notified } = setup({ onCancelled: () => confirm.promise });
    const id = runner.create('shell', {}, 'build', new AbortController());
    const work = Promise.withResolvers<never>();
    runner.detach(id, 'shell', work.promise);

    const cancelling = runner.cancel(id);
    work.reject(new Error('the device dropped the connection'));
    await settled();
    expect(store.get(id)?.status).toBe('running');

    confirm.resolve();
    expect(await cancelling).toBe(true);
    expect(store.get(id)?.status).toBe('cancelled');
    expect(notified).toEqual([]);
  });

  test('a second cancel while the first is in flight fires no second external cancel', async () => {
    const confirm = Promise.withResolvers<void>();
    let externalCancels = 0;

    const { runner, store, settled } = setup({
      onCancelled: () => {
        externalCancels += 1;

        return confirm.promise;
      },
    });

    const id = runner.create('shell', {}, 'build', new AbortController());
    const work = Promise.withResolvers<never>();
    runner.detach(id, 'shell', work.promise);

    const first = runner.cancel(id);
    expect(await runner.cancel(id)).toBe(false);
    expect(externalCancels).toBe(1);

    confirm.resolve();
    expect(await first).toBe(true);
    expect(store.get(id)?.status).toBe('cancelled');

    work.reject(new Error('aborted'));
    await settled();
  });

  test('a REFUSED cancel hands back the outcome its work reached while refusing', async () => {
    // A refused cancel leaves the job running, so its real outcome must still settle.
    const confirm = Promise.withResolvers<void>();

    const { runner, store, settled, enqueued } = setup({
      onCancelled: async () => { await confirm.promise; throw new Error('device unavailable'); },
    });

    const id = runner.create('shell', {}, 'build', new AbortController());
    const work = Promise.withResolvers<string>();
    runner.detach(id, 'shell', work.promise);

    const cancelling = runner.cancel(id);
    work.resolve('the build finished');
    await settled();

    confirm.resolve();
    expect(await cancelling).toBe(false);
    expect(store.get(id)?.status).toBe('completed');
    expect(store.get(id)?.result).toBe('"the build finished"');
    expect(enqueued).toHaveLength(1);
  });

  test('cancelRunning aborts every running job and leaves settled jobs alone', async () => {
    const { runner, store } = setup();
    const c1 = new AbortController();
    const c2 = new AbortController();
    const id1 = runner.create('shell', { one: true }, 'build', c1);
    const id2 = runner.create('think', { two: true }, 'build', c2);
    const done = runner.create('shell', { done: true }, 'build', new AbortController());
    store.settle(done, 0, '"done"', Date.now());

    expect(new Set(runner.cancelRunning())).toEqual(new Set([id1, id2]));

    expect(store.get(id1)?.status).toBe('cancelled');
    expect(store.get(id2)?.status).toBe('cancelled');
    expect(store.get(done)?.status).toBe('completed');
    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(true);
  });
});

// Recovery starts from durable rows only; in-memory cancel handles died with the process.
describe('BackgroundJobRunner.recover — evict mid-flight', () => {
  const orphanRow = (store: BackgroundJobStore, id: string): string => {
    store.create({ id, kind: 'think', workMode: 'build', input: '{}', now: Date.now() });

    return id;
  };

  test('a job stashed running is failed + woken', async () => {
    const { runner, store, enqueued } = setup();
    const id = orphanRow(store, 'je');
    await runner.recover({ jobId: id, phase: 'running' });

    expect(store.get(id)?.status).toBe('failed');
    expect(store.get(id)?.error).toContain('eviction');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].metadata?.status).toBe('failed');
  });

  test('a job already stashed settled is NOT re-failed or re-woken', async () => {
    const { runner, store, enqueued } = setup();
    const id = orphanRow(store, 'js');
    store.settle(id, 0, '"x"', 123);
    await runner.recover({ jobId: id, phase: 'settled' });

    expect(store.get(id)?.status).toBe('completed');
    expect(enqueued).toHaveLength(0);
  });

  test('an outcome persisted before the settled checkpoint is re-woken without duplicate notification', async () => {
    const { runner, store, enqueued, notified } = setup();
    const id = orphanRow(store, 'jp');
    store.settle(id, 0, '"saved"', Date.now());

    await runner.recover({ jobId: id, phase: 'running' });

    expect(store.get(id)?.status).toBe('completed');
    expect(enqueued).toHaveLength(1);
    expect(notified).toEqual([]);
  });

  test('a cancelled outcome with a running checkpoint stays silent on recovery', async () => {
    const { runner, store, enqueued } = setup();
    const id = orphanRow(store, 'jx');
    store.cancel(id, 0, Date.now());

    await runner.recover({ jobId: id, phase: 'running' });

    expect(store.get(id)?.status).toBe('cancelled');
    expect(enqueued).toEqual([]);
  });
});

describe('BackgroundJobRunner.recover — resume from durable checkpoint', () => {
  test('a resumable job is reclaimed under a fresh epoch and re-driven to completion', async () => {
    let seenInput: unknown = undefined;
    let seenMode: 'plan' | 'build' | undefined;

    const resume: JobResumer = async (_kind, input, mode) => {
      seenInput = input;
      seenMode = mode;

      return { text: 'resumed answer' };
    };

    const { runner, store, enqueued, settled, notified, logs } = setup({ resume });
    store.create({ id: 'jr', kind: 'think', workMode: 'plan', input: '{"strategy":"mcts","task":"t"}', now: Date.now() });

    await runner.recover({ jobId: 'jr', phase: 'running' });
    await settled();

    const job = store.get('jr');
    expect(job?.epoch).toBe(1);
    expect(job?.resumeAttempts).toBe(1);
    expect(job?.status).toBe('completed');
    expect(job?.result).toBe('{"text":"resumed answer"}');
    expect(seenInput).toEqual({ strategy: 'mcts', task: 't' });
    expect(seenMode).toBe('plan');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].metadata?.status).toBe('completed');
    expect(enqueued[0].metadata?.kinuMode).toBe('plan');
    expect(notified).toEqual([{ id: 'jr', status: 'completed' }]);
    expect(logs.find((l) => l.e === 'bg_job_resume')).toBeTruthy();
  });

  test('a kind the resumer cannot re-drive falls back to the eviction failure', async () => {
    const resume: JobResumer = async (kind) => { throw new JobNotResumable(kind); };

    const { runner, store, enqueued, settled } = setup({ resume });
    store.create({ id: 'jn', kind: 'shell', workMode: 'build', input: '{}', now: Date.now() });

    await runner.recover({ jobId: 'jn', phase: 'running' });
    await settled();

    expect(store.get('jn')?.status).toBe('failed');
    expect(store.get('jn')?.error).toContain('eviction');
    expect(enqueued[0].metadata?.status).toBe('failed');
  });

  test('twelve interrupted activations leave the job running — an eviction is not a failure', async () => {
    const resume: JobResumer = () => new Promise<never>(() => {});
    const first = setup({ resume });
    first.store.create({ id: 'jc', kind: 'think', workMode: 'build', input: '{}', now: Date.now() });

    // One activation per recovery; each finds the prior wait elapsed.
    let last = first;

    for (let activation = 0; activation < 12; activation++) {
      first.store.deferResume('jc', Date.now() - 1);
      last = setup({ resume, db: first.db });
      await last.runner.recover({ jobId: 'jc', phase: 'running' });
    }

    const job = first.store.get('jc');
    expect(job?.status).toBe('running');
    expect(job?.resumeAttempts).toBe(12);
    expect(job?.error).toBeNull();
    expect(first.store.runningIds()).toEqual(['jc']);
    expect(last.enqueued).toHaveLength(0);
    expect(last.logs.map((l) => `${l.e} ${l.d ?? ''}`).join('\n')).not.toContain('gave up');
  });

  test('the wait between attempts is capped, durable, and respected by a runner that never wrote it', async () => {
    const resume: JobResumer = () => new Promise<never>(() => {});
    const first = setup({ resume });
    first.store.create({ id: 'jp', kind: 'agents', workMode: 'build', input: '{}', now: Date.now() });

    const waits: number[] = [];

    for (let activation = 0; activation < 9; activation++) {
      first.store.deferResume('jp', Date.now() - 1);
      await setup({ resume, db: first.db }).runner.recover({ jobId: 'jp', phase: 'running' });
      const job = first.store.get('jp');

      if (job?.resumeAfter === null || job === null) throw new Error('a claim armed no next attempt');
      waits.push(job.resumeAfter - job.attemptStartedAt);
    }

    // One second, doubling, capped at sixty seconds.
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);

    // A fresh runner over the same database respects a wait it never armed.
    const armed = Date.now() + 60_000;
    first.store.deferResume('jp', armed);
    const fresh = setup({ resume, db: first.db });
    await fresh.runner.recover({ jobId: 'jp', phase: 'running' });

    expect(first.store.get('jp')?.resumeAttempts).toBe(9);
    expect(first.store.get('jp')?.resumeAfter).toBe(armed);
  });

  test('a deferred attempt arms the durable wake, and the runner without one is not broken by it', async () => {
    const resume: JobResumer = () => new Promise<never>(() => {});
    const first = setup({ resume });
    first.store.create({ id: 'jw', kind: 'agents', workMode: 'build', input: '{}', now: Date.now() });
    await setup({ resume, db: first.db }).runner.recover({ jobId: 'jw', phase: 'running' });

    const armedFor: number[] = [];
    const waker = setup({ resume, db: first.db, scheduleResume: (atMs) => { armedFor.push(atMs); } });
    await waker.runner.recover({ jobId: 'jw', phase: 'running' });

    expect(armedFor).toEqual([first.store.get('jw')?.resumeAfter ?? -1]);
    expect(waker.logs.some((l) => l.e === 'bg_job_resume_deferred')).toBe(true);

    // A swarm node has no `scheduleResume`/`resume`: the job must be left alone, no throw.
    const nowake = setup({ resume, db: first.db });
    await nowake.runner.recover({ jobId: 'jw', phase: 'running' });
    expect(first.store.get('jw')?.resumeAttempts).toBe(1);
  });

  test('a job this runner is already driving is never re-driven out from under itself', async () => {
    // A resume leaves its own fiber row, so recover() can see the same job twice.
    const resume: JobResumer = () => new Promise<never>(() => {});
    const { runner, store } = setup({ resume });
    store.create({ id: 'jd', kind: 'agents', workMode: 'build', input: '{}', now: Date.now() });

    await runner.recover({ jobId: 'jd', phase: 'running' });
    await runner.recover({ jobId: 'jd', phase: 'running' });
    await runner.recoverOrphans();

    expect(store.get('jd')?.resumeAttempts).toBe(1);
    expect(store.get('jd')?.epoch).toBe(1);
  });
});

// A closed database defeated both the settle write and the force-fail, stranding the row
// 'running' with no fiber row; only the registry sweep can reach it.
describe('BackgroundJobRunner.recoverOrphans — a job cannot stay running forever', () => {
  test('a settlement whose store closed under it strands the row — and the next start settles it', async () => {
    const { runner, store, storeFault, settled, enqueued, db } = setup();
    const id = runner.create('shell', { command: 'sleep 1' }, 'build', new AbortController());
    let finish: () => void = () => {};

    runner.detach(id, 'shell', new Promise<string>((resolve) => { finish = () => resolve('done'); }));

    storeFault.closed = true;
    finish();
    await settled();

    storeFault.closed = false;
    expect(store.get(id)?.status).toBe('running');

    const next = setup({ db });
    await next.runner.recoverOrphans();

    expect(next.store.get(id)?.status).toBe('failed');
    expect(next.store.get(id)?.error).toContain('eviction');
    expect(next.enqueued.at(-1)?.metadata?.status).toBe('failed');
    expect(enqueued).toHaveLength(0);
  });

  test('repeated restarts keep the job alive, and the sweep keeps naming it in flight', async () => {
    const resume: JobResumer = () => new Promise<never>(() => {});
    const first = setup({ resume });
    first.store.create({ id: 'jz', kind: 'agents', workMode: 'build', input: '{}', now: Date.now() });

    for (let start = 0; start < 6; start++) {
      first.store.deferResume('jz', Date.now() - 1);
      const inFlight = await setup({ resume, db: first.db }).runner.recoverOrphans();
      expect(inFlight.map((j) => j.id)).toEqual(['jz']);
    }

    expect(first.store.get('jz')?.resumeAttempts).toBe(6);

    // A restart during the wait re-drives nothing but still counts the job in flight.
    first.store.deferResume('jz', Date.now() + 60_000);
    const waiting = await setup({ resume, db: first.db }).runner.recoverOrphans();
    expect(waiting.map((j) => j.id)).toEqual(['jz']);
    expect(first.store.get('jz')?.resumeAttempts).toBe(6);
    expect(first.store.get('jz')?.status).toBe('running');
    expect(first.store.runningIds()).toEqual(['jz']);
  });

  test('a job whose executor is alive in THIS process is not reclaimed as an orphan', async () => {
    const resume: JobResumer = async () => 'should not run';
    const { runner, store, settled } = setup({ resume });
    let finish: () => void = () => {};

    const id = runner.create('shell', {}, 'build', new AbortController());
    runner.detach(id, 'shell', new Promise<string>((resolve) => { finish = () => resolve('real result'); }));

    await runner.recoverOrphans();
    expect(store.get(id)?.resumeAttempts).toBe(0);

    finish();
    await settled();
    expect(store.get(id)?.result).toBe('"real result"');
  });

  // `jobRedriveResumeGate` retires the fork run of every job absent from the sweep result.
  test('a job waiting for its next attempt keeps its fork run — and an absent one loses it', async () => {
    const resume: JobResumer = () => new Promise<never>(() => {});
    const task = 'measure the three candidates';
    const first = setup({ resume });
    first.store.create({
      id: 'jf', kind: 'agents', workMode: 'build', input: JSON.stringify({ task }), now: Date.now(),
    });
    await setup({ resume, db: first.db }).runner.recoverOrphans();
    expect(first.store.get('jf')?.resumeAfter).toBeGreaterThan(Date.now());

    const next = setup({ resume, db: first.db });

    const claimed = await jobRedriveResumeGate({
      recoverOrphans: () => next.runner.recoverOrphans(),
      inputOf: (jobId) => next.store.getInput(jobId),
      rootsForTask: (t) => (t === task ? ['root-live'] : []),
    })(['root-live']);

    expect(claimed).toEqual(['root-live']);

    const retired = await jobRedriveResumeGate({
      recoverOrphans: async () => [],
      inputOf: (jobId) => next.store.getInput(jobId),
      rootsForTask: (t) => (t === task ? ['root-live'] : []),
    })(['root-live']);

    expect(retired).toEqual([]);
  });

  test('the wake re-drives only when an attempt has come due, and is a no-op otherwise', async () => {
    const resume: JobResumer = () => new Promise<never>(() => {});
    const first = setup({ resume });
    first.store.create({ id: 'jd', kind: 'agents', workMode: 'build', input: '{}', now: Date.now() });

    await setup({ resume, db: first.db }).runner.recoverDueResumes();
    expect(first.store.get('jd')?.resumeAttempts).toBe(0);

    first.store.deferResume('jd', Date.now() + 60_000);
    await setup({ resume, db: first.db }).runner.recoverDueResumes();
    expect(first.store.get('jd')?.resumeAttempts).toBe(0);

    first.store.deferResume('jd', Date.now() - 1);
    await setup({ resume, db: first.db }).runner.recoverDueResumes();
    expect(first.store.get('jd')?.resumeAttempts).toBe(1);
  });

  // An unreadable stored input must fail its own job without holding a slot or failing the gate.
  test('an unreadable stored input fails its own job; the sweep still answers and the rest recover', async () => {
    const resumed: JsonValue[] = [];
    let release: () => void = () => {};

    const held = new Promise<string>((resolve) => { release = () => resolve('resumed'); });

    const resume: JobResumer = (_kind, input) => {
      resumed.push(input);

      return held;
    };

    const task = 'measure the three candidates';
    const first = setup({ resume });
    const now = Date.now();
    first.store.create({ id: 'jp', kind: 'agents', workMode: 'build', input: '{"task":"poisoned"}', now });
    first.store.create({ id: 'jq', kind: 'agents', workMode: 'build', input: JSON.stringify({ task }), now: now + 1 });

    const next = setup({ resume, db: first.db });
    const readInput = next.store.getInput.bind(next.store);
    next.store.getInput = (id) => {
      if (id === 'jp') throw new Error('disk I/O error');

      return readInput(id);
    };

    const claimed = await jobRedriveResumeGate({
      recoverOrphans: () => next.runner.recoverOrphans(),
      inputOf: (jobId) => next.store.getInput(jobId),
      rootsForTask: (t) => (t === task ? ['root-live'] : []),
    })(['root-live']);

    expect(claimed).toEqual(['root-live']);
    expect(resumed).toEqual([{ task }]);
    expect(next.runner.inFlight).toBe(1);

    release();
    await next.settled();
    expect(next.store.get('jp')?.status).toBe('failed');
    expect(next.store.get('jp')?.error).toContain('disk I/O error');
    expect(next.enqueued.some((turn) => turn.text.includes('jp') && turn.metadata?.status === 'failed')).toBe(true);
    expect(next.runner.inFlight).toBe(0);
    expect(next.store.runningIds()).toEqual([]);

    const later = setup({ resume, db: first.db });
    expect(await later.runner.recoverOrphans()).toEqual([]);
    expect(later.runner.inFlight).toBe(0);
    expect(later.store.get('jp')?.status).toBe('failed');
  });
});

describe('BackgroundJobRunner.thresholdDeps — withBackgroundThreshold wiring', () => {
  test('crossing the threshold mints a running job (carrying input) + logs bg_job_started', async () => {
    const { runner, store, logs } = setup();
    const deps = runner.thresholdDeps({ code: '1+1' }, 'build', new AbortController());
    const outcome = await deps.onThreshold('heads', new Promise(() => { /* still running */ }));
    expect(outcome.detached).toBe(true);
    const id = outcome.detached ? outcome.jobId : '';
    expect(store.get(id)?.status).toBe('running');
    expect(store.getInput(id)).toBe('{"code":"1+1"}');
    expect(logs).toContainEqual({ e: 'bg_job_started', d: `heads → ${id}` });
  });

  test('the threshold carries the session surface\'s detach policy', () => {
    const { runner } = setup();
    expect(runner.thresholdDeps({}, 'build', new AbortController()).thresholdMs)
      .toBe(BACKGROUND_POLICY.interactive.detachAfterMs);

    const oneShot = setup({ policy: BACKGROUND_POLICY['one-shot'] });
    expect(oneShot.runner.thresholdDeps({}, 'build', new AbortController()).thresholdMs)
      .toBe(BACKGROUND_POLICY['one-shot'].detachAfterMs);

    // Resolved per read: a backend's surface can change between turns.
    let surface: InvocationSurface = 'interactive';

    const perTurn = new BackgroundJobRunner({
      ...oneShot.runnerDeps, policy: () => BACKGROUND_POLICY[surface],
    });

    expect(perTurn.policy.detachAfterMs).toBe(BACKGROUND_POLICY.interactive.detachAfterMs);
    surface = 'one-shot';
    expect(perTurn.policy.detachAfterMs).toBe(BACKGROUND_POLICY['one-shot'].detachAfterMs);
    // One-shot runs have no waiting human, so long work stays inline.
    expect(BACKGROUND_POLICY['one-shot'].detachAfterMs)
      .toBeGreaterThan(BACKGROUND_POLICY.interactive.detachAfterMs);
  });

  test('past the concurrency cap classifies refusal without aborting foreground work', async () => {
    const { runner, store, logs } = setup();

    for (let i = 0; i < MAX_CONCURRENT_DETACHED_JOBS; i++) {
      store.create({ id: `busy-${i}`, kind: 'shell', workMode: 'build', input: '{}', now: Date.now() });
    }

    const controller = new AbortController();
    const work = Promise.withResolvers<string>();
    controller.signal.addEventListener('abort', () => {
      work.reject(new Error('the threshold aborted live work'));
    });
    const deps = runner.thresholdDeps({ command: 'pystan build' }, 'build', controller);
    const outcome = await deps.onThreshold('shell', work.promise);

    expect(outcome.detached).toBe(false);

    if (outcome.detached) throw new Error('expected the full cap to refuse detach');
    expect(store.countRunningInWorkspace()).toBe(MAX_CONCURRENT_DETACHED_JOBS);
    expect(controller.signal.aborted).toBe(false);
    expect(outcome.reason).toBe('too many jobs already running');
    expect(logs.some((l) => l.e === 'bg_job_refused')).toBe(true);

    work.resolve('completed without an implicit timeout');
    await expect(work.promise).resolves.toBe('completed without an implicit timeout');
  });

  test("a SIBLING actor's detached jobs fill the cap too — the ceiling is the machine, not the actor", async () => {
    // All eight live trees belong to another actor: the cap is workspace-wide, not per actor.
    const { runner, store, actors, db } = setup();
    const sibling = new BackgroundJobStore(makeSql(db), actors.sibling('other'));

    for (let i = 0; i < MAX_CONCURRENT_DETACHED_JOBS; i++) {
      sibling.create({ id: `busy-${i}`, kind: 'shell', workMode: 'build', input: '{}', now: Date.now() });
    }

    expect(store.listRunning()).toEqual({ items: [], total: 0 });
    expect(store.list()).toEqual([]);
    expect(store.countRunningInWorkspace()).toBe(MAX_CONCURRENT_DETACHED_JOBS);

    const outcome = await runner.thresholdDeps({}, 'build', new AbortController())
      .onThreshold('shell', new Promise(() => { /* still running */ }));

    expect(outcome.detached).toBe(false);

    if (outcome.detached) throw new Error('expected a sibling-filled cap to refuse detach');
    expect(outcome.reason).toBe('too many jobs already running');
  });

  test('under the cap a refusal never happens — the boundary is exact', async () => {
    const { runner, store } = setup();

    for (let i = 0; i < MAX_CONCURRENT_DETACHED_JOBS - 1; i++) {
      store.create({ id: `busy-${i}`, kind: 'shell', workMode: 'build', input: '{}', now: Date.now() });
    }

    const outcome = await runner.thresholdDeps({}, 'build', new AbortController())
      .onThreshold('shell', new Promise(() => { /* still running */ }));

    expect(outcome.detached).toBe(true);
  });

  test('a settled job frees a slot — the cap counts what is in flight, not what ever ran', async () => {
    const { runner, store } = setup();

    for (let i = 0; i < MAX_CONCURRENT_DETACHED_JOBS; i++) {
      store.create({ id: `busy-${i}`, kind: 'shell', workMode: 'build', input: '{}', now: Date.now() });
    }

    store.settle('busy-0', 0, 'done', Date.now());

    const outcome = await runner.thresholdDeps({}, 'build', new AbortController())
      .onThreshold('shell', new Promise(() => { /* still running */ }));

    expect(outcome.detached).toBe(true);
  });

  test('eight jobs merely WAITING for their next attempt do not refuse a new detach', async () => {
    // A job waiting for its next attempt has no live process tree, so it does not count.
    const resume: JobResumer = () => new Promise<never>(() => {});
    const { runner, store } = setup({ resume });

    for (let i = 0; i < MAX_CONCURRENT_DETACHED_JOBS; i++) {
      store.create({ id: `owed-${i}`, kind: 'agents', workMode: 'build', input: '{}', now: Date.now() });
      store.reclaim(`owed-${i}`);
      store.deferResume(`owed-${i}`, Date.now() + 60_000);
    }

    expect(store.countRunningInWorkspace()).toBe(MAX_CONCURRENT_DETACHED_JOBS);

    const outcome = await runner.thresholdDeps({}, 'build', new AbortController())
      .onThreshold('shell', new Promise(() => { /* still running */ }));

    expect(outcome.detached).toBe(true);
  });

  test('eight jobs actually DRIVING still refuse it — the ceiling did not move', async () => {
    // A job being re-driven also has a future `resume_after` (written at claim), yet is live.
    const resume: JobResumer = () => new Promise<never>(() => {});
    const { runner, store } = setup({ resume });

    for (let i = 0; i < MAX_CONCURRENT_DETACHED_JOBS; i++) {
      store.create({ id: `live-${i}`, kind: 'agents', workMode: 'build', input: '{}', now: Date.now() });
    }

    await runner.recoverOrphans();
    expect(runner.inFlight).toBe(MAX_CONCURRENT_DETACHED_JOBS);
    expect(store.resumeOwedIdsInWorkspace(Date.now())).toHaveLength(MAX_CONCURRENT_DETACHED_JOBS);

    const outcome = await runner.thresholdDeps({}, 'build', new AbortController())
      .onThreshold('shell', new Promise(() => { /* still running */ }));

    expect(outcome.detached).toBe(false);
  });

  test('the detach transfers what the call had issued, and OWNS what it issues next', async () => {
    // Requests issued after the claim, before the transfer resolves, must belong to the job.
    const ownership = new DeviceRequestOwnership();
    ownership.report('req-1');
    ownership.report('req-2');
    const received: string[][] = [];
    const ownersDuringTransfer: Array<string | null> = [];

    const { runner } = setup({
      onDetached: async (_jobId, requestIds) => {
        received.push([...requestIds]);
        ownersDuringTransfer.push(ownership.owningJobId);
        ownership.report('req-late');
      },
    });

    const outcome = await runner.thresholdDeps({}, 'build', new AbortController(), ownership)
      .onThreshold('shell', Promise.resolve('done'));

    expect(outcome.detached).toBe(true);
    const jobId = outcome.detached ? outcome.jobId : null;
    expect(received).toEqual([['req-1', 'req-2']]);
    expect(ownersDuringTransfer).toEqual([jobId]);
    expect(ownership.owningJobId).toBe(jobId);
    expect(ownership.drain(jobId ?? '')).toEqual([]);
  });

  test('a transfer failure keeps the job-owned live completion without aborting it', async () => {
    const ownership = new DeviceRequestOwnership();
    ownership.report('req-1');
    const work = Promise.withResolvers<string>();

    const { runner, store, logs, settled } = setup({
      onDetached: () => { throw new Error('the device refused the handover'); },
    });

    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => {
      work.reject(new Error('the transfer failure aborted live work'));
    });

    const outcome = await runner.thresholdDeps({}, 'build', controller, ownership)
      .onThreshold('shell', work.promise);

    expect(outcome.detached).toBe(true);

    if (!outcome.detached) throw new Error('expected a job to preserve the live work');
    const jobId = outcome.jobId;
    expect(store.get(jobId)?.status).toBe('running');
    expect(controller.signal.aborted).toBe(false);
    expect(runner.inFlight).toBe(1);
    // A partial transfer leaves the job as the owner of the live promise and later requests.
    expect(ownership.owningJobId).toBe(jobId);
    ownership.report('req-late');
    expect(logs.some((l) => l.e === 'bg_job_transfer_failed' && l.d?.includes(jobId))).toBe(true);

    work.resolve('completed after the unconfirmed handoff');
    await settled();
    expect(store.get(jobId)?.status).toBe('completed');
    expect(runner.inFlight).toBe(0);
    expect(store.get(jobId)?.result).toBe('"completed after the unconfirmed handoff"');
  });
});

/**
 * Re-entry: one durable job continues with unbounded attempts at bounded backoff pace,
 * discloses its generation count, and settles carrying available partial work.
 */
describe('a background job gives up its turn, and hands over what it has', () => {

  test('the attempt clock is a column, and a reclaim starts a new generation on it', () => {
    const { store } = setup();
    store.create({ id: 'j1', kind: 'agents', workMode: 'build', input: '{}', now: 1_000 });
    expect(store.get('j1')?.attemptStartedAt).toBe(1_000);

    store.reclaim('j1', 5_000);
    expect(store.get('j1')).toMatchObject({
      attemptStartedAt: 5_000, resumeAttempts: 1, epoch: 1,
    });
  });

  test('a never-settling detached job is NOT killed by a clock — the ruling bound', async () => {
    // No wall clock over a detached job (owner ruling, 2026-08-21); fails if a timer returns here.
    const { runner, store } = setup();
    store.create({ id: 'bgjob-immortal', kind: 'agents', workMode: 'build', input: '{}', now: Date.now() });
    runner.detach('bgjob-immortal', 'agents', new Promise(() => { /* never */ }));
    await Promise.resolve();
    expect(store.get('bgjob-immortal')?.status).toBe('running');
  });

  test('a kind that cannot be re-driven settles with the partial, instead of an eviction string', async () => {
    const { runner, store, settled } = setup({
      resume: async (kind) => { throw new JobNotResumable(kind); },
      harvest: async () => ({ rootId: 'root-2', candidates: [{ nodeId: 'n1', score: 0.4 }] }),
    });

    store.create({ id: 'bgjob-unresumable', kind: 'agents', workMode: 'build', input: '{}', now: Date.now() });

    // The attempt count rides the partial but decides nothing.
    for (let i = 0; i < 50; i++) store.reclaim('bgjob-unresumable');

    await runner.recoverOrphans();
    await settled();

    const job = store.get('bgjob-unresumable');
    expect(job?.status).toBe('completed');
    expect(job?.error).toBeNull();
    expect(String(job?.result)).toContain('root-2');
    expect(String(job?.result)).toContain('PARTIAL');
  });

  test('a kind that cannot be re-driven with NOTHING to hand back fails, naming that', async () => {
    const { runner, store, settled } = setup({
      resume: async (kind) => { throw new JobNotResumable(kind); },
      harvest: async () => null,
    });

    store.create({ id: 'bgjob-unresumable-empty', kind: 'shell', workMode: 'build', input: '{}', now: Date.now() });

    await runner.recoverOrphans();
    await settled();

    const job = store.get('bgjob-unresumable-empty');
    expect(job?.status).toBe('failed');
    expect(job?.error ?? '').toContain('no partial result');
    expect(job?.error ?? '').toContain('cannot be re-driven');
  });

  test('a resumer that THROWS fails the job with its own error — a real failure is terminal', async () => {
    // Only an unobserved interruption earns another attempt.
    const { runner, store, settled } = setup({
      resume: async () => { throw new Error('the branch budget was rejected'); },
      harvest: async () => ({ rootId: 'root-3' }),
    });

    store.create({ id: 'bgjob-thrown', kind: 'agents', workMode: 'build', input: '{}', now: Date.now() });

    await runner.recoverOrphans();
    await settled();

    const job = store.get('bgjob-thrown');
    expect(job?.status).toBe('failed');
    expect(job?.error ?? '').toContain('the branch budget was rejected');
    expect(store.runningIds()).toEqual([]);
  });

  test('with nothing to hand over it fails — and says the bound, not just "evicted"', async () => {
    const { runner, store } = setup({ harvest: async () => null });
    store.create({ id: 'bgjob-empty', kind: 'agents', workMode: 'build', input: '{}', now: Date.now() });

    await runner.recoverOrphans();

    const job = store.get('bgjob-empty');
    expect(job?.status).toBe('failed');
    expect(job?.error ?? '').toContain('no partial result');
    expect(job?.result).toBeNull();
  });

  test('a harvester that throws leaves the job settling, never hanging', async () => {
    const { runner, store } = setup({
      harvest: async () => { throw new Error('the ledger is unreadable'); },
    });

    store.create({ id: 'bgjob-throws', kind: 'agents', workMode: 'build', input: '{}', now: Date.now() });
    await runner.recoverOrphans();

    expect(store.get('bgjob-throws')?.status).toBe('failed');
  });

  test('a job within its bound is still re-driven, so the bound cannot stop honest work', async () => {
    // Guard: a change that bounds everything would otherwise pass the tests above.
    let resumeCalls = 0;

    const { runner, store, settled } = setup({
      resume: async () => {
        resumeCalls += 1;

        return 'continued';
      },
      harvest: async () => ({ never: 'read' }),
    });

    store.create({ id: 'bgjob-young', kind: 'agents', workMode: 'build', input: '{}', now: Date.now() });

    await runner.recoverOrphans();
    await settled();

    expect(resumeCalls).toBe(1);
    expect(store.get('bgjob-young')?.status).toBe('completed');
    expect(String(store.get('bgjob-young')?.result)).toContain('continued');
  });

  test('the wake states which generation settled, so a re-driven job is not silently one attempt', async () => {
    const { runner, store, enqueued, settled } = setup({
      resume: async () => 'continued at last',
    });

    store.create({ id: 'bgjob-gen', kind: 'agents', workMode: 'build', input: '{}', now: Date.now() });
    store.reclaim('bgjob-gen');
    store.reclaim('bgjob-gen');

    await runner.recoverOrphans();
    await settled();

    expect(store.get('bgjob-gen')?.resumeAttempts).toBe(3);
    expect(enqueued[0]?.text ?? '').toContain('generation 4');
  });

  test('a failed job is not told to retry — that advice is what minted a second search', async () => {
    const { runner, store, enqueued, settled } = setup();
    const id = runner.create('agents', { action: 'swarm' }, 'build', new AbortController());
    runner.detach(id, 'agents', Promise.reject(new Error('the provider refused')));
    await settled();

    expect(store.get(id)?.status).toBe('failed');
    const text = enqueued[0]?.text ?? '';
    expect(text).toMatch(/do not\s+re-spawn/i);
    expect(text).not.toMatch(/whether to retry/i);
  });
});

describe('recoveryBackoffMs sanitizes counts the curve cannot use', () => {
  test('negatives floor at the first term, fractions truncate, non-finite waits the ceiling', () => {
    expect(recoveryBackoffMs(-1)).toBe(1_000);
    expect(recoveryBackoffMs(1.9)).toBe(2_000);
    expect(recoveryBackoffMs(Number.NaN)).toBe(60_000);
    expect(recoveryBackoffMs(Number.POSITIVE_INFINITY)).toBe(60_000);
  });
});

test('a recovered Plan job cannot mutate project files through a Build-shaped callback', async () => {
  const { rt } = createTestRuntime();
  const path = '/home/user/resumed.txt';
  await rt.storage.vfs.mkdir('/home/user', { recursive: true });
  await rt.storage.vfs.writeFile(path, 'original');
  const file = buildBuiltinTools({ rt, history: storesFor(rt).history }).file;

  if (file === undefined) throw new Error('No file tool');
  const write = toolExecute<JsonValue, JsonValue>(file);
  await write({ action: 'read', path });
  const first = setup();
  first.store.create({ id: 'plan-write', kind: 'shell', workMode: 'plan', input: '{}', now: Date.now() });
  const recovered = setup({ db: first.db, resume: async () => write({ action: 'write', path, content: 'changed' }) });
  await recovered.runner.recover({ jobId: 'plan-write', phase: 'running' });
  await recovered.settled();
  expect(await rt.storage.vfs.readFile(path, { encoding: 'utf8' })).toBe('original');
  expect(recovered.store.get('plan-write')).toMatchObject({ status: 'failed' });
  recovered.store.create({ id: 'build-write', kind: 'shell', workMode: 'build', input: '{}', now: Date.now() });
  await inWorkMode('plan', async () => {
    await recovered.runner.recover({ jobId: 'build-write', phase: 'running' });
    await recovered.settled();
  });
  expect(await rt.storage.vfs.readFile(path, { encoding: 'utf8' })).toBe('changed');
  expect(recovered.store.get('build-write')).toMatchObject({ status: 'completed' });
});
