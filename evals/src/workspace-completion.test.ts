import { describe, expect, test } from 'bun:test';
import {
  BackgroundJobRunner, BackgroundJobStore, Inbox, initBackgroundJobsTable, listBackgroundJobs, silenceBoundMs, waitOn,
  withBackgroundThreshold, type RunEvent,
} from '@kinu.run/core';
import { createTestActorsOver, createTestSql, handClock, present, type HandClock } from '@kinu.run/test-utils';
import type { BackendHost } from '../../packages/core/src/types/backend-host';
import type { PublicAgent, PublicBackgroundJob, PublicSubordinate } from './session';
import {
  answered, HUNG_AFTER_MS, settle, TrialCancelled, TurnWatch, type WatchClock, type WatchedWorkspace, WorkspaceHang, type WorkspaceHeld,
} from './workspace-completion';

const START = Date.parse('2026-10-01T06:00:00.000Z');

const MINUTE = 60_000;

/** The bound in whole seconds. */
const BOUND_S = HUNG_AFTER_MS / 1000;

/** How far past the bound a silent workspace is seen: it says no read moved, so it is looked at each half minute. */
const LOOK_S = 30;

/** The watch's own clock: a look's wait moves it on at once, so twenty minutes of polls run in a moment. `reached` is
 *  the moment the clock passes `elapsed`, for an answer that lands then. */
type FixtureClock = WatchClock & { elapsed(): number; reached(elapsed: number): Promise<void> };

function watchClock(): FixtureClock {
  let at = START;
  const waiting: { readonly elapsed: number; readonly resolve: () => void }[] = [];

  return {
    now: () => at,
    sleep: (ms) => {
      at += ms;

      for (const waiter of waiting.filter((entry) => entry.elapsed <= at - START)) waiter.resolve();

      return Promise.resolve();
    },
    elapsed: () => at - START,
    reached: (elapsed) => {
      const { promise, resolve } = Promise.withResolvers<void>();

      waiting.push({ elapsed, resolve });

      return promise;
    },
  };
}

/** What a watch ended on, which must be an `ending`. Any other end, a settle or another failure, fails the test with it. */
async function ended<T extends WorkspaceHeld>(watching: Promise<unknown>, ending: new (message: string, heldBy: readonly string[]) => T): Promise<T> {
  try {
    await watching;
  } catch (error) {
    if (error instanceof ending) return error;
    throw error;
  }

  throw new Error(`the watch ended without a ${ending.name}`);
}

const hangOf = (watching: Promise<unknown>) => ended(watching, WorkspaceHang);

/** `heard`: the live frames heard so far on every room the session listens to, as `heard()` counts them. `helperJobs`:
 *  each helper's own jobs, by its name. */
type Snapshot = {
  events: RunEvent[]; jobs?: PublicBackgroundJob[]; helperJobs?: Record<string, PublicBackgroundJob[]>; helpers?: PublicSubordinate[];
  agents?: PublicAgent[]; inFlight?: string[]; heard?: number;
};

/** A workspace that never says a read moved: what it holds is seen only at its next look. */
const SILENT_ROOM = { readsMoved: () => 0, readsMoving: new AbortController().signal };

/** Far past any bound: a watch still reading a fixture this far in never gave a verdict. */
const UNANSWERED_MS = 120 * MINUTE;

/**
 * A workspace whose state at each moment of the watch's clock is `state(elapsed)`. A read two hours in is a watch that
 * never gave a verdict: the read fails, so a settle without the rule under test fails here instead of polling forever.
 * `listened` keeps each set of helper rooms the watch asked to listen to.
 */
function fixtureWorkspace(clock: FixtureClock, state: (elapsed: number) => Snapshot, listened: string[][] = []): WatchedWorkspace {
  const read = () => {
    if (clock.elapsed() > UNANSWERED_MS) throw new Error('the fixture workspace was still being read two hours in');

    return state(clock.elapsed());
  };

  return {
    runEvents: () => Promise.resolve(read().events),
    backgroundJobs: (of) => Promise.resolve(of === undefined ? read().jobs ?? [] : read().helperJobs?.[of] ?? []),
    subordinates: () => Promise.resolve(read().helpers ?? []),
    agents: () => Promise.resolve(read().agents ?? []),
    toolCallsInFlight: () => read().inFlight ?? [],
    heard: () => read().heard ?? 0,
    listen: (helpers) => { listened.push([...helpers]); },
    ...SILENT_ROOM,
  };
}

