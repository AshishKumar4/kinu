import { describe, test, expect } from 'bun:test';
import {
  normalQuantile, binomialTwoSidedP, seededRandom, pairedBootstrapCI,
  minimumDetectableEffect, requiredPairs, pairedBinaryComparison, computeGain,
  floorPValue, minimumPairsForSignificance, summarizeRepeats,
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
  // with 20% dispersion (= 20% discordance at one attempt per task),
  // alpha=0.05 and power=0.8, the design resolves ~10pp.
  test('157 pairs at 20% dispersion resolves ~10pp', () => {
    const mde = minimumDetectableEffect({ pairs: 157, dispersion: 0.2 });
    expect(mde).toBeCloseTo(0.1, 3);
  });

  test('3pp at that dispersion needs far more pairs than the corpus has', () => {
    expect(requiredPairs(0.03, { dispersion: 0.2 })).toBe(1745);
    // Round-trip: the pairs required for delta must actually resolve delta.
    const n = requiredPairs(0.1, { dispersion: 0.2 });
    expect(minimumDetectableEffect({ pairs: n, dispersion: 0.2 })).toBeLessThanOrEqual(0.1);
  });

  test('degenerate designs resolve nothing', () => {
    expect(minimumDetectableEffect({ pairs: 0, dispersion: 0.2 })).toBe(Infinity);
    expect(minimumDetectableEffect({ pairs: 100, dispersion: 0 })).toBe(Infinity);
    expect(requiredPairs(0, { dispersion: 0.2 })).toBe(Infinity);
  });

  test('more pairs resolve smaller effects', () => {
    const small = minimumDetectableEffect({ pairs: 50, dispersion: 0.2 });
    const large = minimumDetectableEffect({ pairs: 500, dispersion: 0.2 });
    expect(large).toBeLessThan(small);
  });
});

/** Single-attempt pairs — the k=1 design, expressed as one-element repeats. */
function outcomes(spec: { a: boolean; b: boolean }[]): PairedOutcome[] {
  return spec.map((s, i) => ({ taskId: `t${i}`, a: [s.a], b: [s.b] }));
}

