// BackgroundJobRunner — the backend-agnostic >30s-detach lifecycle (re-arch P4).
// Verifies the durable-fiber detach → settle/fail → programmatic-turn wake, the
// operator hard-cancel, and the evict-mid-flight recovery — over a fake fiber +
// fake BackendHost, with no DO.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { BackgroundJobRunner, JobNotResumable, type JobResumer } from '../src/jobs/runner.js';
import { BackgroundJobStore, initBackgroundJobsTable } from '../src/jobs/index.js';
import { buildDrainBatch, EventLog, initEventsHubTables } from '../src/events/hub/index.js';
import type { BackendHost, ProgrammaticTurn } from '../src/types/backend-host.js';
import type { Schedule } from '../src/types/primitives.js';
import { makeSql, makeExecRaw } from './helpers.js';

/** A fiber that runs the body inline + captures each ctx.stash + exposes the
 *  in-flight body promises so a test can await detach completion. */
function fakeFiber() {
  const stashes: unknown[] = [];
  const runs: Promise<unknown>[] = [];
  const fiber: Schedule['fiber'] = async (_name, fn) => {
    const body = fn({ stash: (d: unknown) => { stashes.push(d); }, snapshot: null });
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
    injectIntoActiveTurn: () => false,
    setTimer: () => {},
  };
  return {
    host,
    enqueued,
    setStatus: (s: 'queued' | 'skipped') => { status = s; rejection = null; },
    setRejection: (error: Error) => { rejection = error; },
  };
}

function setup(opts: { resume?: JobResumer } = {}) {
  const db = new Database(':memory:');
  initBackgroundJobsTable(makeExecRaw(db));
  const store = new BackgroundJobStore(makeSql(db));
  const hubSql = {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.query(query).all(...bindings as never[]) as Array<Record<string, unknown>>;
      return { toArray: () => rows };
    },
  };
  initEventsHubTables(hubSql);
  const eventLog = new EventLog(hubSql);
  const { fiber, stashes, runs, settled } = fakeFiber();
  const { host, enqueued, setStatus, setRejection } = fakeHost();
  const logs: Array<{ e: string; d?: string }> = [];
  const notified: Array<{ id: string; status: string }> = [];
  let drainSchedules = 0;
  const runner = new BackgroundJobRunner({
    store, fiber, host, eventLog,
    scheduleDrain: () => { drainSchedules++; },
    logActivity: (e, d) => logs.push({ e, d }),
    onSettled: (job) => notified.push({ id: job.id, status: job.status }),
    ...(opts.resume ? { resume: opts.resume } : {}),
  });
  return {
    runner, store, eventLog, stashes, runs, settled, host, enqueued,
    setStatus, setRejection, logs, notified, drainSchedules: () => drainSchedules,
  };
}

