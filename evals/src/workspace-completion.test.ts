import { describe, expect, test } from 'bun:test';
import { silenceBoundMs, type RunEvent } from '@kinu.run/core';
import type { PublicBackgroundJob, PublicSubordinate } from './session';
import { answered, HUNG_AFTER_MS, settle, TurnWatch, type WatchClock, type WatchedWorkspace, WorkspaceHang } from './workspace-completion';

const START = Date.parse('2026-10-01T06:00:00.000Z');

const MINUTE = 60_000;

/** The bound in whole seconds, and the silence a watch polled each second reports when it first passes it. */
const BOUND_S = HUNG_AFTER_MS / 1000;

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

/** The hang a watch ended on. Any other end, a settle or another failure, fails the test with it. */
async function hangOf(watching: Promise<unknown>): Promise<WorkspaceHang> {
  try {
    await watching;
  } catch (error) {
    if (error instanceof WorkspaceHang) return error;
    throw error;
  }

  throw new Error('the watch ended without a hang');
}

/** `heard`: the live frames heard so far on every room the session listens to, as `heard()` counts them. */
type Snapshot = { events: RunEvent[]; jobs?: PublicBackgroundJob[]; helpers?: PublicSubordinate[]; inFlight?: string[]; heard?: number };

/**
 * A workspace whose state at each moment of the watch's clock is `state(elapsed)`. One read half an hour in is a watch
 * that never gave a verdict: the read fails, so a settle without the hang rule fails here instead of polling forever.
 * `listened` keeps each set of helper rooms the watch asked to listen to.
 */
function fixtureWorkspace(clock: FixtureClock, state: (elapsed: number) => Snapshot, listened: string[][] = []): WatchedWorkspace {
  const read = () => {
    if (clock.elapsed() > 30 * MINUTE) throw new Error('the fixture workspace was still being read half an hour into its silence');

    return state(clock.elapsed());
  };

  return {
    runEvents: () => Promise.resolve(read().events),
    backgroundJobs: () => Promise.resolve(read().jobs ?? []),
    subordinates: () => Promise.resolve(read().helpers ?? []),
    toolCallsInFlight: () => read().inFlight ?? [],
    heard: () => read().heard ?? 0,
    listen: (helpers) => { listened.push([...helpers]); },
  };
}

/** Words every ten seconds from `from` until `until`, then none: what one streaming step sends, counted. */
function words(elapsed: number, until: number, from = 0): number {
  return Math.floor(Math.max(0, Math.min(elapsed, until) - from) / 10_000);
}

const at = (elapsed: number) => new Date(START + elapsed).toISOString();

const start = (runId: string, elapsed = 0): RunEvent => ({ type: 'run_start', runId, eventIndex: 0, timestamp: at(elapsed), agentId: 'lead', caused_by: 'chat' });

const step = (runId: string, elapsed: number, eventIndex: number): RunEvent => ({ type: 'step_finish', runId, eventIndex, timestamp: at(elapsed), stepIndex: eventIndex });

const end = (runId: string, elapsed: number, eventIndex: number): RunEvent => ({ type: 'run_end', runId, eventIndex, timestamp: at(elapsed), reason: 'completed' });

