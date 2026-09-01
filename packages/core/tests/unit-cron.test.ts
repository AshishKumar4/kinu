import { describe, expect, test } from 'bun:test';
import { nextAlarmTime, nextCronFire } from '../src/events/hub/cron';

const BASE = Date.UTC(2026, 5, 2, 10, 17, 30);

describe('nextCronFire', () => {
  test('a six-field Quartz seconds-form expression is refused, not misread', () => {
    // The arity guard is load-bearing: without it a six-field expression
    // destructures to its first five fields, reads as all wildcards, and
    // silently fires every minute on the wrong schedule. Found by the
    // mutation pilot — deleting the guard survived every existing suite.
    expect(nextCronFire('0 */5 * * * *', 1_700_000_000_000)).toBeNull();
    expect(nextCronFire('0 0 12 * * ?', 1_700_000_000_000)).toBeNull();
  });

  test('supports wildcard, step, and integer minute fields', () => {
    expect(new Date(nextCronFire('0 * * * *', BASE)!).toISOString())
      .toBe('2026-06-02T11:00:00.000Z');
    expect(new Date(nextCronFire('* * * * *', BASE)!).toISOString())
      .toBe('2026-06-02T10:18:00.000Z');
    expect(new Date(nextCronFire('*/30 * * * *', BASE)!).toISOString())
      .toBe('2026-06-02T10:30:00.000Z');
  });

  test('supports wildcard, step, and integer hour fields', () => {
    expect(new Date(nextCronFire('30 2 * * *', BASE)!).toISOString())
      .toBe('2026-06-03T02:30:00.000Z');
    expect(new Date(nextCronFire('0 */6 * * *', BASE)!).toISOString())
      .toBe('2026-06-02T12:00:00.000Z');
    expect(new Date(nextCronFire('* 11 * * *', BASE)!).toISOString())
      .toBe('2026-06-02T11:00:00.000Z');
  });

  test('rejects unsupported day, month, and weekday fields', () => {
    expect(nextCronFire('0 0 1 * *', BASE)).toBeNull();
    expect(nextCronFire('0 0 * 1 *', BASE)).toBeNull();
    expect(nextCronFire('0 0 * * 1', BASE)).toBeNull();
  });
});

describe('nextAlarmTime', () => {
  const NOW = 1_000_000;

  test('nothing pending → no alarm', () => {
    expect(nextAlarmTime(NOW, [])).toBeNull();
    expect(nextAlarmTime(NOW, [null, undefined])).toBeNull();
    expect(nextAlarmTime(NOW, [], null, null)).toBeNull();
  });

  test('picks the soonest future trigger time', () => {
    expect(nextAlarmTime(NOW, [NOW + 5000, NOW + 100, NOW + 900])).toBe(NOW + 100);
  });

  test('drops trigger times that are due or past — the alarm body just handled them', () => {
    // A due trigger re-arming itself at `now` would spin the DO alarm forever.
    expect(nextAlarmTime(NOW, [NOW - 1, NOW, NOW + 50])).toBe(NOW + 50);
    expect(nextAlarmTime(NOW, [NOW - 1, NOW])).toBeNull();
  });

  test('CLAMPS a due/past retry to now instead of dropping it', () => {
    // The asymmetry with triggers is the point: a delivery whose retry time has
    // already passed must re-arm immediately or it stalls until an unrelated
    // event wakes the DO.
    expect(nextAlarmTime(NOW, [], NOW - 60_000)).toBe(NOW);
    expect(nextAlarmTime(NOW, [], NOW)).toBe(NOW);
  });

  test('a past retry beats a future trigger', () => {
    expect(nextAlarmTime(NOW, [NOW + 50], NOW - 5)).toBe(NOW);
  });

  test('a future retry competes on its own merits', () => {
    expect(nextAlarmTime(NOW, [NOW + 50], NOW + 10)).toBe(NOW + 10);
    expect(nextAlarmTime(NOW, [NOW + 50], NOW + 900)).toBe(NOW + 50);
  });

  test('null retry clocks are ignored, non-null ones are not', () => {
    expect(nextAlarmTime(NOW, [NOW + 50], null, NOW + 10)).toBe(NOW + 10);
    expect(nextAlarmTime(NOW, [NOW + 50], null, null)).toBe(NOW + 50);
  });

  test('a zero retry timestamp is a real clock, not an absent one', () => {
    // `retryAt != null` must not degrade into a truthiness check.
    expect(nextAlarmTime(NOW, [], 0)).toBe(NOW);
  });
});
