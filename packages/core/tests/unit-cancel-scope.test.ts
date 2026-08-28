/**
 * What "Stop" reaches, and what it must not.
 *
 * The composer's Stop button ends the turn the person is looking at. A
 * background job has already left that turn — detaching is the whole point of
 * the >30s lane — so it keeps running, and stopping it needs its own id.
 *
 * These cases FORCE the interleaving rather than asserting an end state. The
 * defect was an ordering one (`cancelRunning()` ran before the foreground
 * abort), so a test that let the job settle first would pass over it: the job
 * would read `completed` either way. Each case here holds the detached job at
 * its settlement boundary, fires Stop while it is held, and only then releases.
 *
 * The negative control is the last case: the same held job IS stopped when its
 * id is named. Without it, "the job survived" would also be satisfied by a
 * harness in which nothing can cancel anything.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { BackgroundJobRunner } from '../src/jobs/runner';
import { BackgroundJobStore, initBackgroundJobsTable } from '../src/jobs/index';
import { EventLog, initEventsHubTables } from '../src/events/hub/index';
import { SignalDelivery } from '../src/orchestrator/signals';
import { cancelBackgroundJob, cancelCurrentWork } from '../src/read-models/background-jobs';
import type { BackendHost } from '../src/types/backend-host';
import type { Schedule } from '../src/types/primitives';
import type { JsonValue } from '../src/utils/json';
import { makeSql, makeExecRaw, makeSqlExec } from './helpers';

/** A fiber that runs its body inline and exposes the in-flight promises, so a
 *  test can decide WHEN the settlement completes. */
function inlineFiber() {
  const runs: Promise<unknown>[] = [];
  const fiber: Schedule['fiber'] = async (_name, fn) => {
    const body = fn({ stash: () => {}, snapshot: null });
    runs.push(body);
    return body;
  };
  return { fiber, settled: () => Promise.all(runs) };
}

function idleHost(): BackendHost {
  return {
    broadcast: () => {},
    enqueueTurn: async () => ({ status: 'queued' }),
    turnInFlight: () => false,
    setTimer: () => {},
  };
}

function scene() {
  const db = new Database(':memory:');
  initBackgroundJobsTable(makeExecRaw(db), makeSql(db));
  const hubSql = makeSqlExec(db);
  initEventsHubTables(hubSql);
  const { fiber, settled } = inlineFiber();
  const store = new BackgroundJobStore(makeSql(db));
  const runner = new BackgroundJobRunner({
    store,
    fiber,
    signals: new SignalDelivery(idleHost()),
    eventLog: new EventLog(hubSql),
    scheduleDrain: () => {},
    logActivity: () => {},
  });

  /** One detached job, held open. `release` is the settlement boundary. */
  const detachHeldJob = (kind = 'think') => {
    const controller = new AbortController();
    const jobId = runner.create(kind, { q: 1 }, 'build', controller);
    const gate = Promise.withResolvers<JsonValue | undefined>();
    runner.detach(jobId, kind, gate.promise);
    return { jobId, controller, release: gate.resolve };
  };

  const broadcasts: string[] = [];
  const activeToolControllers = new Set<AbortController>();
  const stop = () => cancelCurrentWork({
    activeToolControllers,
    broadcast: (payload) => { broadcasts.push(payload); },
  });

  return { store, runner, settled, detachHeldJob, activeToolControllers, stop, broadcasts };
}

describe('Stop scopes to the displayed turn', () => {
  test('a detached job held at its settlement boundary survives Stop and completes', async () => {
    const s = scene();
    const job = s.detachHeldJob();
    const foreground = new AbortController();
    s.activeToolControllers.add(foreground);

    // Stop fires with the job's settlement still un-run: this is the interleaving
    // the old ordering lost, because `cancelRunning()` ran first and aborted the
    // job's own signal before the foreground abort it was asked for.
    const outcome = await s.stop();

    expect(outcome).toEqual({ ok: true, abortedTools: 1, deviceCommands: [], returnedSteers: [] });
    expect(foreground.signal.aborted).toBe(true);
    // The job's own handle is untouched, and its row still reads running: the
    // work has not been told to stop and nothing has settled it.
    expect(job.controller.signal.aborted).toBe(false);
    expect(s.store.get(job.jobId)?.status).toBe('running');

    // Only now does the held work finish — and it finishes as its own work,
    // not as a casualty of a turn that ended.
    job.release('the answer');
    await s.settled();

    expect(s.store.get(job.jobId)?.status).toBe('completed');
    expect(s.store.get(job.jobId)?.result).toBe('"the answer"');
  });

  test('several detached jobs survive one Stop — one turn ending is not a fleet shutdown', async () => {
    const s = scene();
    const search = s.detachHeldJob('think');
    const release = s.detachHeldJob('run');

    await s.stop();

    expect(search.controller.signal.aborted).toBe(false);
    expect(release.controller.signal.aborted).toBe(false);
    expect(s.store.get(search.jobId)?.status).toBe('running');
    expect(s.store.get(release.jobId)?.status).toBe('running');

    search.release('found it');
    release.release('shipped');
    await s.settled();

    expect(s.store.get(search.jobId)?.status).toBe('completed');
    expect(s.store.get(release.jobId)?.status).toBe('completed');
  });

  test('Stop says what it did and never reports a background job', async () => {
    const s = scene();
    s.detachHeldJob();
    s.activeToolControllers.add(new AbortController());

    await s.stop();

    expect(s.broadcasts).toHaveLength(1);
    // Parsed, not cast. `strictObject` states the frame's WHOLE surface, so a
    // `cancelledJobs` that came back would fail here — which is a real assertion
    // about the wire rather than a spelling of `Object.keys`.
    const frame = v.parse(v.strictObject({
      type: v.literal('work_cancelled'),
      abortedTools: v.number(),
      deviceCommands: v.array(v.object({
        outcome: v.picklist(['terminated', 'unknown', 'failed']),
        detail: v.optional(v.string()),
      })),
      timestamp: v.number(),
    }), JSON.parse(s.broadcasts[0]!));

    expect(frame.abortedTools).toBe(1);
  });

  /**
   * The negative control. Naming the job is what stops it, so the survival
   * asserted above is a scoping decision rather than a harness in which
   * cancellation is unreachable.
   */
  test('naming the job is what stops it', async () => {
    const s = scene();
    const job = s.detachHeldJob();

    await cancelBackgroundJob(s.runner, job.jobId);

    expect(job.controller.signal.aborted).toBe(true);
    expect(s.store.get(job.jobId)?.status).toBe('cancelled');

    job.release(undefined);
    await s.settled();
  });
});
