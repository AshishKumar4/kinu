import { describe, expect, test } from 'bun:test';
import type { RunEvent } from '@kinu.run/core';
import type { PublicBackgroundJob, PublicSubordinate } from './session';
import { answered, settle, TurnWatch, type WatchClock, type WatchedWorkspace, WorkspaceHang } from './workspace-completion';

const START = Date.parse('2026-10-01T06:00:00.000Z');

const MINUTE = 60_000;

/** The watch's own clock: a look's wait moves it on at once, so twenty minutes of polls run in a moment. */
type FixtureClock = WatchClock & { elapsed(): number };

function watchClock(): FixtureClock {
  let at = START;

  return {
    now: () => at,
    sleep: (ms) => {
      at += ms;

      return Promise.resolve();
    },
    elapsed: () => at - START,
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

type Snapshot = { events: RunEvent[]; jobs?: PublicBackgroundJob[]; helpers?: PublicSubordinate[]; inFlight?: string[] };

/**
 * A workspace whose state at each moment of the watch's clock is `state(elapsed)`. One read half an hour in is a watch
 * that never gave a verdict: the read fails, so a settle without the hang rule fails here instead of polling forever.
 */
function fixtureWorkspace(clock: FixtureClock, state: (elapsed: number) => Snapshot): WatchedWorkspace {
  const read = () => {
    if (clock.elapsed() > 30 * MINUTE) throw new Error('the fixture workspace was still being read half an hour into its silence');

    return state(clock.elapsed());
  };

  return {
    runEvents: () => Promise.resolve(read().events),
    backgroundJobs: () => Promise.resolve(read().jobs ?? []),
    subordinates: () => Promise.resolve(read().helpers ?? []),
    toolCallsInFlight: () => read().inFlight ?? [],
  };
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

    // Polled each second from the first row the watch saw: the 362nd look is the first past six minutes.
    expect(hang.message).toContain('silent for 361 s, no tool call in flight and no provider wait declared');
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

    expect(hang.message).toContain('silent for 361 s');
    expect(clock.elapsed()).toBe(16 * MINUTE + 1_000);
  });

  test('a ledger that keeps growing is never silent, however long the turn', async () => {
    const clock = watchClock();

    const working = fixtureWorkspace(clock, (elapsed) => {
      const steps = Array.from({ length: Math.min(5, Math.floor(elapsed / (5 * MINUTE))) }, (_, index) => step('run-1', (index + 1) * 5 * MINUTE, index + 1));

      return { events: [start('run-1'), ...steps, ...steps.length === 5 ? [end('run-1', 25 * MINUTE, 6)] : []] };
    });

    expect(await settle(new TurnWatch(working, clock))).toBeUndefined();
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