/** Words every ten seconds from `from` until `until`, then none: what one streaming step sends, counted. */
function words(elapsed: number, until: number, from = 0): number {
  return Math.floor(Math.max(0, Math.min(elapsed, until) - from) / 10_000);
}

const at = (elapsed: number) => new Date(START + elapsed).toISOString();

const start = (runId: string, elapsed = 0): RunEvent => ({ type: 'run_start', runId, eventIndex: 0, timestamp: at(elapsed), agentId: 'lead', caused_by: 'chat' });

const step = (runId: string, elapsed: number, eventIndex: number): RunEvent => ({ type: 'step_finish', parts: [], runId, eventIndex, timestamp: at(elapsed), stepIndex: eventIndex });

const end = (runId: string, elapsed: number, eventIndex: number): RunEvent => ({ type: 'run_end', runId, eventIndex, timestamp: at(elapsed), reason: 'completed' });

describe('a turn that stays busy and silent fails as a product hang, never holds the run', () => {
  test('a run left open with its ledger silent fails the turn, naming the run and the row it stopped at', async () => {
    const clock = watchClock();
    const silent = fixtureWorkspace(clock, () => ({ events: [start('run-1'), step('run-1', 1_000, 1)] }));

    const hang = await hangOf(settle(new TurnWatch(silent, { clock })));

    // Looked at each half minute from the first row the watch saw: the first look past the bound is a look past it.
    expect(hang.message).toContain(`busy for ${String(BOUND_S + LOOK_S)} s with no ledger row, no stream byte, no tool call in flight and no provider wait declared`);
    expect(hang.message).toContain(`held by open run run-1, its last row step_finish at ${at(1_000)}`);
    expect(hang.heldBy).toEqual(['open run']);
  });

  // Staging f75f06932, order-book (Ling): the turn's own run silent since its last step, eight jobs running beside it.
  test('the silent run and helper that hold it are named, a job running meanwhile beside them, and nothing that is done', async () => {
    const clock = watchClock();

    const held = fixtureWorkspace(clock, () => ({
      events: [start('run-1'), step('run-1', 5_000, 1)],
      jobs: [{ id: 'bgjob-ls', kind: 'shell', status: 'running', label: 'workspace: ls -la' },
        { id: 'bgjob-install', kind: 'shell', status: 'completed', label: 'workspace: npm install' }],
      helpers: [{ name: 'task-helper', status: 'working', lifetime: 'task' }, { name: 'done-helper', status: 'idle', lifetime: 'task' }],
    }));

    const hang = await hangOf(settle(new TurnWatch(held, { clock })));

    expect(hang.message).toContain(`held by open run run-1, its last row step_finish at ${at(5_000)}; working helper task-helper, `
      + 'with shell job bgjob-ls (workspace: ls -la) running meanwhile');
    expect(hang.message).not.toContain('bgjob-install');
    expect(hang.message).not.toContain('done-helper');
    expect(hang.heldBy).toEqual(['open run', 'working helper']);
  });

  // Measured 2026-10-01: a lead's `agents` hire ran 840 s with nothing in the ledger while its helper worked, and the
  // call then answered.
  test('a tool call in flight is not silence: a fourteen-minute call that answers lets the turn settle', async () => {
    const clock = watchClock();

    const hiring = fixtureWorkspace(clock, (elapsed) => (elapsed < 14 * MINUTE
      ? { events: [start('run-1'), step('run-1', 2_000, 1)], inFlight: ['call-hire'] }
      : { events: [start('run-1'), step('run-1', 2_000, 1), end('run-1', 14 * MINUTE, 2)] }));

    expect(await settle(new TurnWatch(hiring, { clock }))).toBeUndefined();
  });

  test('a provider wait the product declared is not silence, and the silence counts from its end', async () => {
    const clock = watchClock();
    const wait: RunEvent = { type: 'provider_wait', runId: 'run-1', eventIndex: 1, timestamp: at(0), provider: 'workers-ai', waitMs: 10 * MINUTE, attempt: 1, source: 'header' };
    const waiting = fixtureWorkspace(clock, () => ({ events: [start('run-1'), wait] }));

    const hang = await hangOf(settle(new TurnWatch(waiting, { clock })));

    expect(hang.message).toContain(`busy for ${String(BOUND_S + LOOK_S)} s`);
    expect(clock.elapsed()).toBe(10 * MINUTE + HUNG_AFTER_MS + LOOK_S * 1000);
  });

  test('a ledger that keeps growing is never silent, however long the turn', async () => {
    const clock = watchClock();

    const working = fixtureWorkspace(clock, (elapsed) => {
      const steps = Array.from({ length: Math.min(5, Math.floor(elapsed / (5 * MINUTE))) }, (_, index) => step('run-1', (index + 1) * 5 * MINUTE, index + 1));

      return { events: [start('run-1'), ...steps, ...steps.length === 5 ? [end('run-1', 25 * MINUTE, 6)] : []] };
    });

    expect(await settle(new TurnWatch(working, { clock }))).toBeUndefined();
  });

  // The provider sent nothing for 181.8 s while Muse thought, in a stream that completed (provider lane, 2026-10-01): a
  // slower model or a longer answer streams one step for minutes, with no ledger row until it ends.
  test('a model that streams one slow step for ten minutes is never hung, while its turn streams or after', async () => {
    const clock = watchClock();
    const streaming = fixtureWorkspace(clock, (elapsed) => ({ events: [start('run-1')], heard: words(elapsed, 10 * MINUTE) }));

    expect(await answered(new TurnWatch(streaming, { clock }), clock.reached(10 * MINUTE).then(() => 'answered'))).toBe('answered');

    // The same step in a turn the product opened on its own, heard on the workspace's room while the turn settles.
    const woken = fixtureWorkspace(clock, (elapsed) => (elapsed < 20 * MINUTE
      ? { events: [start('run-1'), end('run-1', 1_000, 1), start('wake-1', 10 * MINUTE)], heard: words(elapsed, 20 * MINUTE, 10 * MINUTE) }
      : { events: [start('run-1'), end('run-1', 1_000, 1), start('wake-1', 10 * MINUTE), step('wake-1', 20 * MINUTE, 1), end('wake-1', 20 * MINUTE, 2)] }));

    expect(await settle(new TurnWatch(woken, { clock }))).toBeUndefined();
  });

  test('a model that streams, then falls silent past the bound, is hung from its last word', async () => {
    const clock = watchClock();
    const stalled = fixtureWorkspace(clock, (elapsed) => ({ events: [start('run-1')], heard: words(elapsed, 2 * MINUTE) }));

    const hang = await hangOf(settle(new TurnWatch(stalled, { clock })));

    expect(hang.message).toContain(`busy for ${String(BOUND_S + LOOK_S)} s with no ledger row, no stream byte`);
    expect(hang.message).toContain('held by open run run-1');
    expect(clock.elapsed()).toBe(2 * MINUTE + HUNG_AFTER_MS + LOOK_S * 1000);
  });

  // The provider fails a stream that sends nothing for its bound, writes the failed call's row, and hands the turn to its
  // fallback (`provider.stream.idle_ms`, core `rate-limit-retry.ts`): the stall is the provider's failure, counted there.
  test("a provider's stall is its failure, never a hang: its failed row lands before the watch's bound", async () => {
    const clock = watchClock();
    const stalledAt = MINUTE;
    // The call unwinds through the SDK to its failed row a few seconds after the provider's bound.
    const failedAt = stalledAt + silenceBoundMs('provider.stream.idle_ms') + 5_000;

    const failed: RunEvent = { type: 'model_operation', runId: 'run-1', eventIndex: 1, timestamp: at(failedAt), operationId: 'call-1',
      source: 'agent', op: 'stream', phase: 'end', outcome: 'failed', error: 'muse sent nothing for 6m' };

    const fellBack: RunEvent = { type: 'model_fallback', runId: 'run-1', eventIndex: 2, timestamp: at(failedAt), from: 'muse', to: 'mercury', reason: 'muse sent nothing for 6m' };

    const failingOver = fixtureWorkspace(clock, (elapsed) => {
      if (elapsed < failedAt) return { events: [start('run-1')], heard: words(elapsed, stalledAt) };

      // The fallback model streams its answer, and the run ends.
      return elapsed < failedAt + 2 * MINUTE
        ? { events: [start('run-1'), failed, fellBack], heard: words(stalledAt, stalledAt) + words(elapsed, failedAt + 2 * MINUTE, failedAt) }
        : { events: [start('run-1'), failed, fellBack, end('run-1', failedAt + 2 * MINUTE, 3)] };
    });

    expect(await settle(new TurnWatch(failingOver, { clock }))).toBeUndefined();
  });

  // A provider silent from its first byte: the transport fails each attempt at the provider's bound and declares a
  // `stall` wait before the next, until the chain takes the call (core `rate-limit-retry.ts`, 3817d2ca9).
  test('a provider silent from its start declares a stall at each attempt, and each declaration is heard', async () => {
    const attemptMs = silenceBoundMs('provider.stream.idle_ms') + 2_000;
    const answeredAt = 3 * attemptMs + MINUTE;

    const stall = (attempt: number): RunEvent => ({ type: 'provider_wait', runId: 'run-1', eventIndex: attempt,
      timestamp: at(attempt * attemptMs), provider: 'opencode-go', waitMs: 2_000, attempt, source: 'stall' });

    // Three silent attempts, then the chain's next model answers within a minute.
    const retrying = (declared: boolean) => (elapsed: number): Snapshot => {
      const stalls = declared ? [1, 2, 3].filter((attempt) => attempt * attemptMs <= elapsed).map(stall) : [];

      return { events: [start('run-1'), ...stalls, ...elapsed >= answeredAt ? [end('run-1', answeredAt, 4)] : []] };
    };

    // Undeclared, as before the transport owned these retries, the attempts were one silence: hung.
    const before = watchClock();
    const undeclared = await hangOf(settle(new TurnWatch(fixtureWorkspace(before, retrying(false)), { clock: before })));

    expect(undeclared.message).toContain('held by open run run-1');

    const after = watchClock();

    expect(await settle(new TurnWatch(fixtureWorkspace(after, retrying(true)), { clock: after }))).toBeUndefined();
    expect(after.elapsed()).toBeGreaterThanOrEqual(answeredAt);
  });

  test("a working helper is heard in its own room, which the watch listens to only while it works", async () => {
    const clock = watchClock();
    const listened: string[][] = [];
    const helper = (status: PublicSubordinate['status']): PublicSubordinate => ({ name: 'task-helper', status, lifetime: 'task' });

    // The lead's turn has ended; its helper streams for ten minutes in a room of its own, then goes idle.
    const delegated = fixtureWorkspace(clock, (elapsed) => (elapsed < 10 * MINUTE
      ? { events: [start('run-1'), end('run-1', 1_000, 1)], helpers: [helper('working')], heard: words(elapsed, 10 * MINUTE) }
      : { events: [start('run-1'), end('run-1', 1_000, 1)], helpers: [helper('idle')], heard: words(elapsed, 10 * MINUTE) }), listened);

    expect(await settle(new TurnWatch(delegated, { clock }))).toBeUndefined();
    expect(listened.at(0)).toEqual(['task-helper']);
    expect(listened.at(-1)).toEqual([]);
  });

  test('a run silent mid-answer fails while its stream is still open', async () => {
    const clock = watchClock();
    const silent = fixtureWorkspace(clock, () => ({ events: [start('run-1')] }));

    const hang = await hangOf(answered(new TurnWatch(silent, { clock }), new Promise<never>(() => undefined)));

    expect(hang.message).toContain('held by open run run-1');
  });

  test("an answer that lands is the turn's answer, and one that fails is its failure", async () => {
    const clock = watchClock();
    const streaming = fixtureWorkspace(clock, () => ({ events: [start('run-1')] }));

    expect(await answered(new TurnWatch(streaming, { clock }), Promise.resolve('answered'))).toBe('answered');
    await expect(answered(new TurnWatch(streaming, { clock }), Promise.reject(new Error('the socket closed')))).rejects.toThrow('the socket closed');
  });
});