describe('BackgroundJobRunner.detach — settle/fail → wake', () => {
  test('resolving work settles the job + wakes a synthesis turn (once)', async () => {
    const { runner, store, eventLog, enqueued, stashes, settled, notified } = setup();
    const id = runner.create('think', { q: 1 }, new AbortController());
    expect(store.get(id)?.status).toBe('running');

    runner.detach(id, 'think', Promise.resolve('the answer'));
    await settled();

    const job = store.get(id);
    expect(job?.status).toBe('completed');
    expect(job?.result).toBe('"the answer"');               // serializeJobResult
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].text).toContain(id);
    expect(enqueued[0].text).toContain('completed');
    expect(enqueued[0].metadata?.proteusEvent).toBe('background_job');
    expect(enqueued[0].metadata?.status).toBe('completed');
    expect(stashes).toEqual([
      { phase: 'running', jobId: id, kind: 'think' },
      { phase: 'settled', jobId: id, kind: 'think' },
    ]);
    // The notification seam fired once, with the settled job.
    expect(notified).toEqual([{ id, status: 'completed' }]);
    expect(eventLog.pending()).toEqual([]);
  });

  test('rejecting work fails the job + the wake says failed', async () => {
    const { runner, store, enqueued, settled, notified } = setup();
    const id = runner.create('run', {}, new AbortController());
    runner.detach(id, 'run', Promise.reject(new Error('boom')));
    await settled();

    expect(store.get(id)?.status).toBe('failed');
    expect(store.get(id)?.error).toBe('boom');
    expect(enqueued[0].text).toContain('failed');
    expect(enqueued[0].text).toContain('boom');
    expect(enqueued[0].metadata?.status).toBe('failed');
    expect(notified).toEqual([{ id, status: 'failed' }]);
  });

  test('a skipped wake publishes a self-trusted retry event for the standard drain', async () => {
    const { runner, store, eventLog, setStatus, logs, settled, drainSchedules } = setup();
    setStatus('skipped');
    const id = runner.create('think', {}, new AbortController());
    runner.detach(id, 'think', Promise.resolve('ok'));
    await settled();

    expect(store.get(id)?.status).toBe('completed');        // result retained
    expect(logs.find((l) => l.e === 'bg_job_wake_skipped')).toBeTruthy();
    const pending = eventLog.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ variant: 'timer', trust: 'self', priority: 'normal' });
    expect((pending[0]!.payload as { trigger_id: string }).trigger_id).toBe(`background-job-wake:${id}`);
    expect(buildDrainBatch(pending)?.text).toContain(`agent.jobResult('${id}')`);
    expect(drainSchedules()).toBe(1);
  });

  test('a rejected wake publishes the same durable retry event', async () => {
    const { runner, eventLog, setRejection, settled, drainSchedules } = setup();
    setRejection(new Error('queue unavailable'));
    const id = runner.create('run', {}, new AbortController());
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
    const id = runner.create('run', {}, new AbortController());
    store.settle(id, 0, '"saved"', Date.now());
    eventLog.publish = () => { throw new Error('ledger unavailable'); };

    await expect(runner.wake(id)).rejects.toThrow('ledger unavailable');
  });

  test('an undeliverable wake still drives the fiber to a terminal snapshot', async () => {
    const { runner, store, eventLog, stashes, settled, setRejection } = setup();
    setRejection(new Error('queue unavailable'));
    eventLog.publish = () => { throw new Error('ledger unavailable'); };
    const id = runner.create('think', {}, new AbortController());

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
    const id = runner.create('think', {}, new AbortController());
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

describe('BackgroundJobRunner.cancel — operator hard-cancel', () => {
  test('cancel aborts the work + marks cancelled; the fiber does not relabel or wake', async () => {
    const { runner, store, enqueued, settled } = setup();
    const controller = new AbortController();
    const id = runner.create('run', {}, controller);
    let reject!: (e: unknown) => void;
    runner.detach(id, 'run', new Promise((_, r) => { reject = r; }));

    expect(runner.cancel(id)).toBe(true);
    expect(store.get(id)?.status).toBe('cancelled');
    expect(controller.signal.aborted).toBe(true);
    expect(runner.cancel(id)).toBe(false);                  // already settled → no-op

    reject(new Error('aborted'));                            // the work unwinds on its abort
    await settled();
    expect(store.get(id)?.status).toBe('cancelled');        // NOT relabelled failed
    expect(enqueued).toHaveLength(0);                        // no synthesis wake
  });

  test('cancelRunning aborts every running job and leaves settled jobs alone', async () => {
    const { runner, store } = setup();
    const c1 = new AbortController();
    const c2 = new AbortController();
    const id1 = runner.create('run', { one: true }, c1);
    const id2 = runner.create('think', { two: true }, c2);
    const done = runner.create('run', { done: true }, new AbortController());
    store.settle(done, 0, '"done"', Date.now());

    expect(new Set(runner.cancelRunning())).toEqual(new Set([id1, id2]));

    expect(store.get(id1)?.status).toBe('cancelled');
    expect(store.get(id2)?.status).toBe('cancelled');
    expect(store.get(done)?.status).toBe('completed');
    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(true);
  });
});

describe('BackgroundJobRunner.recover — evict mid-flight', () => {
  test('a job stashed running is failed + woken', async () => {
    const { runner, store, enqueued } = setup();
    const id = runner.create('think', {}, new AbortController());
    await runner.recover({ jobId: id, phase: 'running' });

    expect(store.get(id)?.status).toBe('failed');
    expect(store.get(id)?.error).toContain('eviction');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].metadata?.status).toBe('failed');
  });

  test('a job already stashed settled is NOT re-failed or re-woken', async () => {
    const { runner, store, enqueued } = setup();
    const id = runner.create('think', {}, new AbortController());
    store.settle(id, 0, '"x"', 123);
    await runner.recover({ jobId: id, phase: 'settled' });

    expect(store.get(id)?.status).toBe('completed');
    expect(enqueued).toHaveLength(0);
  });

  test('an outcome persisted before the settled checkpoint is re-woken without duplicate notification', async () => {
    const { runner, store, enqueued, notified } = setup();
    const id = runner.create('think', {}, new AbortController());
    store.settle(id, 0, '"saved"', Date.now());

    await runner.recover({ jobId: id, phase: 'running' });

    expect(store.get(id)?.status).toBe('completed');
    expect(enqueued).toHaveLength(1);
    expect(notified).toEqual([]);
  });

  test('a cancelled outcome with a running checkpoint stays silent on recovery', async () => {
    const { runner, store, enqueued } = setup();
    const id = runner.create('think', {}, new AbortController());
    store.cancel(id, 0, Date.now());

    await runner.recover({ jobId: id, phase: 'running' });

    expect(store.get(id)?.status).toBe('cancelled');
    expect(enqueued).toEqual([]);
  });
});

