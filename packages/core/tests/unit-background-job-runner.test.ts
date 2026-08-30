// BackgroundJobRunner — the backend-agnostic >30s-detach lifecycle (re-arch P4).
// Verifies the durable-fiber detach → settle/fail → programmatic-turn wake, the
// operator hard-cancel, and the evict-mid-flight recovery — over a fake fiber +
// the real signal-delivery seam on a fake BackendHost, with no DO.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  BackgroundJobRunner, JobNotResumable, MAX_CONCURRENT_DETACHED_JOBS,
  type JobHarvester, type JobResumer,
} from '../src/jobs/runner';
import { SignalDelivery } from '../src/orchestrator/signals';
import {
  BackgroundJobStore, initBackgroundJobsTable, BACKGROUND_POLICY, DeviceRequestOwnership,
  type BackgroundPolicy, type BackgroundJob, type InvocationSurface,
} from '../src/jobs/index';
import { buildDrainBatch, EventLog, initEventsHubTables } from '../src/events/hub/index';
import type { BackendHost, ProgrammaticTurn } from '../src/types/backend-host';
import type { Schedule, SqlExecutor, SqlValue } from '../src/types/primitives';
import type { JsonValue } from '../src/utils/json';
import { makeSql, makeExecRaw, makeSqlExec } from './helpers';

/** A fiber that runs the body inline + captures each ctx.stash + exposes the
 *  in-flight body promises so a test can await detach completion. */
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

/** One process's view of the lifecycle. `db` is threaded when a test needs a
 *  SECOND process over the same durable rows — a restart, which is the only
 *  place orphan recovery can happen. */
