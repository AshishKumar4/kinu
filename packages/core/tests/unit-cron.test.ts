import { describe, expect, test } from 'bun:test';
import { nextAlarmTime, nextCronFire } from '../src/events/hub/cron';
import { present } from '@kinu.run/test-utils';

const BASE = Date.UTC(2026, 5, 2, 10, 17, 30);

describe('nextCronFire', () => {
  test('a six-field Quartz seconds-form expression is refused, not misread', () => {
    // Without the arity guard a six-field expression reads as all wildcards and fires every minute.
    expect(nextCronFire('0 */5 * * * *', 1_700_000_000_000)).toBeNull();
    expect(nextCronFire('0 0 12 * * ?', 1_700_000_000_000)).toBeNull();
  });

  const supported = [
    {
      name: 'supports wildcard, step, and integer minute fields',
      fires: [
        ['0 * * * *', '2026-06-02T11:00:00.000Z'],
        ['* * * * *', '2026-06-02T10:18:00.000Z'],
        ['*/30 * * * *', '2026-06-02T10:30:00.000Z'],
      ],
    },
    {
      name: 'supports wildcard, step, and integer hour fields',
      fires: [
        ['30 2 * * *', '2026-06-03T02:30:00.000Z'],
        ['0 */6 * * *', '2026-06-02T12:00:00.000Z'],
        ['* 11 * * *', '2026-06-02T11:00:00.000Z'],
      ],
    },
  ] as const;

  for (const field of supported) {
    test(field.name, () => {
      for (const [expression, at] of field.fires) {
        const fired = present(nextCronFire(expression, BASE), `the next fire of ${expression}`);

        expect(new Date(fired).toISOString()).toBe(at);
      }
    });
  }

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
    // A past-due retry must re-arm immediately or it stalls until an unrelated event wakes the DO.
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

// The rc27 review: a brief seeded as a UTC cron from the offset on the day of install moved an hour at the next
// daylight-saving change. A schedule in a zone keeps its wall clock.
describe('nextCronFire in a time zone', () => {
  const iso = (at: number | null) => new Date(present(at, 'a fire')).toISOString();

  test("an 08:00 brief in New York stays at 08:00 New York across the November change", () => {
    // 12:00 UTC on 31 Oct 2026 is 08:00 EDT; on 2 Nov, after the change, 08:00 EST is 13:00 UTC.
    expect(iso(nextCronFire('0 8 * * *', Date.UTC(2026, 9, 30, 13), 'America/New_York'))).toBe('2026-10-31T12:00:00.000Z');
    expect(iso(nextCronFire('0 8 * * *', Date.UTC(2026, 10, 1, 13), 'America/New_York'))).toBe('2026-11-02T13:00:00.000Z');
  });

  test('a half-hour zone, an old alias a browser reports, and UTC read alike', () => {
    expect(iso(nextCronFire('30 9 * * *', Date.UTC(2026, 0, 1), 'Asia/Kolkata'))).toBe('2026-01-01T04:00:00.000Z');
    expect(iso(nextCronFire('30 9 * * *', Date.UTC(2026, 0, 1), 'Asia/Calcutta'))).toBe('2026-01-01T04:00:00.000Z');
    expect(iso(nextCronFire('0 8 * * *', Date.UTC(2026, 0, 1), 'UTC'))).toBe('2026-01-01T08:00:00.000Z');
    expect(nextCronFire('0 8 * * *', Date.UTC(2026, 0, 1), 'Mars/Olympus_Mons')).toBeNull();
  });

  test('a minute the clocks repeat fires once, and a minute they skip waits for the next day', () => {
    // 1 Nov 2026 in New York: 01:30 EDT (05:30 UTC), then 01:30 EST (06:30 UTC). The next after the first is a day on.
    const first = nextCronFire('30 1 * * *', Date.UTC(2026, 10, 1, 4), 'America/New_York');

    expect(iso(first)).toBe('2026-11-01T05:30:00.000Z');
    expect(iso(nextCronFire('30 1 * * *', present(first, 'the first pass'), 'America/New_York'))).toBe('2026-11-02T06:30:00.000Z');
    // 8 Mar 2026: 02:30 does not happen in New York; the next 02:30 is on the 9th (06:30 UTC, EDT).
    expect(iso(nextCronFire('30 2 * * *', Date.UTC(2026, 2, 8, 5), 'America/New_York'))).toBe('2026-03-09T06:30:00.000Z');
  });
});