/** The watch's clock over the hand clock the product's runner reads: a look's wait moves both on at once. */
function overHand(hand: HandClock): WatchClock {
  return {
    now: () => hand.now(),
    sleep: (ms) => {
      hand.advance(ms);

      return Promise.resolve();
    },
  };
}

/**
 * The lead's shell call `sleep 600; make`, as the product runs it: core's detach race over a real `BackgroundJobRunner`,
 * on the test's clock, makes it a background job at the interactive threshold, and the lead's run ends; the job's settle
 * wakes the lead in a run of its own, which answers. `never`: the command never ends.
 */
type DetachedCommand = { readonly workspace: WatchedWorkspace; readonly store: BackgroundJobStore; readonly lead: Promise<void> };

function detachedCommand(hand: HandClock, never: boolean): DetachedCommand {
  const { db, sql, execRaw } = createTestSql();

  initBackgroundJobsTable(execRaw);
  const store = new BackgroundJobStore(sql, createTestActorsOver(db).main);
  const ledger: RunEvent[] = [start('run-1')];
  const elapsed = () => hand.now() - START;
  let inFlight = ['call-make'];

  const host: BackendHost = {
    broadcast: () => undefined,
    enqueueTurn: () => {
      ledger.push(start('wake-1', elapsed()), end('wake-1', elapsed(), 1));

      return Promise.resolve({ status: 'queued' });
    },
    turnInFlight: () => false,
    setTimer: () => undefined,
  };

  const runner = new BackgroundJobRunner({ store, fiber: (_name, body) => body({ stash: () => undefined, snapshot: null }), inbox: new Inbox(host) });
  const command = never ? () => new Promise<never>(() => undefined) : () => waitOn(hand, 10 * MINUTE).then(() => 'made');

  const lead = withBackgroundThreshold('shell', command, {
    ...runner.thresholdDeps({ command: 'sleep 600; make', runtime: 'workspace' }, 'build', new AbortController()), clock: hand,
  }).then(() => {
    inFlight = [];
    ledger.push(step('run-1', elapsed(), 1), end('run-1', elapsed(), 2));
  });

  const read = <T>(value: () => T): Promise<T> => {
    if (elapsed() > UNANSWERED_MS) return Promise.reject(new Error('the workspace was still being read two hours in'));

    return Promise.resolve(value());
  };

  return {
    store,
    lead,
    workspace: {
      runEvents: () => read(() => [...ledger]),
      backgroundJobs: (of) => read(() => (of === undefined ? listBackgroundJobs(store, 50) : [])),
      subordinates: () => read(() => []),
      agents: () => read(() => []),
      toolCallsInFlight: () => inFlight,
      heard: () => 0,
      listen: () => undefined,
      ...SILENT_ROOM,
    },
  };
}