function setup(opts: {
  resume?: JobResumer; policy?: BackgroundPolicy; db?: Database; harvest?: JobHarvester;
  onDetached?: (jobId: string, requestIds: readonly string[]) => Promise<void> | void;
  onCancelled?: (jobId: string) => Promise<void> | void;
} = {}) {
  const db = opts.db ?? new Database(':memory:');
  initBackgroundJobsTable(makeExecRaw(db), makeSql(db));
  // The registry behind a switchable fault, so a test can reproduce the one
  // failure the in-process settlement path cannot survive: teardown closing the
  // database out from under a fiber that is still running ("Cannot use a closed
  // database"), and then a LATER process opening the same durable rows.
  const realSql = makeSql(db);
  const storeFault = { closed: false };
  const sql = (<T = unknown>(strings: TemplateStringsArray, ...values: SqlValue[]): T[] => {
    if (storeFault.closed) throw new Error('Cannot use a closed database');
    return realSql<T>(strings, ...values);
  }) satisfies SqlExecutor;
  const store = new BackgroundJobStore(sql);
  const hubSql = makeSqlExec(db);
  initEventsHubTables(hubSql);
  const eventLog = new EventLog(hubSql);
  const { fiber, stashes, runs, settled } = fakeFiber();
  const { host, enqueued, setStatus, setRejection } = fakeHost();
  const logs: Array<{ e: string; d?: string }> = [];
  const notified: Array<{ id: string; status: string }> = [];
  let drainSchedules = 0;
  const runnerDeps = {
    store, fiber, signals: new SignalDelivery(host), eventLog,
    scheduleDrain: () => { drainSchedules++; },
    logActivity: (e: string, d?: string) => logs.push({ e, d }),
    onSettled: (job: BackgroundJob) => notified.push({ id: job.id, status: job.status }),
    onDetached: opts.onDetached,
    onCancelled: opts.onCancelled,
    resume: opts.resume,
    policy: opts.policy ? () => opts.policy! : undefined,
    harvest: opts.harvest,
  };
  const runner = new BackgroundJobRunner(runnerDeps);
  return {
    runner, runnerDeps, store, eventLog, stashes, runs, settled, host, enqueued,
    setStatus, setRejection, logs, notified, drainSchedules: () => drainSchedules,
    storeFault, db,
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
    expect(job?.result).toBe('"the answer"');               // serializeJobResult
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].text).toContain(id);
    expect(enqueued[0].text).toContain('completed');
    expect(enqueued[0].metadata?.kinuEvent).toBe('background_job');
    expect(enqueued[0].metadata?.status).toBe('completed');
    expect(stashes).toEqual([
      { phase: 'running', jobId: id, kind: 'think' },
      { phase: 'settled', jobId: id, kind: 'think' },
    ]);
    // The notification seam fired once, with the settled job.
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
    const deps = runner.thresholdDeps('run', {}, 'build', controller);
    const detaching = deps.onThreshold('run', Promise.resolve('done'));
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
    const id = runner.create('run', {}, 'build', new AbortController());
    runner.detach(id, 'run', Promise.reject(new Error('boom')));
    await settled();

    expect(store.get(id)?.status).toBe('failed');
    expect(store.get(id)?.error).toBe('boom');
    expect(enqueued[0].text).toContain('failed');
    expect(enqueued[0].text).toContain('boom');
    expect(enqueued[0].metadata?.status).toBe('failed');
    expect(notified).toEqual([{ id, status: 'failed' }]);
  });

  // The observability audit (2026-08-12): a 12-hour job showed "running" with
  // no way to tell whether it was hung or working. Start/refuse/cancel/resume
  // already reached logActivity; settle/fail — the terminal answer — did not.
  test('both settle and fail reach logActivity, not just start/cancel/resume', async () => {
    const { runner, settled, logs } = setup();
    const ok = runner.create('think', {}, 'build', new AbortController());
    runner.detach(ok, 'think', Promise.resolve('answer'));
    const bad = runner.create('run', {}, 'build', new AbortController());
    runner.detach(bad, 'run', Promise.reject(new Error('boom')));
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

    expect(store.get(id)?.status).toBe('completed');        // result retained
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
    const id = runner.create('run', {}, 'build', new AbortController());
    runner.detach(id, 'run', Promise.resolve('ok'));
    await settled();

    const pending = eventLog.pending();
    expect(pending).toHaveLength(1);
    expect(buildDrainBatch(pending)?.ids).toEqual([pending[0]!.id]);
    expect(buildDrainBatch(pending)?.text).toContain(id);
    expect(drainSchedules()).toBe(1);
  });

  test('a retry-ledger failure surfaces from wake', async () => {
    const { runner, store, eventLog, setRejection } = setup();
    setRejection(new Error('queue unavailable'));
    const id = runner.create('run', {}, 'build', new AbortController());
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
    // Both fiber implementations DELETE their recovery row in a `finally`, so a
    // rejected body is never handed to onFiberRecovered — it must not reject.
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

    // Recorded as failed rather than left running forever with no fiber alive.
    expect(store.get(id)?.status).toBe('failed');
    expect(store.get(id)?.error).toBe('storage unavailable');
    expect(notified).toEqual([{ id, status: 'failed' }]);
    expect(stashes.at(-1)).toEqual({ phase: 'settled', jobId: id, kind: 'think' });
  });
});

describe('BackgroundJobRunner.create — descriptive labels', () => {
  // `BackgroundJob.label` existed but the real runtime never populated it —
  // every running job showed as a bare "agents running" with no clue what it
  // was actually doing. Same audit as the logActivity fix above.
  test('a backgrounded search labels the task it is running', () => {
    const { runner, store } = setup();
    const id = runner.create('agents', { action: 'swarm', task: 'investigate the flaky test' }, 'build', new AbortController());
    expect(store.get(id)?.label).toBe('search: investigate the flaky test');
  });

  test('a run call labels the runtime + command', () => {
    const { runner, store } = setup();
    const id = runner.create('run', { runtime: 'sandbox', command: 'npm test' }, 'build', new AbortController());
    expect(store.get(id)?.label).toBe('sandbox: npm test');
  });

  test('an execute_tools call labels the code snippet', () => {
    const { runner, store } = setup();
    const id = runner.create('execute_tools', { code: '  const x = await workspace.readFile("/a");\n  return x;' }, 'build', new AbortController());
    expect(store.get(id)?.label).toBe('const x = await workspace.readFile("/a");\n  return x;');
  });

  test('an unrecognized shape gets no label rather than a guess', () => {
    const { runner, store } = setup();
    const id = runner.create('agents', { action: 'hire', agent: 'x' }, 'build', new AbortController());
    expect(store.get(id)?.label).toBeNull();
  });
});

