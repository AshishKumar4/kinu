// BackgroundJobRunner — the backend-agnostic >30s-detach lifecycle (re-arch P4).
// Verifies the durable-fiber detach → settle/fail → programmatic-turn wake, the
// operator hard-cancel, and the evict-mid-flight recovery — over a fake fiber +
// the real signal-delivery seam on a fake BackendHost, with no DO.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { BackgroundJobRunner, JobNotResumable, MAX_CONCURRENT_DETACHED_JOBS, type JobResumer } from '../src/jobs/runner.js';
import { SignalDelivery } from '../src/orchestrator/signals.js';
import {
  BackgroundJobStore, initBackgroundJobsTable, BACKGROUND_POLICY,
  type BackgroundPolicy, type BackgroundJob, type SessionSurface,
} from '../src/jobs/index.js';
import { buildDrainBatch, EventLog, initEventsHubTables } from '../src/events/hub/index.js';
import type { BackendHost, ProgrammaticTurn } from '../src/types/backend-host.js';
import type { Schedule, SqlExecutor, SqlValue } from '../src/types/primitives.js';
import type { JsonValue } from '../src/utils/json.js';
import { makeSql, makeExecRaw, makeSqlExec } from './helpers.js';

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
function setup(opts: { resume?: JobResumer; policy?: BackgroundPolicy; db?: Database } = {}) {
  const db = opts.db ?? new Database(':memory:');
  initBackgroundJobsTable(makeExecRaw(db));
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
    resume: opts.resume,
    policy: opts.policy ? () => opts.policy! : undefined,
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
  test('an agents fork gets a settle-mode + task label', () => {
    const { runner, store } = setup();
    const id = runner.create('agents', { action: 'fork', task: 'investigate the flaky test', settle: 'mcts' }, 'build', new AbortController());
    expect(store.get(id)?.label).toBe('fork(settle=mcts): investigate the flaky test');
  });

  test('an agents fork with no settle defaults the label to merge', () => {
    const { runner, store } = setup();
    const id = runner.create('agents', { action: 'fork', task: 'split the work' }, 'build', new AbortController());
    expect(store.get(id)?.label).toBe('fork(settle=merge): split the work');
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
    const id = runner.create('agents', { action: 'staff', agent: 'x' }, 'build', new AbortController());
    expect(store.get(id)?.label).toBeNull();
  });
});