/** What a room's state is in these scenes: its ledger, its jobs and its agents. */
type RoomState = { readonly events: RunEvent[]; readonly jobs: PublicBackgroundJob[]; readonly agents: PublicAgent[] };

/** One stage of a scene: the room's state, and the answers it gives before the next stage lands. A stage lands between
 *  two answers of one read: after the first of its `after` answers that a `before` answer follows. */
type RoomStage = {
  readonly state: RoomState; readonly answers: number; readonly lands?: { readonly after: readonly string[]; readonly before: string };
};

/** Before the jobs answer: after the agents answer, or the ledger's for a watch that reads no agents. */
const BEFORE_JOBS = { after: ['agents', 'ledger'], before: 'jobs' };

/** The reads a room's frame names in these scenes: a job's settle moves both. */
const MOVED_READS = new Set(['listWorkspaceAgents', 'listBackgroundJobs']);

/**
 * The workspace's room as its one socket orders it. The calls a read makes together are answered one at a time, in the
 * order `order` gives for that read, else the order made, and each stage after the first lands between two of a read's
 * answers. The frame for that change arrives as late as the room's tick allows: before the first answer to a later
 * read, never inside the read it landed in. `stage` is where the room is.
 */
function roomWorkspace(
  clock: FixtureClock, stages: readonly RoomStage[], order: (read: number) => readonly string[] = () => [],
): WatchedWorkspace & { stage(): number } {
  let stage = 0;
  let given = 0;
  let owed = 0;
  let frames = 0;
  let reads = 0;
  let moving = new AbortController();
  const asked: { readonly read: string; readonly answer: () => void }[] = [];

  const answerRead = (): void => {
    if (owed > 0) {
      frames += owed;
      owed = 0;
      moving.abort();
      moving = new AbortController();
    }

    reads += 1;
    const ranked = order(reads);
    const rank = (read: string): number => (ranked.includes(read) ? ranked.indexOf(read) : ranked.length);
    const calls = asked.splice(0).sort((one, other) => rank(one.read) - rank(other.read));
    const { after, before } = stages[stage + 1]?.lands ?? BEFORE_JOBS;
    const followed = (name: string) => calls.findIndex((call, index) => call.read === name && calls.slice(index + 1).some((later) => later.read === before));
    const landsAt = after.map(followed).find((index) => index !== -1);
    let landed = false;

    for (const [index, call] of calls.entries()) {
      call.answer();
      given += 1;

      if (!landed && index === landsAt && stage + 1 < stages.length && given >= (stages[stage]?.answers ?? Infinity)) {
        landed = true;
        stage += 1;
        given = 0;
        owed += 1;
      }
    }
  };

  const ask = <T>(read: string, value: (state: RoomState) => T): Promise<T> => {
    if (clock.elapsed() > UNANSWERED_MS) return Promise.reject(new Error('the room was still being read two hours in'));
    const { promise, resolve } = Promise.withResolvers<T>();

    if (asked.length === 0) queueMicrotask(answerRead);
    asked.push({ read, answer: () => { resolve(value(present(stages[stage], 'the stage').state)); } });

    return promise;
  };

  return {
    runEvents: () => ask('ledger', (state) => state.events),
    agents: () => ask('agents', (state) => state.agents),
    subordinates: () => ask('roster', () => []),
    backgroundJobs: (of) => ask(of === undefined ? 'jobs' : 'helper jobs', (state) => (of === undefined ? state.jobs : [])),
    toolCallsInFlight: () => [],
    heard: () => 0,
    listen: () => undefined,
    readsMoved: (names) => frames * names.filter((name) => MOVED_READS.has(name)).length,
    get readsMoving() { return moving.signal; },
    stage: () => stage,
  };
}