describe('BackgroundJobRunner.cancel — operator hard-cancel', () => {
  test('cancel aborts the work, marks cancelled, and WAKES the agent; the fiber does not relabel or wake again', async () => {
    const { runner, store, enqueued, settled } = setup();
    const controller = new AbortController();
    const id = runner.create('run', {}, 'build', controller);
    const work = Promise.withResolvers<never>();
    runner.detach(id, 'run', work.promise);

    expect(await runner.cancel(id)).toBe(true);
    expect(store.get(id)?.status).toBe('cancelled');
    expect(controller.signal.aborted).toBe(true);
    expect(await runner.cancel(id)).toBe(false);             // already settled → no-op

    // The agent was told once, and told the truth: cancelled, no result to
    // collect. Without this the agent goes on believing the job is in flight.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.text).toContain('CANCELLED by the operator');
    expect(enqueued[0]?.text).toContain('no result to collect');

    work.reject(new Error('aborted'));                       // the work unwinds on its abort
    await settled();
    expect(store.get(id)?.status).toBe('cancelled');        // NOT relabelled failed
    expect(enqueued).toHaveLength(1);                        // and not woken a second time
  });

  test('cancelling one detached job cancels only its transferred external work', async () => {
    const cancelled: string[] = [];
    const { runner, settled } = setup({ onCancelled: async (jobId) => { cancelled.push(jobId); } });
    const id = runner.create('run', {}, 'build', new AbortController());
    const work = Promise.withResolvers<never>();
    runner.detach(id, 'run', work.promise);

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
    const id = runner.create('run', {}, 'build', controller);
    const work = Promise.withResolvers<never>();
    runner.detach(id, 'run', work.promise);

    expect(await runner.cancel(id)).toBe(false);
    expect(store.get(id)?.status).toBe('running');
    expect(controller.signal.aborted).toBe(false);
    expect(await runner.cancel(id)).toBe(true);
    expect(store.get(id)?.status).toBe('cancelled');
    expect(controller.signal.aborted).toBe(true);

    work.reject(new Error('aborted'));
    await settled();
  });

  // Blocker 2. The external cancel must be confirmed BEFORE the job is marked
  // terminal (the test above is why), and the job's own work can finish inside
  // that await. Without a fence the settle path recorded `completed` over a
  // cancel in progress, so the operator's cancel then landed on an
  // already-terminal job and the device work it named was never stopped.
  test('work that RESOLVES while the external cancel is confirming does not settle over it', async () => {
    const confirm = Promise.withResolvers<void>();
    const { runner, store, settled, enqueued } = setup({ onCancelled: () => confirm.promise });
    const id = runner.create('run', {}, 'build', new AbortController());
    const work = Promise.withResolvers<string>();
    runner.detach(id, 'run', work.promise);

    const cancelling = runner.cancel(id);
    work.resolve('the command finished anyway');
    await settled();
    // The fiber has run to its end and recorded NOTHING: the cancel owns the row.
    expect(store.get(id)?.status).toBe('running');

    confirm.resolve();
    expect(await cancelling).toBe(true);
    expect(store.get(id)?.status).toBe('cancelled');
    // One wake, and it is the cancel's — not a completion the operator stopped.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.text).toContain('no result to collect');
  });

  test('work that REJECTS in that same window is not recorded failed either', async () => {
    const confirm = Promise.withResolvers<void>();
    const { runner, store, settled, notified } = setup({ onCancelled: () => confirm.promise });
    const id = runner.create('run', {}, 'build', new AbortController());
    const work = Promise.withResolvers<never>();
    runner.detach(id, 'run', work.promise);

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
      onCancelled: () => { externalCancels += 1; return confirm.promise; },
    });
    const id = runner.create('run', {}, 'build', new AbortController());
    const work = Promise.withResolvers<never>();
    runner.detach(id, 'run', work.promise);

    const first = runner.cancel(id);
    // The operator clicking Stop twice: the row still says running, so only the
    // fence can tell this apart from a fresh cancel.
    expect(await runner.cancel(id)).toBe(false);
    expect(externalCancels).toBe(1);

    confirm.resolve();
    expect(await first).toBe(true);
    expect(store.get(id)?.status).toBe('cancelled');

    work.reject(new Error('aborted'));
    await settled();
  });

  test('a REFUSED cancel hands back the outcome its work reached while refusing', async () => {
    // The other side of the fence. The refusal leaves the job running by its own
    // rule, so the work that finished under it is still the job's real story —
    // holding that outcome back forever would strand a `running` row with no
    // executor and no result.
    const confirm = Promise.withResolvers<void>();
    const { runner, store, settled, enqueued } = setup({
      onCancelled: async () => { await confirm.promise; throw new Error('device unavailable'); },
    });
    const id = runner.create('run', {}, 'build', new AbortController());
    const work = Promise.withResolvers<string>();
    runner.detach(id, 'run', work.promise);

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
    const id1 = runner.create('run', { one: true }, 'build', c1);
    const id2 = runner.create('think', { two: true }, 'build', c2);
    const done = runner.create('run', { done: true }, 'build', new AbortController());
    store.settle(done, 0, '"done"', Date.now());

    expect(new Set(runner.cancelRunning())).toEqual(new Set([id1, id2]));

    expect(store.get(id1)?.status).toBe('cancelled');
    expect(store.get(id2)?.status).toBe('cancelled');
    expect(store.get(done)?.status).toBe('completed');
    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(true);
  });
});

