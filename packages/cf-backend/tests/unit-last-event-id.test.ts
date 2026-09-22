// The Last-Event-ID resume contract, asserted on the exported function the SSE route calls, never a mirror.
// It lives beside the run-event wire because the route reaches `cloudflare:*`.
import { describe, test, expect } from 'bun:test';
import { resumeIndexFromLastEventId } from '@kinu.run/core';

/** Answers the replay-from-start sentinel rather than a position. */
function eachReplaysFromStart(headers: readonly string[]): void {
  for (const header of headers) {
    expect(resumeIndexFromLastEventId(header)).toBe(-1);
  }
}

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
    // `readSince(-2)` is a seek to nothing.
    eachReplaysFromStart(['-2', '-1000']);
  });

  test('a fraction is not an event index', () => {
    eachReplaysFromStart(['3.14', '0.5']);
  });

  test('unparseable and non-finite headers replay from the start', () => {
    // A NaN cursor compares false against every index, re-delivering the whole run on each reconnect.
    eachReplaysFromStart(['NaN', 'abc', '', ' ', 'Infinity', '-Infinity', '1e400']);
  });

  test('every accepted value is an integer at or above the sentinel', () => {
    // Quantified: the cursor is never a fraction, NaN, or below the start.
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