const mainAgent = (activity: PublicAgent['activity']): PublicAgent => ({ label: 'Main', category: 'main', activity, open: { kind: 'chat', path: null } });

// Staging f75f06932, 2026-10-01: five trials were called quiet on two idle reads a second apart while each owed a turn it
// had not claimed. A read's calls are answered one at a time, so a change can land between two of them and the read see
// neither side's work.
describe('a change landing mid-read is never read as quiet', () => {
  test("a job's settle landing between a read's answers holds the turn until the wake it owes has run", async () => {
    const clock = watchClock();
    const server = (status: string): PublicBackgroundJob => ({ id: 'bgjob-tests', kind: 'shell', status, label: 'workspace: npm test', createdAt: START });
    const closed = [start('run-1'), end('run-1', 1_000, 1)];

    const room = roomWorkspace(clock, [
      // The lead's run ended with its tests running as a job.
      { state: { events: closed, jobs: [server('running')], agents: [mainAgent('idle')] }, answers: 4 },
      // The job settled, and the wake it owes the lead is queued, not yet claimed: no run is open.
      { state: { events: closed, jobs: [server('completed')], agents: [mainAgent('working')] }, answers: 8 },
      { state: { events: [...closed, start('wake-1', 2_000)], jobs: [server('completed')], agents: [mainAgent('working')] }, answers: 4 },
      { state: { events: [...closed, start('wake-1', 2_000), end('wake-1', 3_000, 1)], jobs: [server('completed')], agents: [mainAgent('idle')] }, answers: Infinity },
    ]);

    expect(await settle(new TurnWatch(room, { clock }))).toBeUndefined();
    expect(room.stage()).toBe(3);
  });

  // The room checks each call's socket with the user's object before it runs the call, so a later call can run first.
  test('two reads in a row that each miss a change still hold the turn, as the frame between them says the room moved', async () => {
    const clock = watchClock();
    const server = (status: string): PublicBackgroundJob => ({ id: 'bgjob-tests', kind: 'shell', status, label: 'workspace: npm test', createdAt: START });
    const turn = [start('run-1')];
    const closed = [start('run-1'), end('run-1', 1_000, 1)];
    const jobsFirst = ['jobs', 'agents', 'ledger', 'roster'];

    const room = roomWorkspace(clock, [
      { state: { events: turn, jobs: [], agents: [mainAgent('working')] }, answers: 4 },
      // The lead's run ends with its tests running as a job: read jobs first, then the rest.
      { state: { events: closed, jobs: [server('running')], agents: [mainAgent('idle')] }, answers: 3, lands: { after: ['jobs'], before: 'agents' } },
      // The job settles and owes the lead a wake: read the rest first, then the jobs.
      { state: { events: closed, jobs: [server('completed')], agents: [mainAgent('working')] }, answers: 4, lands: { after: ['roster'], before: 'jobs' } },
      { state: { events: [...closed, start('wake-1', 2_000)], jobs: [server('completed')], agents: [mainAgent('working')] }, answers: 4 },
      { state: { events: [...closed, start('wake-1', 2_000), end('wake-1', 3_000, 1)], jobs: [server('completed')], agents: [mainAgent('idle')] }, answers: Infinity },
    ], (read) => (read % 2 === 1 ? jobsFirst : ['agents', 'ledger', 'roster', 'jobs']));

    expect(await settle(new TurnWatch(room, { clock }))).toBeUndefined();
    expect(room.stage()).toBe(4);
  });
});

