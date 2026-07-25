import { describe, test, expect } from 'bun:test';
import {
  normalQuantile, binomialTwoSidedP, seededRandom, pairedBootstrapCI,
  minimumDetectableEffect, requiredPairs, pairedBinaryComparison, computeGain,
  floorPValue, minimumPairsForSignificance,
  DEFAULT_ALPHA,
} from '../src/index.ts';
import type { PairedOutcome } from '../src/index.ts';

describe('normalQuantile', () => {
  test('matches the textbook z values', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.8)).toBeCloseTo(0.841621, 5);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 9);
    expect(normalQuantile(0.025)).toBeCloseTo(-1.959964, 5);
  });

  test('rejects out-of-range probabilities', () => {
    expect(() => normalQuantile(0)).toThrow();
    expect(() => normalQuantile(1)).toThrow();
  });
});

describe('binomialTwoSidedP (exact McNemar null)', () => {
  test('no discordant pairs cannot reject', () => {
    expect(binomialTwoSidedP(0, 0)).toBe(1);
  });

  test('reproduces exact binomial tails', () => {
    // X ~ Bin(10, 0.5): P(X<=1) = 11/1024 → two-sided 22/1024.
    expect(binomialTwoSidedP(1, 10)).toBeCloseTo((2 * 11) / 1024, 10);
    // All 6 discordant pairs favour one side: 2 * (1/64).
    expect(binomialTwoSidedP(6, 6)).toBeCloseTo(2 / 64, 10);
    // Perfectly balanced is maximally unsurprising.
    expect(binomialTwoSidedP(5, 10)).toBe(1);
  });

  test('stays a probability for large discordant counts', () => {
    const p = binomialTwoSidedP(120, 400);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1e-6);
  });
});

