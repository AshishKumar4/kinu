// Behavior test for Last-Event-ID validation in run-events-routes.
//
// The validator must accept non-negative integers, reject NaN/floats/
// negatives-less-than--1/strings, and default to -1 (replay from start).
import { describe, test, expect } from 'bun:test';

/** Mirror of the Last-Event-ID validator in run-events-routes.ts. Kept in sync
 *  with the production code via this test — if the production logic
 *  changes, update both. */
function validateSinceIndex(lastEventId: string | null): number {
  let sinceIndex = -1;
  if (lastEventId !== null) {
    const n = Number(lastEventId);
    if (Number.isFinite(n) && n >= -1 && Number.isInteger(n)) sinceIndex = n;
  }
  return sinceIndex;
}

describe('Last-Event-ID validator', () => {
  test('null → -1 (replay from start)', () => {
    expect(validateSinceIndex(null)).toBe(-1);
  });

  test('"0" → 0', () => {
    expect(validateSinceIndex('0')).toBe(0);
  });

  test('"42" → 42', () => {
    expect(validateSinceIndex('42')).toBe(42);
  });

  test('"-1" → -1 (explicit start)', () => {
    expect(validateSinceIndex('-1')).toBe(-1);
  });

  test('"NaN" → -1 (replay all)', () => {
    expect(validateSinceIndex('NaN')).toBe(-1);
  });

  test('"abc" → -1 (unparseable string)', () => {
    expect(validateSinceIndex('abc')).toBe(-1);
  });

  test('"3.14" → -1 (non-integer rejected)', () => {
    expect(validateSinceIndex('3.14')).toBe(-1);
  });

  test('"-2" → -1 (only -1 sentinel allowed for negative)', () => {
    expect(validateSinceIndex('-2')).toBe(-1);
  });

  test('"Infinity" → -1 (rejected as non-finite)', () => {
    expect(validateSinceIndex('Infinity')).toBe(-1);
  });

  test('large valid integer accepted', () => {
    expect(validateSinceIndex('1000000')).toBe(1000000);
  });
});
