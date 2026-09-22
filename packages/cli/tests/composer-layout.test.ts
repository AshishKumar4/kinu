import { describe, expect, test } from 'bun:test';
import { composerVisibleRows } from '@kinu.run/core';

function observedCap(): number {
  let prev = composerVisibleRows(1);

  for (let n = 2; n < 1000; n++) {
    const cur = composerVisibleRows(n);

    if (cur === prev) return prev;
    prev = cur;
  }

  throw new Error('the composer never caps');
}

describe('composer rows', () => {
  test('an empty draft still owns a row for its placeholder', () => {
    expect(composerVisibleRows(0)).toBe(1);
    expect(composerVisibleRows(1)).toBe(1);
  });

  test('a wrapped draft grows row for row up to the cap, then stops', () => {
    const cap = observedCap();
    expect(cap).toBeGreaterThan(1);
    // The engine reports visual rows, so growth is per wrapped row, not per typed line.
    expect(composerVisibleRows(2)).toBe(2);
    expect(composerVisibleRows(cap - 1)).toBe(cap - 1);
    expect(composerVisibleRows(cap)).toBe(cap);
    // Past the cap the extra rows are scrolled, never shown and never lost.
    expect(composerVisibleRows(cap + 1)).toBe(cap);
    expect(composerVisibleRows(cap + 100)).toBe(cap);
  });

  test('the cap is a caller-supplied bound, and never below one row', () => {
    expect(composerVisibleRows(5, 3)).toBe(3);
    expect(composerVisibleRows(5, 1)).toBe(1);
    expect(composerVisibleRows(5, 0)).toBe(1);
    expect(composerVisibleRows(5, -4)).toBe(1);
  });

  test('a count no editor could report reads as one row, never NaN height', () => {
    // Before the first layout there is no wrap width; a NaN box height takes the scene down.
    expect(composerVisibleRows(Number.NaN)).toBe(1);
    expect(composerVisibleRows(Number.POSITIVE_INFINITY)).toBe(1);
    expect(composerVisibleRows(-3)).toBe(1);
    expect(composerVisibleRows(2.7)).toBe(2);
  });
});