describe('a job is waited on until it settles, never judged by its silence', () => {
  // A detached `sleep 600; make` was graded hung at 420 s (2026-10-01): a job publishes nothing while it runs.
  test("a quiet ten-minute job the product's runner detached settles green, the trial saying each minute what it waits on", async () => {
    const hand = handClock(START);
    const { workspace, store, lead } = detachedCommand(hand, false);
    const lines: string[] = [];

    expect(await settle(new TurnWatch(workspace, { clock: overHand(hand), waiting: (line) => { lines.push(line); } }))).toBeUndefined();
    await lead;

    const [job] = listBackgroundJobs(store, 50);

    if (job === undefined) throw new Error('the runner made no job');
    expect(job.status).toBe('completed');
    expect(hand.now() - START).toBeGreaterThanOrEqual(10 * MINUTE);
    // One a minute while it ran: nine or ten, as the look at the tenth minute lands before or after the job settles.
    expect(new Set(lines)).toEqual(new Set([`waiting on job ${job.id} (${job.label}) since ${new Date(job.createdAt).toISOString()}`]));
    expect([9, 10]).toContain(lines.length);
  });

  // A task helper whose turn ended with a job running stays working until the job settles (core `finishTurn`).
  test('a helper waiting on a job of its own is judged by that job, not its silence', async () => {
    const clock = watchClock();
    const lines: string[] = [];
    const tests: PublicBackgroundJob = { id: 'bgjob-tests', kind: 'shell', status: 'running', label: 'workspace: npm test', createdAt: START + MINUTE };
    const helper = (status: PublicSubordinate['status']): PublicSubordinate => ({ name: 'task-helper', status, lifetime: 'task' });
    const lead = [start('run-1'), end('run-1', MINUTE, 1)];

    const delegated = fixtureWorkspace(clock, (elapsed) => (elapsed < 12 * MINUTE
      ? { events: lead, helpers: [helper('working')], helperJobs: { 'task-helper': [tests] } }
      : { events: lead, helpers: [helper('idle')], helperJobs: { 'task-helper': [{ ...tests, status: 'completed' }] } }));

    expect(await settle(new TurnWatch(delegated, { clock, waiting: (line) => { lines.push(line); } }))).toBeUndefined();
    expect(lines[0]).toBe(`waiting on helper task-helper's job bgjob-tests (workspace: npm test) since ${at(MINUTE)}`);
  });
});