// Recovery always runs against rows a DEAD executor left behind, so these
// start from the durable row alone — an evicted runner's in-memory cancel
// handles went with the process that held them.
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
    // A job created with its tool input, then interrupted mid-flight (stashed running).
    store.create({ id: 'jr', kind: 'think', workMode: 'plan', input: '{"strategy":"mcts","task":"t"}', now: Date.now() });

    await runner.recover({ jobId: 'jr', phase: 'running' });
    await settled(); // let the re-drive fiber finish

    const job = store.get('jr');
    expect(job?.epoch).toBe(1);                         // reclaimed → dead executor fenced
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
    store.create({ id: 'jn', kind: 'run', workMode: 'build', input: '{}', now: Date.now() });

    await runner.recover({ jobId: 'jn', phase: 'running' });
    await settled();

    expect(store.get('jn')?.status).toBe('failed');
    expect(store.get('jn')?.error).toContain('eviction');
    expect(enqueued[0].metadata?.status).toBe('failed');
  });

  test('a job that evicts on every activation is failed after the resume-attempt cap', async () => {
    const resume: JobResumer = () => new Promise<never>(() => {}); // never settles ⇒ evicted again
    const first = setup({ resume });
    first.store.create({ id: 'jc', kind: 'think', workMode: 'build', input: '{}', now: Date.now() });

    // One activation per recovery — a re-drive lives in the activation that
    // started it, and the next eviction brings up a new one.
    let last = first;
    for (let activation = 0; activation < 6; activation++) {
      last = setup({ resume, db: first.db });
      await last.runner.recover({ jobId: 'jc', phase: 'running' });
    }

    const job = first.store.get('jc');
    expect(job?.status).toBe('failed');
    expect(job?.error).toContain('gave up');
    expect(job?.resumeAttempts).toBe(5);
    expect(last.enqueued.at(-1)?.metadata?.status).toBe('failed');
    expect(last.enqueued.at(-1)?.text ?? '').toContain('generation 6');
  });

  test('a job this runner is already driving is never re-driven out from under itself', async () => {
    // A resume leaves a fiber row of its own, so one cold start can hand the
    // SAME job to recover() twice — and the registry sweep names it as well.
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

// The field failure this sweep exists for: a one-shot CLI run detached a job,
// gave up waiting on it, and closed its database — after which the fiber's
// settle write AND its last-resort force-fail both failed against the same dead
// handle ("background-job settlement failed" / "force-fail failed", verbatim).
// The row stayed 'running' with no fiber row left pointing at it, so a
// fiber-keyed recovery never looked at it again: never resumed to a result,
// never failed, and permanently holding one of the detach slots.
describe('BackgroundJobRunner.recoverOrphans — a job cannot stay running forever', () => {
  test('a settlement whose store closed under it strands the row — and the next start settles it', async () => {
    const { runner, store, storeFault, settled, enqueued, db } = setup();
    const id = runner.create('run', { command: 'sleep 1' }, 'build', new AbortController());
    let finish: () => void = () => {};
    runner.detach(id, 'run', new Promise<string>((resolve) => { finish = () => resolve('done'); }));

    // Teardown: the process gave up on the fiber and closed the database.
    storeFault.closed = true;
    finish();
    await settled();

    // Reproduction: neither the outcome nor the force-fail could be written.
    storeFault.closed = false;
    expect(store.get(id)?.status).toBe('running');

    // A later process over the same rows: nothing in memory owns this job, and
    // no fiber row survived to announce it — the registry sweep is the only
    // thing that can still reach it.
    const next = setup({ db });
    await next.runner.recoverOrphans();

    expect(next.store.get(id)?.status).toBe('failed');
    expect(next.store.get(id)?.error).toContain('eviction');
    expect(next.enqueued.at(-1)?.metadata?.status).toBe('failed');
    expect(enqueued).toHaveLength(0); // the stranded process woke nobody
  });

  test('resuming is bounded: repeated restarts end in a terminal status, not another re-drive', async () => {
    const resume: JobResumer = () => new Promise<never>(() => {}); // never settles ⇒ orphaned again
    const first = setup({ resume });
    first.store.create({ id: 'jz', kind: 'agents', workMode: 'build', input: '{}', now: Date.now() });

    // Each restart finds the row, reclaims it, and re-drives — until the cap.
    for (let start = 0; start < 6; start++) {
      await setup({ resume, db: first.db }).runner.recoverOrphans();
    }

    const job = first.store.get('jz');
    expect(job?.status).toBe('failed');
    expect(job?.error).toContain('gave up');
    expect(first.store.runningIds()).toEqual([]);
  });

  test('a job whose executor is alive in THIS process is not reclaimed as an orphan', async () => {
    const resume: JobResumer = async () => 'should not run';
    const { runner, store, settled } = setup({ resume });
    let finish: () => void = () => {};
    const id = runner.create('run', {}, 'build', new AbortController());
    runner.detach(id, 'run', new Promise<string>((resolve) => { finish = () => resolve('real result'); }));

    await runner.recoverOrphans();
    expect(store.get(id)?.resumeAttempts).toBe(0);

    finish();
    await settled();
    expect(store.get(id)?.result).toBe('"real result"');
  });
});

describe('BackgroundJobRunner.thresholdDeps — withBackgroundThreshold wiring', () => {
  test('crossing the threshold mints a running job (carrying input) + logs bg_job_started', async () => {
    const { runner, store, logs } = setup();
    const deps = runner.thresholdDeps('heads', { code: '1+1' }, 'build', new AbortController());
    const outcome = await deps.onThreshold('heads', new Promise(() => { /* still running */ }));
    expect(outcome.detached).toBe(true);
    const id = outcome.detached ? outcome.jobId : '';
    expect(store.get(id)?.status).toBe('running');
    expect(store.getInput(id)).toBe('{"code":"1+1"}');
    expect(logs).toContainEqual({ e: 'bg_job_started', d: `heads → ${id}` });
  });

  test('the threshold carries the session surface\'s detach policy', () => {
    const { runner } = setup();
    expect(runner.thresholdDeps('run', {}, 'build', new AbortController()).thresholdMs)
      .toBe(BACKGROUND_POLICY.interactive.detachAfterMs);

    const oneShot = setup({ policy: BACKGROUND_POLICY['one-shot'] });
    expect(oneShot.runner.thresholdDeps('run', {}, 'build', new AbortController()).thresholdMs)
      .toBe(BACKGROUND_POLICY['one-shot'].detachAfterMs);

    // Resolved per read, not captured once: a backend whose surface is a
    // property of the TURN (the cloud DO serves a watched chat turn and an
    // unwatched drain from one agent) switches policy between calls.
    let surface: InvocationSurface = 'interactive';
    const perTurn = new BackgroundJobRunner({
      ...oneShot.runnerDeps, policy: () => BACKGROUND_POLICY[surface],
    });
    expect(perTurn.policy.detachAfterMs).toBe(BACKGROUND_POLICY.interactive.detachAfterMs);
    surface = 'one-shot';
    expect(perTurn.policy.detachAfterMs).toBe(BACKGROUND_POLICY['one-shot'].detachAfterMs);
    // A one-shot run has no human waiting on a fast turn, and a detach there
    // costs a truncated turn plus a synthesis turn — so ordinary long work runs
    // to completion inline instead.
    expect(BACKGROUND_POLICY['one-shot'].detachAfterMs)
      .toBeGreaterThan(BACKGROUND_POLICY.interactive.detachAfterMs);
  });

  test('past the concurrency cap classifies refusal without aborting foreground work', async () => {
    const { runner, store, logs } = setup();
    for (let i = 0; i < MAX_CONCURRENT_DETACHED_JOBS; i++) {
      store.create({ id: `busy-${i}`, kind: 'run', workMode: 'build', input: '{}', now: Date.now() });
    }
    const controller = new AbortController();
    const work = Promise.withResolvers<string>();
    controller.signal.addEventListener('abort', () => {
      work.reject(new Error('the threshold aborted live work'));
    });
    const deps = runner.thresholdDeps('run', { command: 'pystan build' }, 'build', controller);
    const outcome = await deps.onThreshold('run', work.promise);

    expect(outcome.detached).toBe(false);
    if (outcome.detached) throw new Error('expected the full cap to refuse detach');
    // No ninth job: the cap stays hard, while this call keeps its foreground owner.
    expect(store.countRunning()).toBe(MAX_CONCURRENT_DETACHED_JOBS);
    expect(controller.signal.aborted).toBe(false);
    expect(outcome.reason).toContain('foreground');
    expect(outcome.reason).toContain('busy-0');
    expect(logs.some((l) => l.e === 'bg_job_refused')).toBe(true);

    work.resolve('completed without an implicit timeout');
    await expect(work.promise).resolves.toBe('completed without an implicit timeout');
  });

  test('under the cap a refusal never happens — the boundary is exact', async () => {
    const { runner, store } = setup();
    for (let i = 0; i < MAX_CONCURRENT_DETACHED_JOBS - 1; i++) {
      store.create({ id: `busy-${i}`, kind: 'run', workMode: 'build', input: '{}', now: Date.now() });
    }
    const outcome = await runner
      .thresholdDeps('run', {}, 'build', new AbortController())
      .onThreshold('run', new Promise(() => { /* still running */ }));
    expect(outcome.detached).toBe(true);
  });

  test('a settled job frees a slot — the cap counts what is in flight, not what ever ran', async () => {
    const { runner, store } = setup();
    for (let i = 0; i < MAX_CONCURRENT_DETACHED_JOBS; i++) {
      store.create({ id: `busy-${i}`, kind: 'run', workMode: 'build', input: '{}', now: Date.now() });
    }
    store.settle('busy-0', 0, 'done', Date.now());
    const outcome = await runner
      .thresholdDeps('run', {}, 'build', new AbortController())
      .onThreshold('run', new Promise(() => { /* still running */ }));
    expect(outcome.detached).toBe(true);
  });

  test('the detach transfers what the call had issued, and OWNS what it issues next', async () => {
    // Blocker 1. The handover used to be a snapshot taken at the crossing, so a
    // request the tool issued afterwards — an `execute_tools` script still
    // launching laptop commands minutes later — belonged to nobody: the turn was
    // over and the transfer had already named its set. The claim now lands
    // BEFORE the transfer is awaited, so a request issued from that moment on is
    // registered under the job at its own INSERT.
    const ownership = new DeviceRequestOwnership();
    ownership.report('req-1');
    ownership.report('req-2');
    const received: string[][] = [];
    const ownersDuringTransfer: Array<string | null> = [];
    const { runner } = setup({
      onDetached: async (_jobId, requestIds) => {
        received.push([...requestIds]);
        // A laptop exec that starts while the handover is still in flight.
        ownersDuringTransfer.push(ownership.owningJobId);
        ownership.report('req-late');
      },
    });
    const outcome = await runner
      .thresholdDeps('run', {}, 'build', new AbortController(), ownership)
      .onThreshold('run', Promise.resolve('done'));

    expect(outcome.detached).toBe(true);
    const jobId = outcome.detached ? outcome.jobId : null;
    expect(received).toEqual([['req-1', 'req-2']]);
    expect(ownersDuringTransfer).toEqual([jobId]);
    expect(ownership.owningJobId).toBe(jobId);
    // `req-late` was never queued for a second transfer — it is the job's.
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
    const outcome = await runner
      .thresholdDeps('run', {}, 'build', controller, ownership)
      .onThreshold('run', work.promise);

    expect(outcome.detached).toBe(true);
    if (!outcome.detached) throw new Error('expected a job to preserve the live work');
    const jobId = outcome.jobId;
    expect(store.get(jobId)?.status).toBe('running');
    expect(controller.signal.aborted).toBe(false);
    expect(runner.inFlight).toBe(1);
    // A per-request transfer may already have moved a prefix, so the job remains
    // the only truthful owner for the live promise and later device requests.
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
 * A JOB'S LIFETIME IS BOUNDED AND TRUTHFUL ACROSS RE-ENTRY.
 *
 * Measured on the owner's live workspace: `bgjob-5irynqgciwkrmk4m77yo5`, kind
 * `agents`, `running` 28 minutes later at `epoch=4 resumeAttempts=4` — one reclaim
 * short of the cap — while the search it wrapped had TWO completed candidates with
 * real content. Every re-entry kept the job open, so the settle wake never arrived,
 * and the owner asked in these words: "Why isn't it giving up it's turn?"
 *
 * Two things were wrong and each has its own arm below. The job could not be made to
 * stop, because the attempt cap bounds GENERATIONS and nothing bounded TIME. And when
 * it did stop it would have settled with an eviction string, discarding candidates it
 * had really measured.
 *
 * THE DESIGN DECISION, since the ticket asked for one either way: ONE JOB CONTINUES
 * across re-entries rather than each generation settling and a new job starting. The
 * search itself is durable and re-enterable, and the job is the caller's handle on
 * that search — a job per generation would split one search across N rows each
 * holding a fragment, which is the same shape the search layer already rejected when
 * it stopped minting a second root. So identity stays, and what changes is that the
 * lifetime is bounded, the generation count is disclosed, and the terminal state
 * carries what the work has.
 *
 * Neither bound is exercised at its real value here, for the reason the stall
 * watchdog's suite gives about `STALL_TIMEOUT_MS`: a bound of fifty minutes cannot
 * be reached by a test that has to finish, and a generation count restated here
 * would only be this file comparing a number with itself. What is under test is the
 * RELATIONSHIP — a bound exists, it settles rather than hangs, and it carries the
 * partial — and the derivation of each number lives on its constant.
 */
describe('a background job gives up its turn, and hands over what it has', () => {

  test('the attempt clock is a column, and a reclaim starts a new generation on it', () => {
    // The reading nothing could do before: `createdAt` says when the work was first
    // asked for and `settledAt` is null while it runs, so "how long has THIS
    // generation been going" had no answer and nothing could bound it.
    const { store } = setup();
    store.create({ id: 'j1', kind: 'agents', workMode: 'build', input: '{}', now: 1_000 });
    expect(store.get('j1')?.attemptStartedAt).toBe(1_000);

    store.reclaim('j1', 5_000);
    expect(store.get('j1')).toMatchObject({
      attemptStartedAt: 5_000, resumeAttempts: 1, epoch: 1,
    });
  });

  test('a never-settling detached job is NOT killed by a clock — the ruling bound', async () => {
    // The former per-attempt wall clock (generations x the deleted turn envelope)
    // is gone by owner ruling, 2026-08-21: no wall clock over a turn-shaped piece
    // of work; the sanctioned bounds are one LLM call's silence window plus its
    // retries, and those run INSIDE every re-driven turn. A detached job runs
    // until its own bounds end it or an operator cancels it. This pin fails if
    // anyone grows a compensating timer back into this seam.
    const { runner, store } = setup();
    // Production mints the row through `create` before any detach can name it;
    // a fixed id here follows the bgjob-capped test below.
    store.create({ id: 'bgjob-immortal', kind: 'agents', workMode: 'build', input: '{}', now: Date.now() });
    runner.detach('bgjob-immortal', 'agents', new Promise(() => { /* never */ }));
    await new Promise((r) => setTimeout(r, 50));
    expect(store.get('bgjob-immortal')?.status).toBe('running');
  });

  test('past the resume cap it also settles with the partial, instead of an eviction string', async () => {
    const { runner, store, settled } = setup({
      resume: async () => 'never reached',
      harvest: async () => ({ rootId: 'root-2', candidates: [{ nodeId: 'n1', score: 0.4 }] }),
    });
    store.create({ id: 'bgjob-capped', kind: 'agents', workMode: 'build', input: '{}', now: Date.now() });
    // Driven past the cap. The incident's job was at exactly attempts=4, so the
    // reclaim after it is the one that used to discard its two completed
    // candidates. Reclaimed well past any cap rather than exactly to it: the
    // count is the runner's to own, and asserting it here only compared this
    // file's copy of the number with the runner's.
    for (let i = 0; i < 50; i++) store.reclaim('bgjob-capped');

    await runner.recoverOrphans();
    await settled();

    const job = store.get('bgjob-capped');
    expect(job?.status).toBe('completed');
    expect(job?.error).toBeNull();
    expect(String(job?.result)).toContain('root-2');
  });

  test('with nothing to hand over it fails — and says the bound, not just "evicted"', async () => {
    // The other direction. A bound reached over work that produced nothing is a
    // failure, and it must not pretend to be a partial success.
    const { runner, store } = setup({ harvest: async () => null });
    store.create({ id: 'bgjob-empty', kind: 'agents', workMode: 'build', input: '{}', now: Date.now() });

    // The executor was lost and no resumer exists for the kind, so recovery owns
    // the settlement — nothing bounds live work by time any more to do it.
    await runner.recoverOrphans();

    const job = store.get('bgjob-empty');
    expect(job?.status).toBe('failed');
    expect(job?.error ?? '').toContain('no partial result');
    expect(job?.result).toBeNull();
  });

  test('a harvester that throws leaves the job settling, never hanging', async () => {
    // The seam is on the recovery settle path, so a failing harvester must
    // degrade to the behaviour of having none rather than strand the job as a
    // hanging `running` row.
    const { runner, store } = setup({
      harvest: async () => { throw new Error('the ledger is unreadable'); },
    });
    store.create({ id: 'bgjob-throws', kind: 'agents', workMode: 'build', input: '{}', now: Date.now() });
    await runner.recoverOrphans();

    expect(store.get('bgjob-throws')?.status).toBe('failed');
  });

  test('a job within its bound is still re-driven, so the bound cannot stop honest work', async () => {
    // The guard. Without this arm a change that bounds everything passes the tests
    // above, and every resume in the product stops working.
    let resumeCalls = 0;
    const { runner, store, settled } = setup({
      resume: async () => { resumeCalls += 1; return 'continued'; },
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

    // Three generations: two prior reclaims plus the one recovery just took.
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
