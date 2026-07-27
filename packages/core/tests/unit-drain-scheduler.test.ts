// DrainScheduler — the fixed-window (leading-edge armed, trailing fire)
// debounce for the event→turn drain. Hand-cranked fake timer: the test holds
// the armed callbacks and fires them explicitly.
import { describe, test, expect } from 'bun:test';
import { DrainScheduler, DRAIN_DEBOUNCE_MS } from '../src/orchestrator/drain-scheduler.js';

function setup(drain?: () => Promise<void>) {
  let drains = 0;
  const timers: Array<{ fn: () => Promise<void>; ms: number }> = [];
  const scheduler = new DrainScheduler(
    drain ?? (async () => { drains++; }),
    (fn, ms) => { timers.push({ fn, ms }); },
  );
  return { scheduler, timers, drained: () => drains };
}

describe('DrainScheduler — fixed-window debounce', () => {
  test('a burst of schedule() calls in one window arms ONE timer → ONE drain', async () => {
    const { scheduler, timers, drained } = setup();
    for (let i = 0; i < 5; i++) scheduler.schedule();
    expect(timers).toHaveLength(1);                 // 4 calls absorbed
    expect(timers[0]!.ms).toBe(DRAIN_DEBOUNCE_MS);
    await timers[0]!.fn();
    expect(drained()).toBe(1);
  });

  test('schedule() after the window fired arms a fresh window → a second drain', async () => {
    const { scheduler, timers, drained } = setup();
    scheduler.schedule();
    await timers[0]!.fn();
    scheduler.schedule();
    scheduler.schedule();                           // absorbed into window 2
    expect(timers).toHaveLength(2);
    await timers[1]!.fn();
    expect(drained()).toBe(2);
  });

  test('a drain that throws does not wedge the scheduler — the next window still fires', async () => {
    let calls = 0;
    const { scheduler, timers } = setup(async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
    });
    scheduler.schedule();
    await timers[0]!.fn();                          // swallowed + logged, never rejects
    expect(calls).toBe(1);
    scheduler.schedule();
    expect(timers).toHaveLength(2);
    await timers[1]!.fn();
    expect(calls).toBe(2);
  });

  test('the window disarms before the drain runs, so a mid-drain schedule() arms a new one', async () => {
    const { scheduler, timers, drained } = setup();
    scheduler.schedule();
    const firing = timers[0]!.fn();
    scheduler.schedule();                           // lands while window 1 fires
    await firing;
    expect(timers).toHaveLength(2);
    await timers[1]!.fn();
    expect(drained()).toBe(2);
  });
});