// Nothing ends a turn on elapsed time: a job that never ends, or a run that never stops streaming, holds it until the
// run is cancelled, and the cancel is the trial's last word on what held it.
describe("the run's cancel ends a held turn, naming what held it", () => {
  test('a job that never ends holds the turn until the cancel, which names the job, what it runs and for how long', async () => {
    const hand = handClock(START);
    const { workspace, store } = detachedCommand(hand, true);
    const run = new AbortController();

    const cancelling = waitOn(hand, 45 * MINUTE).then(() => { run.abort('SIGTERM'); });

    const cancelled = await ended(settle(new TurnWatch(workspace, { clock: overHand(hand), cancelled: run.signal })), TrialCancelled);
    const [job] = listBackgroundJobs(store, 50);

    await cancelling;

    if (job === undefined) throw new Error('the runner made no job');
    expect(job.status).toBe('running');
    expect(cancelled.message).toBe(`cancelled by SIGTERM, held by running shell job ${job.id} (${job.label}) `
      + `for ${String(Math.round((hand.now() - job.createdAt) / 1000))} s`);
    expect(cancelled.heldBy).toEqual(['running shell job']);
    expect(hand.now() - START).toBeGreaterThanOrEqual(45 * MINUTE);
  });

  // Staging, 2026-10-01: two Ling site-preview trials stepped for 55 minutes without ending turn 1.
  test('a run that never stops streaming is never cut, and the cancel names its open run', async () => {
    const clock = watchClock();
    const looping = fixtureWorkspace(clock, (elapsed) => ({ events: [start('run-1')], heard: words(elapsed, Infinity) }));
    const run = new AbortController();

    const cancelling = clock.reached(90 * MINUTE).then(() => { run.abort('SIGINT'); });

    const cancelled = await ended(answered(new TurnWatch(looping, { clock, cancelled: run.signal }), new Promise<never>(() => undefined)), TrialCancelled);

    await cancelling;

    expect(cancelled.message).toBe(`cancelled by SIGINT, held by open run run-1, its last row run_start at ${at(0)}`);
    expect(cancelled.heldBy).toEqual(['open run']);
  });

  test("a working helper's own job is named with the helper, and a helper that only works as itself", async () => {
    const clock = watchClock();
    const tests: PublicBackgroundJob = { id: 'bgjob-tests', kind: 'shell', status: 'running', label: 'workspace: npm test', createdAt: START + MINUTE };
    const helper = (name: string): PublicSubordinate => ({ name, status: 'working', lifetime: 'task' });
    const run = new AbortController();

    // The writer streams the whole time; the tester waits on its tests, which never end.
    const delegated = fixtureWorkspace(clock, (elapsed) => ({
      events: [start('run-1'), end('run-1', MINUTE, 1)],
      helpers: [helper('task-tester'), helper('task-writer')],
      helperJobs: { 'task-tester': [tests] },
      heard: words(elapsed, Infinity),
    }));

    const cancelling = clock.reached(10 * MINUTE).then(() => { run.abort('SIGTERM'); });

    const cancelled = await ended(settle(new TurnWatch(delegated, { clock, cancelled: run.signal })), TrialCancelled);

    await cancelling;

    expect(cancelled.message).toBe('cancelled by SIGTERM, held by working helper task-writer; '
      + `running shell job bgjob-tests (workspace: npm test) of helper task-tester for ${String((clock.elapsed() - MINUTE) / 1000)} s`);
    expect(cancelled.heldBy).toEqual(['working helper', 'running shell job']);
  });

  test('a cancel that finds the workspace free says nothing held it, and one that cannot read it says why', async () => {
    const clock = watchClock();
    const run = new AbortController();

    run.abort('SIGTERM');
    const free = fixtureWorkspace(clock, () => ({ events: [start('run-1'), end('run-1', 1_000, 1)] }));
    const nothing = await ended(settle(new TurnWatch(free, { clock, cancelled: run.signal })), TrialCancelled);

    expect([nothing.message, nothing.heldBy]).toEqual(['cancelled by SIGTERM; nothing held the workspace', []]);

    const unreachable = { ...free, runEvents: () => Promise.reject(new Error('the deployment answered 502')) };
    const unread = await ended(settle(new TurnWatch(unreachable, { clock, cancelled: run.signal })), TrialCancelled);

    expect(unread.message).toStartWith('cancelled by SIGTERM; what held the workspace could not be read: ');
    expect(unread.message).toContain('the deployment answered 502');
  });
});