describe('BackgroundJobRunner.cancel — operator hard-cancel', () => {
  test('cancel aborts the work + marks cancelled; the fiber does not relabel or wake', async () => {
    const { runner, store, enqueued, settled } = setup();
    const controller = new AbortController();
    const id = runner.create('run', {}, 'build', controller);
    const rejections: Array<(error: Error) => void> = [];
    runner.detach(id, 'run', new Promise((_, rejectPromise) => {
      rejections.push((error) => rejectPromise(error));
    }));

    expect(runner.cancel(id)).toBe(true);
    expect(store.get(id)?.status).toBe('cancelled');
    expect(controller.signal.aborted).toBe(true);
    expect(runner.cancel(id)).toBe(false);                  // already settled → no-op

    const reject = rejections[0];
    if (!reject) throw new Error('work rejection was not captured');
    reject(new Error('aborted'));                            // the work unwinds on its abort
    await settled();
    expect(store.get(id)?.status).toBe('cancelled');        // NOT relabelled failed
    expect(enqueued).toHaveLength(0);                        // no synthesis wake
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
    store.create({ id, kind: 'think', workMode: 'build', input: '{}', now: 1 });
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
    store.create({ id: 'jr', kind: 'think', workMode: 'plan', input: '{"strategy":"mcts","task":"t"}', now: 1 });

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
    expect(enqueued[0].metadata?.proteusMode).toBe('plan');
    expect(notified).toEqual([{ id: 'jr', status: 'completed' }]);
    expect(logs.find((l) => l.e === 'bg_job_resume')).toBeTruthy();
  });

  test('a kind the resumer cannot re-drive falls back to the eviction failure', async () => {
    const resume: JobResumer = async (kind) => { throw new JobNotResumable(kind); };
    const { runner, store, enqueued, settled } = setup({ resume });
    store.create({ id: 'jn', kind: 'run', workMode: 'build', input: '{}', now: 1 });

    await runner.recover({ jobId: 'jn', phase: 'running' });
    await settled();

    expect(store.get('jn')?.status).toBe('failed');
    expect(store.get('jn')?.error).toContain('eviction');
    expect(enqueued[0].metadata?.status).toBe('failed');
  });

  test('a job that evicts on every activation is failed after the resume-attempt cap', async () => {
    const resume: JobResumer = () => new Promise<never>(() => {}); // never settles ⇒ evicted again
    const first = setup({ resume });
    first.store.create({ id: 'jc', kind: 'think', workMode: 'build', input: '{}', now: 1 });

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
    expect(job?.resumeAttempts).toBe(6);
    expect(last.enqueued.at(-1)?.metadata?.status).toBe('failed');
  });

  test('a job this runner is already driving is never re-driven out from under itself', async () => {
    // A resume leaves a fiber row of its own, so one cold start can hand the
    // SAME job to recover() twice — and the registry sweep names it as well.
    const resume: JobResumer = () => new Promise<never>(() => {});
    const { runner, store } = setup({ resume });
    store.create({ id: 'jd', kind: 'agents', workMode: 'build', input: '{}', now: 1 });

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
    first.store.create({ id: 'jz', kind: 'agents', workMode: 'build', input: '{}', now: 1 });

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
  test('crossing the threshold mints a running job (carrying input) + logs bg_job_started', () => {
    const { runner, store, logs } = setup();
    const deps = runner.thresholdDeps('heads', { code: '1+1' }, 'build', new AbortController());
    const outcome = deps.onThreshold('heads', new Promise(() => { /* still running */ }));
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
    let surface: SessionSurface = 'interactive';
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

  test('past the concurrency cap the detach is refused and the work is cancelled', () => {
    // A model that sees no result from a slow call launches another; without a
    // bound that compounds into a fork storm (52 concurrent builds → OOM kill).
    const { runner, store, logs } = setup();
    for (let i = 0; i < MAX_CONCURRENT_DETACHED_JOBS; i++) {
      store.create({ id: `busy-${i}`, kind: 'run', workMode: 'build', input: '{}', now: Date.now() });
    }
    const controller = new AbortController();
    const deps = runner.thresholdDeps('run', { command: 'pystan build' }, 'build', controller);
    const outcome = deps.onThreshold('run', new Promise(() => { /* still running */ }));

    expect(outcome.detached).toBe(false);
    // No new job: the cap is a cap, not a warning.
    expect(store.countRunning()).toBe(MAX_CONCURRENT_DETACHED_JOBS);
    // The work is stopped, not silently orphaned.
    expect(controller.signal.aborted).toBe(true);
    const reason = outcome.detached ? '' : outcome.reason;
    expect(reason).toContain('CANCELLED');
    expect(reason).toContain('busy-0');
    expect(logs.some((l) => l.e === 'bg_job_refused')).toBe(true);
  });

  test('under the cap a refusal never happens — the boundary is exact', () => {
    const { runner, store } = setup();
    for (let i = 0; i < MAX_CONCURRENT_DETACHED_JOBS - 1; i++) {
      store.create({ id: `busy-${i}`, kind: 'run', workMode: 'build', input: '{}', now: Date.now() });
    }
    const outcome = runner
      .thresholdDeps('run', {}, 'build', new AbortController())
      .onThreshold('run', new Promise(() => { /* still running */ }));
    expect(outcome.detached).toBe(true);
  });

  test('a settled job frees a slot — the cap counts what is in flight, not what ever ran', () => {
    const { runner, store } = setup();
    for (let i = 0; i < MAX_CONCURRENT_DETACHED_JOBS; i++) {
      store.create({ id: `busy-${i}`, kind: 'run', workMode: 'build', input: '{}', now: Date.now() });
    }
    store.settle('busy-0', 0, 'done', Date.now());
    const outcome = runner
      .thresholdDeps('run', {}, 'build', new AbortController())
      .onThreshold('run', new Promise(() => { /* still running */ }));
    expect(outcome.detached).toBe(true);
  });
});
