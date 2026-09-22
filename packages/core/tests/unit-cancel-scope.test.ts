/**
 * Stop ends the foreground turn but not a detached background job. Each case holds the job at its
 * settlement boundary and fires Stop while held, since a settled job reads `completed` either way.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { BackgroundJobRunner } from '../src/jobs/runner';
import { BackgroundJobStore, initBackgroundJobsTable } from '../src/jobs/index';
import { EventLog, initEventsHubTables } from '../src/events/hub/index';
import { Inbox } from '../src/orchestrator/inbox';
import { cancelBackgroundJob, cancelCurrentWork } from '../src/read-models/background-jobs';
import type { BackendHost } from '../src/types/backend-host';
import type { Schedule } from '../src/types/primitives';
import type { JsonValue } from '../src/utils/json';
import { makeSql, makeExecRaw, makeSqlExec } from './helpers';
import { createTestActorsOver } from '@kinu.run/test-utils';

/** A fiber running its body inline and exposing in-flight promises, so a test decides when settlement completes. */
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
  initBackgroundJobsTable(makeExecRaw(db));
  const hubSql = makeSqlExec(db);
  initEventsHubTables(hubSql);
  const { fiber, settled } = inlineFiber();
  // One actor for job store and inbox: two handles would file the notice where nothing drains it.
  const actor = createTestActorsOver(db).main;
  const store = new BackgroundJobStore(makeSql(db), actor);

  const runner = new BackgroundJobRunner({
    store,
    fiber,
    inbox: new Inbox(idleHost()),
    eventLog: new EventLog(hubSql, actor),
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
  /** The framework abort, in call order with the device sweep below. */
  const calls: string[] = [];
  /** Whether a foreground controller was already aborted when chats went. */
  let chatsSawAborted: boolean | null = null;

  const stop = () => cancelCurrentWork({
    cancelChats: () => {
      chatsSawAborted = [...activeToolControllers].some((c) => c.signal.aborted);
      calls.push('chats');
    },
    activeToolControllers,
    broadcast: (payload) => { broadcasts.push(payload); },
    stopDeviceCommands: async () => {
      calls.push('devices');

      return [];
    },
  });

  return { store, runner, settled, detachHeldJob, activeToolControllers, stop, broadcasts, calls, chatsSawAborted: () => chatsSawAborted };
}

describe('Stop scopes to the displayed turn', () => {
  test('a detached job held at its settlement boundary survives Stop and completes', async () => {
    const s = scene();
    const job = s.detachHeldJob();
    const foreground = new AbortController();
    s.activeToolControllers.add(foreground);

    // Stop fires while the job's settlement is still un-run.
    const outcome = await s.stop();

    expect(outcome).toEqual({ ok: true, abortedTools: 1, deviceCommands: [] });
    // The framework abort ran before the tool abort and the device sweep.
    expect(s.calls).toEqual(['chats', 'devices']);
    expect(s.chatsSawAborted()).toBe(false);
    expect(foreground.signal.aborted).toBe(true);
    expect(job.controller.signal.aborted).toBe(false);
    expect(s.store.get(job.jobId)?.status).toBe('running');

    job.release('the answer');
    await s.settled();

    expect(s.store.get(job.jobId)?.status).toBe('completed');
    expect(s.store.get(job.jobId)?.result).toBe('"the answer"');
  });

  test('several detached jobs survive one Stop — one turn ending is not a fleet shutdown', async () => {
    const s = scene();
    const search = s.detachHeldJob('think');
    const release = s.detachHeldJob('shell');

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

    // `strictObject` states the frame's whole surface, so a returned `cancelledJobs` fails here.
    const frame = v.parse(v.strictObject({
      type: v.literal('work_cancelled'),
      abortedTools: v.number(),
      deviceCommands: v.array(v.object({
        outcome: v.picklist(['terminated', 'unknown', 'failed']),
        detail: v.optional(v.string()),
      })),
      timestamp: v.number(),
    }), JSON.parse(s.broadcasts[0]));

    expect(frame.abortedTools).toBe(1);
  });

  /** Negative control: naming the job stops it, so the survival above is scoping, not unreachable cancellation. */
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
