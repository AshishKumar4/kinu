import { describe, expect, test } from 'bun:test';
import { nextCronFire } from '../src/events/hub/cron.js';

const BASE = Date.UTC(2026, 5, 2, 10, 17, 30);

describe('nextCronFire', () => {
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