describe('BackgroundJobRunner.recover — resume from durable checkpoint', () => {
  test('a resumable job is reclaimed under a fresh epoch and re-driven to completion', async () => {
    let seenInput: unknown = undefined;
    const resume: JobResumer = async (_kind, input) => { seenInput = input; return { text: 'resumed answer' }; };
    const { runner, store, enqueued, settled, notified, logs } = setup({ resume });
    // A job created with its tool input, then interrupted mid-flight (stashed running).
    store.create({ id: 'jr', kind: 'think', input: '{"strategy":"mcts","task":"t"}', now: 1 });

    await runner.recover({ jobId: 'jr', phase: 'running' });
    await settled(); // let the re-drive fiber finish

    const job = store.get('jr');
    expect(job?.epoch).toBe(1);                         // reclaimed → dead executor fenced
    expect(job?.resumeAttempts).toBe(1);
    expect(job?.status).toBe('completed');
    expect(job?.result).toBe('{"text":"resumed answer"}');
    expect(seenInput).toEqual({ strategy: 'mcts', task: 't' });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].metadata?.status).toBe('completed');
    expect(notified).toEqual([{ id: 'jr', status: 'completed' }]);
    expect(logs.find((l) => l.e === 'bg_job_resume')).toBeTruthy();
  });

  test('a kind the resumer cannot re-drive falls back to the eviction failure', async () => {
    const resume: JobResumer = async (kind) => { throw new JobNotResumable(kind); };
    const { runner, store, enqueued, settled } = setup({ resume });
    store.create({ id: 'jn', kind: 'run', input: '{}', now: 1 });

    await runner.recover({ jobId: 'jn', phase: 'running' });
    await settled();

    expect(store.get('jn')?.status).toBe('failed');
    expect(store.get('jn')?.error).toContain('eviction');
    expect(enqueued[0].metadata?.status).toBe('failed');
  });

  test('a job that evicts on every activation is failed after the resume-attempt cap', async () => {
    const resume: JobResumer = () => new Promise<never>(() => {}); // never settles ⇒ evicted again
    const { runner, store, enqueued } = setup({ resume });
    store.create({ id: 'jc', kind: 'think', input: '{}', now: 1 });

    // Five recoveries re-drive; the sixth exceeds the cap and fails the job.
    for (let i = 0; i < 6; i++) await runner.recover({ jobId: 'jc', phase: 'running' });

    const job = store.get('jc');
    expect(job?.status).toBe('failed');
    expect(job?.error).toContain('gave up');
    expect(job?.resumeAttempts).toBe(6);
    expect(enqueued.at(-1)?.metadata?.status).toBe('failed');
  });
});

describe('BackgroundJobRunner.thresholdDeps — withBackgroundThreshold wiring', () => {
  test('createJob mints a running job (carrying input) + logs bg_job_started', () => {
    const { runner, store, logs } = setup();
    const deps = runner.thresholdDeps('heads', { code: '1+1' }, new AbortController());
    const id = deps.createJob('heads');
    expect(store.get(id)?.status).toBe('running');
    expect(store.getInput(id)).toBe('{"code":"1+1"}');
    expect(logs).toContainEqual({ e: 'bg_job_started', d: `heads → ${id}` });
  });
});