describe('a turn that stays busy and silent fails as a product hang, never holds the run', () => {
  test('a run left open with its ledger silent fails the turn, naming the run and the row it stopped at', async () => {
    const clock = watchClock();
    const silent = fixtureWorkspace(clock, () => ({ events: [start('run-1'), step('run-1', 1_000, 1)] }));

    const hang = await hangOf(settle(new TurnWatch(silent, clock)));

    // Polled each second from the first row the watch saw: the first look past the bound is a second past it.
    expect(hang.message).toContain(`busy for ${String(BOUND_S + 1)} s with no ledger row, no stream byte, no tool call in flight and no provider wait declared`);
    expect(hang.message).toContain(`held by open run run-1, its last row step_finish at ${at(1_000)}`);
  });

  test('the running job and the working helper that hold it are named, and nothing that is done', async () => {
    const clock = watchClock();

    const held = fixtureWorkspace(clock, () => ({
      events: [start('run-1'), end('run-1', 5_000, 1)],
      jobs: [{ id: 'bgjob-server', kind: 'shell', status: 'running' }, { id: 'bgjob-install', kind: 'shell', status: 'completed' }],
      helpers: [{ name: 'task-helper', status: 'working', lifetime: 'task' }, { name: 'done-helper', status: 'idle', lifetime: 'task' }],
    }));

    const hang = await hangOf(settle(new TurnWatch(held, clock)));

    expect(hang.message).toContain('held by running shell job bgjob-server; working helper task-helper');
    expect(hang.message).not.toContain('bgjob-install');
    expect(hang.message).not.toContain('done-helper');
  });

  // Measured 2026-10-01: a lead's `agents` hire ran 840 s with nothing in the ledger while its helper worked, and the
  // call then answered.
  test('a tool call in flight is not silence: a fourteen-minute call that answers lets the turn settle', async () => {
    const clock = watchClock();

    const hiring = fixtureWorkspace(clock, (elapsed) => (elapsed < 14 * MINUTE
      ? { events: [start('run-1'), step('run-1', 2_000, 1)], inFlight: ['call-hire'] }
      : { events: [start('run-1'), step('run-1', 2_000, 1), end('run-1', 14 * MINUTE, 2)] }));

    expect(await settle(new TurnWatch(hiring, clock))).toBeUndefined();
  });

  test('a provider wait the product declared is not silence, and the silence counts from its end', async () => {
    const clock = watchClock();
    const wait: RunEvent = { type: 'provider_wait', runId: 'run-1', eventIndex: 1, timestamp: at(0), provider: 'workers-ai', waitMs: 10 * MINUTE, attempt: 1, source: 'header' };
    const waiting = fixtureWorkspace(clock, () => ({ events: [start('run-1'), wait] }));

    const hang = await hangOf(settle(new TurnWatch(waiting, clock)));

    expect(hang.message).toContain(`busy for ${String(BOUND_S + 1)} s`);
    expect(clock.elapsed()).toBe(10 * MINUTE + HUNG_AFTER_MS + 1_000);
  });

  test('a ledger that keeps growing is never silent, however long the turn', async () => {
    const clock = watchClock();

    const working = fixtureWorkspace(clock, (elapsed) => {
      const steps = Array.from({ length: Math.min(5, Math.floor(elapsed / (5 * MINUTE))) }, (_, index) => step('run-1', (index + 1) * 5 * MINUTE, index + 1));

      return { events: [start('run-1'), ...steps, ...steps.length === 5 ? [end('run-1', 25 * MINUTE, 6)] : []] };
    });

    expect(await settle(new TurnWatch(working, clock))).toBeUndefined();
  });

  // The provider sent nothing for 181.8 s while Muse thought, in a stream that completed (provider lane, 2026-10-01): a
  // slower model or a longer answer streams one step for minutes, with no ledger row until it ends.
  test('a model that streams one slow step for ten minutes is never hung, while its turn streams or after', async () => {
    const clock = watchClock();
    const streaming = fixtureWorkspace(clock, (elapsed) => ({ events: [start('run-1')], heard: words(elapsed, 10 * MINUTE) }));

    expect(await answered(new TurnWatch(streaming, clock), clock.reached(10 * MINUTE).then(() => 'answered'))).toBe('answered');

    // The same step in a turn the product opened on its own, heard on the workspace's room while the turn settles.
    const woken = fixtureWorkspace(clock, (elapsed) => (elapsed < 20 * MINUTE
      ? { events: [start('run-1'), end('run-1', 1_000, 1), start('wake-1', 10 * MINUTE)], heard: words(elapsed, 20 * MINUTE, 10 * MINUTE) }
      : { events: [start('run-1'), end('run-1', 1_000, 1), start('wake-1', 10 * MINUTE), step('wake-1', 20 * MINUTE, 1), end('wake-1', 20 * MINUTE, 2)] }));

    expect(await settle(new TurnWatch(woken, clock))).toBeUndefined();
  });

  test('a model that streams, then falls silent past the bound, is hung from its last word', async () => {
    const clock = watchClock();
    const stalled = fixtureWorkspace(clock, (elapsed) => ({ events: [start('run-1')], heard: words(elapsed, 2 * MINUTE) }));

    const hang = await hangOf(settle(new TurnWatch(stalled, clock)));

    expect(hang.message).toContain(`busy for ${String(BOUND_S + 1)} s with no ledger row, no stream byte`);
    expect(hang.message).toContain('held by open run run-1');
    expect(clock.elapsed()).toBe(2 * MINUTE + HUNG_AFTER_MS + 1_000);
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

    expect(await settle(new TurnWatch(failingOver, clock))).toBeUndefined();
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
    const undeclared = await hangOf(settle(new TurnWatch(fixtureWorkspace(before, retrying(false)), before)));

    expect(undeclared.message).toContain('held by open run run-1');

    const after = watchClock();

    expect(await settle(new TurnWatch(fixtureWorkspace(after, retrying(true)), after))).toBeUndefined();
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

    expect(await settle(new TurnWatch(delegated, clock))).toBeUndefined();
    expect(listened.at(0)).toEqual(['task-helper']);
    expect(listened.at(-1)).toEqual([]);
  });

  test('a run silent mid-answer fails while its stream is still open', async () => {
    const clock = watchClock();
    const silent = fixtureWorkspace(clock, () => ({ events: [start('run-1')] }));

    const hang = await hangOf(answered(new TurnWatch(silent, clock), new Promise<never>(() => undefined)));

    expect(hang.message).toContain('held by open run run-1');
  });

  test("an answer that lands is the turn's answer, and one that fails is its failure", async () => {
    const clock = watchClock();
    const streaming = fixtureWorkspace(clock, () => ({ events: [start('run-1')] }));

    expect(await answered(new TurnWatch(streaming, clock), Promise.resolve('answered'))).toBe('answered');
    await expect(answered(new TurnWatch(streaming, clock), Promise.reject(new Error('the socket closed')))).rejects.toThrow('the socket closed');
  });
});