/** Repeated pairs: `a`/`b` are the per-repeat outcomes of one task. */
function repeated(spec: { a: boolean[]; b: boolean[] }[]): PairedOutcome[] {
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
    expect(stats.passAtOneA).toBeCloseTo(3 / 7, 10);
    expect(stats.passAtOneB).toBeCloseTo(5 / 7, 10);
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

describe('repeats — the unit of pairing stays the task', () => {
  test('naive per-attempt pairing would call this significant; per-task pairing does not', () => {
    // Four tasks, three repeats each. The candidate sweeps every repeat of
    // every task and the baseline fails every one of them — as clean a win as
    // the design can produce, and STILL only four independent pairs.
    const spec = Array.from({ length: 4 }, () => ({ a: [false, false, false], b: [true, true, true] }));
    const stats = pairedBinaryComparison(repeated(spec), { seed: 1, iterations: 2000 });

    expect(stats.pairs).toBe(4);
    expect(stats.repeats).toBe(3);
    expect(stats.attemptsPerVariant).toBe(12);
    expect(stats.discordant).toBe(4);
    // 4 discordant TASKS all favouring B: 2·0.5^4.
    expect(stats.pValue).toBeCloseTo(2 / 16, 10);
    expect(stats.significant).toBe(false);
    expect(stats.canReachSignificance).toBe(false);

    // What pseudoreplication would have produced: the same 12 attempts fed in
    // as 12 independent pairs. 2·0.5^12 = 0.00049 — "significant", from four
    // tasks, purely by counting the same task three times.
    const naive = pairedBinaryComparison(
      spec.flatMap((s, t) => s.a.map((a, r) => ({ taskId: `t${t}-r${r}`, a: [a], b: [s.b[r]!] }))),
      { seed: 1, iterations: 2000 },
    );
    expect(naive.pairs).toBe(12);
    expect(naive.pValue).toBeLessThan(0.001);
    expect(naive.significant).toBe(true);
    expect(stats.pValue / naive.pValue).toBeGreaterThan(200);
  });

  test('pass@1 and pass^k measure different things', () => {
    const stats = pairedBinaryComparison(repeated([
      // A is reliable, B is a coin-flipper that looks good on a single shot.
      { a: [true, true, true], b: [true, true, false] },
      { a: [true, true, true], b: [true, false, true] },
      { a: [false, false, false], b: [true, true, true] },
      { a: [false, false, false], b: [false, false, false] },
    ]), { seed: 2, iterations: 2000 });

    // pass@1 averages every attempt: A = (1+1+0+0)/4, B = (2/3+2/3+1+0)/4.
    expect(stats.passAtOneA).toBeCloseTo(0.5, 10);
    expect(stats.passAtOneB).toBeCloseTo((2 / 3 + 2 / 3 + 1) / 4, 10);
    expect(stats.effect).toBeCloseTo(stats.passAtOneB - stats.passAtOneA, 10);
    // pass^3 counts only tasks solved in ALL three: A = 2/4, B = 1/4.
    expect(stats.passAllA).toBeCloseTo(0.5, 10);
    expect(stats.passAllB).toBeCloseTo(0.25, 10);
    expect(stats.effectAll).toBeCloseTo(-0.25, 10);
    // Single-shot says B is ahead; reliability says B is behind. Both reported.
    expect(stats.effect).toBeGreaterThan(0);
    expect(stats.effectAll).toBeLessThan(0);
  });

  test('at one repeat pass^k is pass@1 and dispersion is the discordance rate', () => {
    const spec = [
      { a: false, b: true }, { a: true, b: false }, { a: true, b: true },
      { a: false, b: false }, { a: false, b: true },
    ];
    const stats = pairedBinaryComparison(outcomes(spec), { seed: 3, iterations: 1000 });
    expect(stats.repeats).toBe(1);
    expect(stats.passAllA).toBeCloseTo(stats.passAtOneA, 10);
    expect(stats.passAllB).toBeCloseTo(stats.passAtOneB, 10);
    expect(stats.dispersion).toBeCloseTo(stats.discordanceRate, 10);
    expect(stats.tiedPartial).toBe(0);
    expect(stats.flakyEither).toBe(0);
    // And the p-value is still exactly McNemar's: 3 discordant, 2 favour B.
    expect(stats.pValue).toBeCloseTo(binomialTwoSidedP(2, 3), 10);
  });

  test('a flaky task is surfaced, not averaged away', () => {
    const stats = pairedBinaryComparison(repeated([
      { a: [true, false, true], b: [true, true, true] },   // A unstable
      { a: [true, true, true], b: [false, true, false] },  // B unstable
      { a: [true, false, true], b: [true, false, true] },  // both unstable, tied
      { a: [true, true, true], b: [true, true, true] },    // stable
    ]), { seed: 4, iterations: 1000 });

    expect(stats.flakyA).toBe(2);
    expect(stats.flakyB).toBe(2);
    expect(stats.flakyEither).toBe(3);
    // The both-unstable tie is neither a clean pass nor a clean fail, and is
    // counted as neither rather than being rounded into one.
    expect(stats.tiedPartial).toBe(1);
    expect(stats.bothPass).toBe(1);
    expect(stats.bothFail).toBe(0);
    expect(stats.verdict).toContain('repeats buy precision within a task');
  });

  test('repeats shrink dispersion, so the reported resolution reflects them', () => {
    // Same four tasks, same true per-task rates. At one attempt the sampled
    // difference is ±1 on the noisy tasks; at three attempts it is ±1/3, and
    // the design's detectable effect follows the dispersion down.
    const noisy = pairedBinaryComparison(repeated([
      { a: [true, true, false], b: [true, true, true] },
      { a: [true, false, true], b: [true, true, true] },
      { a: [true, true, true], b: [true, true, true] },
      { a: [false, false, false], b: [false, false, false] },
    ]), { seed: 5, iterations: 1000 });
    const single = pairedBinaryComparison(outcomes([
      { a: false, b: true }, { a: false, b: true },
      { a: true, b: true }, { a: false, b: false },
    ]), { seed: 5, iterations: 1000 });

    expect(noisy.pairs).toBe(single.pairs);
    expect(noisy.dispersion).toBeLessThan(single.dispersion);
    expect(noisy.mde).toBeLessThan(single.mde);
    // The pair count — and therefore the p-value — is untouched by repeats.
    expect(noisy.pValue).toBeCloseTo(single.pValue, 10);
  });

  test('is deterministic under a fixed seed with repeats > 1', () => {
    const spec = [
      { a: [true, false, true], b: [true, true, false] },
      { a: [false, false, true], b: [true, true, true] },
      { a: [true, true, true], b: [false, true, true] },
    ];
    const first = pairedBinaryComparison(repeated(spec), { seed: 11, iterations: 3000 });
    const second = pairedBinaryComparison(repeated(spec), { seed: 11, iterations: 3000 });
    expect(first).toEqual(second);
  });

  test('summarizeRepeats is the one place repeats collapse to a task', () => {
    const s = summarizeRepeats({ taskId: 't', a: [true, false, false], b: [true, true, true] });
    expect(s).toEqual({
      taskId: 't', repeats: 3, passesA: 1, passesB: 3,
      rateA: 1 / 3, rateB: 1, allA: false, allB: true, flakyA: true, flakyB: false,
    });
  });

  test('ragged or empty repeats are refused rather than silently rebalanced', () => {
    expect(() => summarizeRepeats({ taskId: 't', a: [true, true], b: [true] }))
      .toThrow(/cannot compare unequal repeats/);
    expect(() => summarizeRepeats({ taskId: 't', a: [], b: [] })).toThrow(/no attempts/);
    expect(() => pairedBinaryComparison(repeated([
      { a: [true, true], b: [true, true] },
      { a: [true], b: [true] },
    ]))).toThrow(/no single pass\^k/);
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
    // Two of four tasks differed, and two differing pairs bottom out at p=0.5,
    // so the arithmetic is right and the design still cannot decide.
    expect(g.pairsWithDifference).toBe(2);
    expect(g.canReachSignificance).toBe(false);
    expect(g.verdict).toContain('UNDECIDABLE');
  });

  test('zero gain is reportable as a real result', () => {
    const g = computeGain([
      { taskId: 'a', stateful: 1, stateless: 1 },
      { taskId: 'b', stateful: 0, stateless: 0 },
      { taskId: 'c', stateful: 1, stateless: 1 },
      { taskId: 'd', stateful: 0, stateless: 0 },
    ], { seed: 4, iterations: 2000 });
    expect(g.gain).toBe(0);
    // An empty denominator is vacuous per task and a failure per design: no task
    // differed, so this contrast measured nothing and must not read as a neutral
    // "no effect". That is what an inert mechanism looks like from the outside.
    expect(g.pairsWithDifference).toBe(0);
    expect(g.canReachSignificance).toBe(false);
    expect(g.verdict).toContain('measured nothing at all');
  });

  test('a negative gain is reported as the stateful arm doing worse', () => {
    const g = computeGain([
      { taskId: 'a', stateful: 0, stateless: 1 },
      { taskId: 'b', stateful: 0, stateless: 1 },
      { taskId: 'c', stateful: 0, stateless: 1 },
      { taskId: 'd', stateful: 0, stateless: 1 },
    ], { seed: 4, iterations: 2000 });
    expect(g.gain).toBeCloseTo(-1, 10);
    expect(g.pValue).toBeCloseTo(2 / 16, 10);
    // Four differing pairs floor at p=0.125, above alpha, so the direction is
    // withheld: "the stateful arm did WORSE" on four pairs is the same
    // over-reading as calling a null a finding.
    expect(g.canReachSignificance).toBe(false);
    expect(g.verdict).toContain('UNDECIDABLE');
  });

  test('past the exact test\'s floor, the direction is stated', () => {
    const g = computeGain(
      Array.from({ length: 6 }, (_, i) => ({ taskId: `t${i}`, stateful: 0, stateless: 1 })),
      { seed: 4, iterations: 2000 },
    );
    expect(g.pairsWithDifference).toBe(6);
    expect(g.floorPValue).toBeCloseTo(2 / 64, 10);
    expect(g.canReachSignificance).toBe(true);
    expect(g.verdict).toContain('WORSE');
  });

  test('the design floor is 2^(1-k) in DIFFERING pairs, and k>=6 is exact', () => {
    // Three separate readers got this wrong in one evening, each by taking the
    // denominator to be total pairs. The sign test drops ties, so the only
    // denominator that exists is the number of pairs that DIFFERED: floor
    // two-sided p = 2^(1-k), which is 0.5 at k=2 and 0.0625 at k=5, and
    // 2^(1-k) <= 0.05 first holds at k=6. Total n bounds k and decides nothing.
    for (const k of [1, 2, 3, 4, 5, 6, 7, 10]) {
      expect(floorPValue(k)).toBeCloseTo(2 ** (1 - k), 12);
    }
    expect(minimumPairsForSignificance()).toBe(6);
    expect(floorPValue(5)).toBeGreaterThan(DEFAULT_ALPHA);
    expect(floorPValue(6)).toBeLessThanOrEqual(DEFAULT_ALPHA);

    // And computeGain divides by that set, not by the set it ran: twenty tasks
    // where only five differ still cannot decide.
    const g = computeGain([
      ...Array.from({ length: 5 }, (_, i) => ({ taskId: `d${i}`, stateful: 1, stateless: 0 })),
      ...Array.from({ length: 15 }, (_, i) => ({ taskId: `t${i}`, stateful: 1, stateless: 1 })),
    ], { seed: 4, iterations: 2000 });
    expect(g.tasks).toBe(20);
    expect(g.pairsWithDifference).toBe(5);
    expect(g.canReachSignificance).toBe(false);
    expect(g.verdict).toContain('UNDECIDABLE');
  });

  test('an unbounded reward scale gets no normalized gain', () => {
    // CL-Bench's poker rewards are signed chip counts. "Fraction of remaining
    // headroom" assumes rewards in [0,1]; on that scale it is not a quantity,
    // and the first real run would otherwise have reported -25% of headroom.
    const g = computeGain([
      { taskId: 'hand1', stateful: -1.0, stateless: -1.0 },
      { taskId: 'hand2', stateful: -0.5, stateless: 2.0 },
      { taskId: 'hand3', stateful: -1.0, stateless: -1.0 },
      { taskId: 'hand4', stateful: 3.0, stateless: 3.0 },
      { taskId: 'hand5', stateful: -0.5, stateless: -2.0 },
    ], { seed: 4, iterations: 2000 });
    expect(g.gain).toBeCloseTo(-0.2, 10);
    expect(g.normalizedGain).toBeNull();
    expect(g.pairsWithDifference).toBe(2);
    expect(g.verdict).toContain('UNDECIDABLE');
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
