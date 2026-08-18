/**
 * Confidence intervals — the Wilson bounds every reported score travels with.
 * Expected values are the published Wilson figures for these counts, checked
 * by hand rather than recomputed from the implementation.
 */
import { describe, test, expect } from 'bun:test';
import {
  wilsonInterval, scoreInterval, lossInterval, formatScoreInterval,
} from '../src/utils/stats';

describe('wilsonInterval — hand-checked against published values', () => {
  test('3 of 4 → (0.3006, 0.9544)', () => {
    const i = wilsonInterval(3, 4);
    expect(i.mean).toBe(0.75);
    expect(i.lo).toBeCloseTo(0.3006, 4);
    expect(i.hi).toBeCloseTo(0.9544, 4);
    expect(i.n).toBe(4);
  });

  test('0 of 10 → (0, 0.2775): the bound never escapes [0,1]', () => {
    const i = wilsonInterval(0, 10);
    expect(i.mean).toBe(0);
    expect(i.lo).toBe(0);
    expect(i.hi).toBeCloseTo(0.2775, 4);
  });

  test('10 of 10 → (0.7225, 1): the mirror image', () => {
    const i = wilsonInterval(10, 10);
    expect(i.lo).toBeCloseTo(0.7225, 4);
    // Exactly 1 in closed form; floating point lands a rounding step below.
    expect(i.hi).toBeCloseTo(1, 10);
  });

  test('unanimous judges do not produce a zero-width interval', () => {
    const i = wilsonInterval(6, 6);
    expect(i.mean).toBe(1);
    expect(i.lo).toBeCloseTo(0.6097, 4);
    expect(i.hi).toBeCloseTo(1, 10);
  });

  test('the half-widths the budgets were chosen against, at p = 0.5', () => {
    const halfWidth = (n: number) => {
      const i = wilsonInterval(n / 2, n);
      return (i.hi - i.lo) / 2;
    };
    expect(halfWidth(6)).toBeCloseTo(0.312, 3);
    expect(halfWidth(8)).toBeCloseTo(0.285, 3);
    expect(halfWidth(16)).toBeCloseTo(0.220, 3);
    expect(halfWidth(20)).toBeCloseTo(0.201, 3);
    expect(halfWidth(24)).toBeCloseTo(0.186, 3);
    expect(halfWidth(48)).toBeCloseTo(0.136, 3);
  });

  test('no observations → the uninformative [0,1] interval, not a claim', () => {
    expect(wilsonInterval(0, 0)).toEqual({ mean: 0, lo: 0, hi: 1, n: 0 });
    expect(scoreInterval([])).toEqual({ mean: 0, lo: 0, hi: 1, n: 0 });
  });
});

describe('scoreInterval / lossInterval / formatScoreInterval', () => {
  test('fractional judge scores sum into the same interval as whole successes', () => {
    expect(scoreInterval([1, 0.5, 0.5, 1])).toEqual(wilsonInterval(3, 4));
  });

  test('loss is the complement, bounds flipped', () => {
    const score = wilsonInterval(3, 4);
    const loss = lossInterval(score);
    expect(loss.mean).toBeCloseTo(0.25, 10);
    expect(loss.lo).toBeCloseTo(1 - score.hi, 10);
    expect(loss.hi).toBeCloseTo(1 - score.lo, 10);
    expect(loss.n).toBe(4);
  });

  test('one rendering, everywhere', () => {
    expect(formatScoreInterval(wilsonInterval(3, 4))).toBe('0.75 (95% CI 0.30–0.95)');
    expect(formatScoreInterval(wilsonInterval(3, 4), 3)).toBe('0.750 (95% CI 0.301–0.954)');
  });
});
