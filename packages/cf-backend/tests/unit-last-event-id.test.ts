// The Last-Event-ID resume contract of the SSE stream route.
//
// This file used to hold a hand-copied MIRROR of the validator, with a docstring
// asking the next editor to keep both in sync. It therefore asserted nothing
// about the route: flipping the shipped `n >= -1` to `n >= 0`, or dropping the
// `Number.isInteger` arm, left all ten cases green while a reconnect either
// replayed events the client already had or seeked past them. The subject is now
// the exported function the route actually calls — it lives beside the run-event
// wire rather than in the route because the route reaches `cloudflare:*`.
import { describe, test, expect } from 'bun:test';
import { resumeIndexFromLastEventId } from '../src/lib/orchestrator-wire';

describe('Last-Event-ID resume index', () => {
  test('an absent header replays from the start', () => {
    expect(resumeIndexFromLastEventId(null)).toBe(-1);
  });

  test('the first event index is a position, not a falsy no-op', () => {
    expect(resumeIndexFromLastEventId('0')).toBe(0);
  });

  test('a mid-stream index resumes there', () => {
    expect(resumeIndexFromLastEventId('42')).toBe(42);
    expect(resumeIndexFromLastEventId('1000000')).toBe(1000000);
  });

  test('-1 is the sentinel a client may state explicitly', () => {
    expect(resumeIndexFromLastEventId('-1')).toBe(-1);
  });

  test('a negative below the sentinel is not a position', () => {
    // -2 must not become a cursor: `readSince(-2)` is a seek to nothing.
    expect(resumeIndexFromLastEventId('-2')).toBe(-1);
    expect(resumeIndexFromLastEventId('-1000')).toBe(-1);
  });

  test('a fraction is not an event index', () => {
    expect(resumeIndexFromLastEventId('3.14')).toBe(-1);
    expect(resumeIndexFromLastEventId('0.5')).toBe(-1);
  });

  test('unparseable and non-finite headers replay from the start', () => {
    // The reason the guard exists: a NaN cursor compares false against every
    // index, so the stream would re-deliver the whole run on each reconnect.
    for (const header of ['NaN', 'abc', '', ' ', 'Infinity', '-Infinity', '1e400']) {
      expect(resumeIndexFromLastEventId(header)).toBe(-1);
    }
  });

  test('every accepted value is an integer at or above the sentinel', () => {
    // The invariant the route depends on, quantified rather than sampled: the
    // cursor `streamRunEvents` receives is never a fraction, a NaN, or a seek
    // below the start.
    const headers = [
      null, '0', '1', '42', '-1', '-2', '-7', '3.14', '-0.5', 'NaN', 'abc', '',
      'Infinity', '1e21', '0x10', '7 ', ' 7', '+7', '1_000',
    ];
    for (const header of headers) {
      const index = resumeIndexFromLastEventId(header);
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(-1);
    }
  });
});
