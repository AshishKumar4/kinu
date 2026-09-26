import { describe, expect, test } from 'bun:test';
import { ALERT_THRESHOLDS, evaluateFleet, findWakeLoops, settleSignal, type StartupHour } from '../src/obs/analytics/alerts';

const WAKE_LOOP_STARTUPS_PER_HOUR = ALERT_THRESHOLDS.startupsPerHour;

const HOUR = 3_600_000;

const T0 = Date.parse('2026-09-25T00:00:00Z');

const hour = (object: string, at: number, startups: number): StartupHour => ({ object, hour: T0 + at * HOUR, startups });

describe('findWakeLoops', () => {
  test('a reset storm (warm-forge-4d6acc02, 57 startups in an hour) trips; a busy normal workspace does not', () => {
    const loops = findWakeLoops([
      hour('warm-forge', 0, 3),
      hour('warm-forge', 1, 57),
      hour('warm-forge', 2, 4),
      hour('busy-owner', 0, 12),
      hour('busy-owner', 1, 9),
    ]);

    expect(loops.map((l) => l.object)).toEqual(['warm-forge']);
    expect(loops[0]).toMatchObject({ peakPerHour: 57, loopHours: 1, sustained: false, startups: 64, firstLoopHour: T0 + HOUR });
  });

  test('the threshold hour counts and the hour under it does not', () => {
    expect(findWakeLoops([hour('a', 0, WAKE_LOOP_STARTUPS_PER_HOUR - 1)])).toEqual([]);
    expect(findWakeLoops([hour('a', 0, WAKE_LOOP_STARTUPS_PER_HOUR)])).toHaveLength(1);
  });

  test('only consecutive loop hours make a loop sustained', () => {
    const [apart] = findWakeLoops([hour('a', 0, 40), hour('a', 2, 40)]);
    const [adjacent] = findWakeLoops([hour('a', 0, 40), hour('a', 1, 40), hour('a', 3, 40)]);

    expect(apart).toMatchObject({ loopHours: 2, longestRunHours: 1, sustained: false });
    expect(adjacent).toMatchObject({ loopHours: 3, longestRunHours: 2, sustained: true, lastLoopHour: T0 + 3 * HOUR });
  });

  test('rows for one hour add up before the threshold is read, whatever instant inside the hour they carry', () => {
    const [loop] = findWakeLoops([
      { object: 'a', hour: T0 + 5 * 60_000, startups: 20 },
      { object: 'a', hour: T0 + 50 * 60_000, startups: 20 },
    ]);

    expect(loop).toMatchObject({ loopHours: 1, peakPerHour: 40, firstLoopHour: T0 });
  });

  test('the longest-running loop ranks first', () => {
    const loops = findWakeLoops([
      hour('burst', 0, 200),
      hour('steady', 0, 60), hour('steady', 1, 60), hour('steady', 2, 60),
    ]);

    expect(loops.map((l) => l.object)).toEqual(['steady', 'burst']);
  });
});

const QUIET = { startups: [], events: [], turns: { settled: 0, failed: 0 }, kills: { exceededMemory: 0, exceededWallTimeObjects: 0 } } as const;

const stateOf = (sample: Parameters<typeof evaluateFleet>[0]) => Object.fromEntries(evaluateFleet(sample).map((v) => [v.signal, v.state]));

describe('evaluateFleet', () => {
  test('a quiet fleet crosses nothing', () => {
    expect(Object.values(stateOf(QUIET)).every((state) => state === 'ok')).toBe(true);
  });

  test('warm-forge-4d6acc02 on 2026-09-26 (74 then 78 startups an hour) is a wake loop; one burst hour is not', () => {
    expect(stateOf({ ...QUIET, startups: [hour('warm-forge', 0, 74), hour('warm-forge', 1, 78)] })['wake_loop']).toBe('crossed');
    expect(stateOf({ ...QUIET, startups: [hour('reconnects', 0, 90), hour('reconnects', 1, 3)] })['wake_loop']).toBe('ok');
  });

  test('a failed-turn share counts only once there are enough turns to mean it', () => {
    expect(stateOf({ ...QUIET, turns: { settled: 19, failed: 19 } })['turn_failures']).toBe('ok');
    expect(stateOf({ ...QUIET, turns: { settled: 40, failed: 10 } })['turn_failures']).toBe('ok');
    expect(stateOf({ ...QUIET, turns: { settled: 40, failed: 11 } })['turn_failures']).toBe('crossed');
  });

  test('refused provider credentials cross on a handful; ordinary provider errors need a flood', () => {
    expect(stateOf({ ...QUIET, events: [{ event: 'provider.error', code: 'denied', count: 5 }] })['provider_down']).toBe('crossed');
    expect(stateOf({ ...QUIET, events: [{ event: 'provider.error', code: 'unavailable', count: 72 }] })['provider_down']).toBe('ok');
  });

  test('one out-of-memory kill is an incident', () => {
    expect(stateOf({ ...QUIET, kills: { exceededMemory: 1, exceededWallTimeObjects: 0 } })['platform_kill']).toBe('crossed');
  });

  test('a source that is not configured says so, instead of reading as quiet', () => {
    expect(stateOf({ ...QUIET, kills: null, startups: null })).toMatchObject({ platform_kill: 'unconfigured', wake_loop: 'unconfigured', turn_failures: 'ok' });
  });
});

describe('settleSignal: two ticks to open, two to close', () => {
  const crossed = { signal: 'wake_loop', state: 'crossed', detail: 'loop' } as const;
  const ok = { signal: 'wake_loop', state: 'ok' } as const;

  const run = (ticks: readonly ('x' | '.')[]): boolean[] => {
    let streak = { crossed: 0, clean: 0 };
    let open = false;

    return ticks.map((tick) => {
      const settled = settleSignal(streak, tick === 'x' ? crossed : ok, open);
      streak = settled.streak;
      open = settled.failing;

      return open;
    });
  };

  test('one crossing tick opens nothing; the second opens the incident', () => {
    expect(run(['x', '.', 'x', 'x'])).toEqual([false, false, false, true]);
  });

  test('an open incident survives one clean tick and one flap, and closes on two clean ticks', () => {
    expect(run(['x', 'x', '.', 'x', '.', '.'])).toEqual([false, true, true, true, true, false]);
  });

  test('a source going unconfigured neither opens nor closes an incident', () => {
    const unconfigured = { signal: 'wake_loop', state: 'unconfigured' } as const;
    expect(settleSignal({ crossed: 1, clean: 0 }, unconfigured, false)).toEqual({ streak: { crossed: 1, clean: 0 }, failing: false });
    expect(settleSignal({ crossed: 5, clean: 0 }, unconfigured, true).failing).toBe(true);
  });
});