describe('seededRandom', () => {
  test('is reproducible and in range', () => {
    const a = Array.from({ length: 50 }, seededRandom(42));
    const b = Array.from({ length: 50 }, seededRandom(42));
    expect(a).toEqual(b);
    expect(a.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(Array.from({ length: 5 }, seededRandom(43))).not.toEqual(a.slice(0, 5));
  });
});

describe('pairedBootstrapCI', () => {
  test('brackets the mean and is deterministic under a seed', () => {
    const diffs = [1, 1, 0, 1, 0, 1, 1, 0, 1, 1];
    const r1 = pairedBootstrapCI(diffs, { seed: 7, iterations: 2000 });
    const r2 = pairedBootstrapCI(diffs, { seed: 7, iterations: 2000 });
    expect(r1).toEqual(r2);
    expect(r1.mean).toBeCloseTo(0.7, 10);
    expect(r1.ci.lo).toBeLessThanOrEqual(r1.mean);
    expect(r1.ci.hi).toBeGreaterThanOrEqual(r1.mean);
    expect(r1.ci.level).toBeCloseTo(0.95, 10);
  });

  test('a constant difference vector has a degenerate interval', () => {
    const r = pairedBootstrapCI([1, 1, 1, 1], { seed: 3, iterations: 500 });
    expect(r.ci.lo).toBe(1);
    expect(r.ci.hi).toBe(1);
  });

  test('empty input yields a zero effect, not NaN', () => {
    const r = pairedBootstrapCI([], { seed: 1 });
    expect(r.mean).toBe(0);
    expect(Number.isNaN(r.ci.lo)).toBe(false);
  });
});

describe('minimumDetectableEffect', () => {
  // The calibration anchor stated in the harness docs: at ~157 paired tasks
  // with 20% discordance, alpha=0.05 and power=0.8, the design resolves ~10pp.
  test('157 pairs at 20% discordance resolves ~10pp', () => {
    const mde = minimumDetectableEffect({ pairs: 157, discordanceRate: 0.2 });
    expect(mde).toBeCloseTo(0.1, 3);
  });

  test('3pp at that discordance needs far more pairs than the corpus has', () => {
    expect(requiredPairs(0.03, { discordanceRate: 0.2 })).toBe(1745);
    // Round-trip: the pairs required for delta must actually resolve delta.
    const n = requiredPairs(0.1, { discordanceRate: 0.2 });
    expect(minimumDetectableEffect({ pairs: n, discordanceRate: 0.2 })).toBeLessThanOrEqual(0.1);
  });

  test('degenerate designs resolve nothing', () => {
    expect(minimumDetectableEffect({ pairs: 0, discordanceRate: 0.2 })).toBe(Infinity);
    expect(minimumDetectableEffect({ pairs: 100, discordanceRate: 0 })).toBe(Infinity);
    expect(requiredPairs(0, { discordanceRate: 0.2 })).toBe(Infinity);
  });

  test('more pairs resolve smaller effects', () => {
    const small = minimumDetectableEffect({ pairs: 50, discordanceRate: 0.2 });
    const large = minimumDetectableEffect({ pairs: 500, discordanceRate: 0.2 });
    expect(large).toBeLessThan(small);
  });
});

function outcomes(spec: { a: boolean; b: boolean }[]): PairedOutcome[] {
  return spec.map((s, i) => ({ taskId: `t${i}`, ...s }));
}

describe('pairedBinaryComparison', () => {
  test('counts the 2x2 table and pass rates', () => {
    const stats = pairedBinaryComparison(outcomes([
      { a: true, b: true }, { a: true, b: true },
      { a: false, b: false },
      { a: true, b: false },
      { a: false, b: true }, { a: false, b: true }, { a: false, b: true },
    ]), { seed: 1, iterations: 1000 });
    expect(stats.pairs).toBe(7);
    expect(stats.bothPass).toBe(2);
    expect(stats.bothFail).toBe(1);
    expect(stats.onlyA).toBe(1);
    expect(stats.onlyB).toBe(3);
    expect(stats.discordant).toBe(4);
    expect(stats.passRateA).toBeCloseTo(3 / 7, 10);
    expect(stats.passRateB).toBeCloseTo(5 / 7, 10);
    expect(stats.effect).toBeCloseTo(2 / 7, 10);
  });

  test('identical variants produce zero discordance and an honest verdict', () => {
    const stats = pairedBinaryComparison(outcomes([
      { a: true, b: true }, { a: false, b: false }, { a: true, b: true },
    ]), { seed: 1, iterations: 500 });
    expect(stats.discordant).toBe(0);
    expect(stats.pValue).toBe(1);
    expect(stats.significant).toBe(false);
    expect(stats.resolvable).toBe(false);
    expect(stats.verdict).toContain('cannot separate');
  });

  test('a large real difference is significant AND resolvable', () => {
    // 40 pairs, candidate wins 14 discordant, baseline wins 1.
    const spec = [
      ...Array.from({ length: 14 }, () => ({ a: false, b: true })),
      ...Array.from({ length: 1 }, () => ({ a: true, b: false })),
      ...Array.from({ length: 25 }, () => ({ a: true, b: true })),
    ];
    const stats = pairedBinaryComparison(outcomes(spec), { seed: 5, iterations: 4000 });
    expect(stats.significant).toBe(true);
    expect(stats.resolvable).toBe(true);
    expect(stats.effect).toBeCloseTo(13 / 40, 10);
    expect(stats.ci.lo).toBeGreaterThan(0);
    expect(stats.verdict).toContain('significant');
  });

  test('a tiny effect on a small corpus is flagged unresolvable, not a finding', () => {
    // 100 pairs, +1pp effect: nowhere near the design's resolution.
    const spec = [
      ...Array.from({ length: 11 }, () => ({ a: false, b: true })),
      ...Array.from({ length: 10 }, () => ({ a: true, b: false })),
      ...Array.from({ length: 79 }, () => ({ a: true, b: true })),
    ];
    const stats = pairedBinaryComparison(outcomes(spec), { seed: 9, iterations: 2000 });
    expect(stats.effect).toBeCloseTo(0.01, 10);
    expect(stats.resolutionRatio).toBeLessThan(1);
    expect(stats.resolvable).toBe(false);
    expect(stats.verdict).toContain('resolves');
    expect(stats.pairsNeededForObserved).toBeGreaterThan(100);
  });

  test('a split too small to ever reach significance says so', () => {
    // 5 all-discordant pairs bottom out at p=0.0625 — no outcome clears 0.05.
    const spec = Array.from({ length: 5 }, () => ({ a: false, b: true }));
    const stats = pairedBinaryComparison(outcomes(spec), { seed: 1, iterations: 500 });
    expect(stats.floorPValue).toBeCloseTo(2 / 32, 10);
    expect(stats.canReachSignificance).toBe(false);
    expect(stats.significant).toBe(false);
    expect(stats.verdict).toContain('can never reach');
    // One more pair and it becomes possible.
    const six = pairedBinaryComparison(outcomes([...spec, { a: false, b: true }]), { seed: 1, iterations: 500 });
    expect(six.canReachSignificance).toBe(true);
    expect(six.significant).toBe(true);
  });

  test('floorPValue / minimumPairsForSignificance agree', () => {
    expect(floorPValue(0)).toBe(1);
    expect(floorPValue(6)).toBeCloseTo(2 / 64, 10);
    expect(minimumPairsForSignificance(0.05)).toBe(6);
    expect(minimumPairsForSignificance(0.01)).toBe(8);
    expect(floorPValue(minimumPairsForSignificance(0.05))).toBeLessThanOrEqual(0.05);
  });

  test('an empty run concludes nothing', () => {
    const stats = pairedBinaryComparison([], { seed: 1, iterations: 100 });
    expect(stats.pairs).toBe(0);
    expect(stats.verdict).toContain('nothing to conclude');
    expect(stats.significant).toBe(false);
  });

  test('is symmetric: swapping arms flips the sign of the effect', () => {
    const spec = [
      { a: false, b: true }, { a: false, b: true }, { a: true, b: false },
      { a: true, b: true }, { a: false, b: false },
    ];
    const fwd = pairedBinaryComparison(outcomes(spec), { seed: 2, iterations: 1000 });
    const rev = pairedBinaryComparison(outcomes(spec.map((s) => ({ a: s.b, b: s.a }))), { seed: 2, iterations: 1000 });
    expect(rev.effect).toBeCloseTo(-fwd.effect, 10);
    expect(rev.pValue).toBeCloseTo(fwd.pValue, 10);
    expect(rev.mde).toBeCloseTo(fwd.mde, 10);
  });
});

describe('computeGain (stateful vs stateless)', () => {
  test('normalizes by remaining headroom', () => {
    const g = computeGain([
      { taskId: 'a', stateful: 1, stateless: 0 },
      { taskId: 'b', stateful: 1, stateless: 1 },
      { taskId: 'c', stateful: 1, stateless: 0 },
      { taskId: 'd', stateful: 1, stateless: 1 },
    ], { seed: 4, iterations: 2000 });
    expect(g.statefulReward).toBe(1);
    expect(g.statelessReward).toBe(0.5);
    expect(g.gain).toBeCloseTo(0.5, 10);
    expect(g.normalizedGain).toBeCloseTo(1, 10); // captured all the headroom
  });

  test('zero gain is reportable as a real result', () => {
    const g = computeGain([
      { taskId: 'a', stateful: 1, stateless: 1 },
      { taskId: 'b', stateful: 0, stateless: 0 },
      { taskId: 'c', stateful: 1, stateless: 1 },
      { taskId: 'd', stateful: 0, stateless: 0 },
    ], { seed: 4, iterations: 2000 });
    expect(g.gain).toBe(0);
    expect(g.verdict).toContain('no measurable contribution');
  });

  test('a negative gain is reported as the stateful arm doing worse', () => {
    const g = computeGain([
      { taskId: 'a', stateful: 0, stateless: 1 },
      { taskId: 'b', stateful: 0, stateless: 1 },
      { taskId: 'c', stateful: 0, stateless: 1 },
      { taskId: 'd', stateful: 0, stateless: 1 },
    ], { seed: 4, iterations: 2000 });
    expect(g.gain).toBeCloseTo(-1, 10);
    expect(g.verdict).toContain('WORSE');
    expect(g.pValue).toBeCloseTo(2 / 16, 10);
  });

  test('no headroom leaves the normalized gain undefined rather than infinite', () => {
    const g = computeGain([
      { taskId: 'a', stateful: 1, stateless: 1 },
      { taskId: 'b', stateful: 1, stateless: 1 },
    ], { seed: 4, iterations: 500 });
    expect(g.normalizedGain).toBeNull();
    expect(Number.isFinite(g.gain)).toBe(true);
  });

  test('an empty gain run says so', () => {
    const g = computeGain([], { seed: 1, iterations: 100 });
    expect(g.tasks).toBe(0);
    expect(g.verdict).toContain('no gain measured');
    expect(DEFAULT_ALPHA).toBe(0.05);
  });
});
