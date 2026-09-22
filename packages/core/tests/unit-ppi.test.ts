/**
 * Prediction-powered inference against synthetic ground truth: populations with known
 * rate, sensitivity and specificity, sampled the way calibration.ts samples.
 */
import { describe, test, expect } from 'bun:test';
import { seededRandom, wilsonInterval } from '../src/utils/stats';
import {
  correctedRate, classifierAccuracy, designWeightedKappa, describeCalibrationGap,
  type ClassifierAccuracy, type PredictionStratum, type GoldStratum,
} from '../src/evolution/ppi';
import { allocateLabelBudget } from '../src/evolution/calibration';

interface SyntheticRow {
  truth: boolean;
  predicted: string;
}

interface WorldSpec {
  size: number;
  rate: number;
  sensitivity: number;
  specificity: number;
  seed: number;
  /** Splits event verdicts across two keys, like the real classifier. */
  splitEvent?: boolean;
}

/** The classifier's observed rate is wrong by construction. */
function buildWorld(spec: WorldSpec): SyntheticRow[] {
  const random = seededRandom(spec.seed);

  return Array.from({ length: spec.size }, () => {
    const truth = random() < spec.rate;
    const saysEvent = truth ? random() < spec.sensitivity : random() >= spec.specificity;
    const eventKey = spec.splitEvent && random() < 0.5 ? 'frustrated' : 'corrected';

    return { truth, predicted: saysEvent ? eventKey : 'accepted' };
  });
}

const EVENT_KEYS = new Set(['corrected', 'frustrated']);

/** calibration.ts's stratified draw, taken as a spread sample: a prefix draw over a
 *  ledger of two eras describes only the first, and no budget fixes that. */
function stratify(rows: ReadonlyArray<SyntheticRow>, budget: number): PredictionStratum[] {
  const byKey = new Map<string, SyntheticRow[]>();

  for (const row of rows) {
    const bucket = byKey.get(row.predicted) ?? [];
    bucket.push(row);
    byKey.set(row.predicted, bucket);
  }

  const keys = [...byKey.keys()];
  const quotas = allocateLabelBudget(keys.map((k) => byKey.get(k)?.length ?? 0), budget);

  return keys.map((key, i) => {
    const bucket = byKey.get(key) ?? [];
    const take = Math.min(quotas[i], bucket.length);
    const drawn = Array.from({ length: take }, (_, j) => bucket[Math.floor(((j + 0.5) * bucket.length) / take)]);

    return {
      key,
      predictedEvent: EVENT_KEYS.has(key),
      population: bucket.length,
      labeled: drawn.length,
      events: drawn.filter((r) => r.truth).length,
    };
  });
}

function trueRate(rows: ReadonlyArray<SyntheticRow>): number {
  return rows.filter((r) => r.truth).length / rows.length;
}

function observedRate(rows: ReadonlyArray<SyntheticRow>) {
  return { events: rows.filter((r) => EVENT_KEYS.has(r.predicted)).length, population: rows.length };
}

function requireAccuracy(strata: ReadonlyArray<PredictionStratum>): ClassifierAccuracy {
  const result = classifierAccuracy(strata);

  if (result.accuracy === null) throw new Error(`unexpected gap: ${result.gap.kind}`);

  return result.accuracy;
}

function requireRate(rows: ReadonlyArray<SyntheticRow>, accuracy: ClassifierAccuracy) {
  const result = correctedRate(observedRate(rows), accuracy);

  if (result.rate === null) throw new Error(`unexpected gap: ${result.gap.kind}`);

  return result.rate;
}

/** Calibrate on a gold draw from these rows, then correct the same rows. */
function calibrateAndCorrect(rows: ReadonlyArray<SyntheticRow>, budget: number) {
  return requireRate(rows, requireAccuracy(stratify(rows, budget)));
}

describe('the corrected rate recovers a known truth through a biased classifier', () => {
  test('a classifier that misses a third of the events is corrected back up', () => {
    // The classifier reports ≈ 0.157 against a true 0.2.
    const world = buildWorld({ size: 4000, rate: 0.2, sensitivity: 0.67, specificity: 0.97, seed: 7 });
    const rate = calibrateAndCorrect(world, 100);

    expect(rate.raw).toBeLessThan(0.18);
    expect(Math.abs(rate.corrected.mean - trueRate(world))).toBeLessThan(Math.abs(rate.raw - trueRate(world)));
    expect(rate.corrected.lo).toBeLessThan(trueRate(world));
    expect(rate.corrected.hi).toBeGreaterThan(trueRate(world));
    expect(rate.bias).toBeCloseTo(rate.corrected.mean - rate.raw, 12);
  });

  test('a classifier biased the other way is corrected back down', () => {
    // Over-calls events: 88% sensitivity but only 82% specificity.
    const world = buildWorld({ size: 4000, rate: 0.2, sensitivity: 0.88, specificity: 0.82, seed: 11 });
    const rate = calibrateAndCorrect(world, 100);

    expect(rate.raw).toBeGreaterThan(0.29);
    expect(Math.abs(rate.corrected.mean - trueRate(world))).toBeLessThan(Math.abs(rate.raw - trueRate(world)));
    expect(rate.bias).toBeLessThan(-0.05);
  });

  test('a perfect classifier is left exactly where it is', () => {
    const world = buildWorld({ size: 4000, rate: 0.25, sensitivity: 1, specificity: 1, seed: 3 });
    const rate = calibrateAndCorrect(world, 100);
    expect(rate.corrected.mean).toBeCloseTo(rate.raw, 10);
    expect(rate.bias).toBeCloseTo(0, 10);
  });

  test('three classifier verdicts, not two', () => {
    const world = buildWorld({ size: 4000, rate: 0.2, sensitivity: 0.7, specificity: 0.95, seed: 21, splitEvent: true });
    const strata = stratify(world, 120);
    expect(strata.map((s) => s.key).sort()).toEqual(['accepted', 'corrected', 'frustrated']);
    const rate = requireRate(world, requireAccuracy(strata));
    expect(rate.corrected.lo).toBeLessThan(trueRate(world));
    expect(rate.corrected.hi).toBeGreaterThan(trueRate(world));
  });
});

describe('the Rogan–Gladen form is the stratified PPI estimate', () => {
  test('over the population the labels were drawn from, the two agree exactly', () => {
    const world = buildWorld({ size: 3000, rate: 0.3, sensitivity: 0.75, specificity: 0.9, seed: 5 });
    const strata = stratify(world, 100);
    const accuracy = requireAccuracy(strata);

    // Σ_s w_s ȳ_s, computed directly.
    const population = strata.reduce((n, s) => n + s.population, 0);
    const stratified = strata.reduce((sum, s) => sum + (s.population / population) * (s.events / s.labeled), 0);

    expect(accuracy.prevalence).toBeCloseTo(stratified, 12);
    expect(requireRate(world, accuracy).corrected.mean).toBeCloseTo(stratified, 10);
  });
});

describe('classifierAccuracy', () => {
  test('brackets the sensitivity and specificity it was built with', () => {
    const world = buildWorld({ size: 6000, rate: 0.2, sensitivity: 0.7, specificity: 0.95, seed: 13 });
    const { sensitivity, specificity } = requireAccuracy(stratify(world, 200));

    expect(sensitivity.lo).toBeLessThan(0.7);
    expect(sensitivity.hi).toBeGreaterThan(0.7);
    expect(specificity.lo).toBeLessThan(0.95);
    expect(specificity.hi).toBeGreaterThan(0.95);
  });

  test('specificity is unbiased; sensitivity carries a small-sample ratio bias that decays', () => {
    // Sensitivity is a ratio estimate with O(1/n) upward bias; the corrected rate does not inherit it.
    const meanSensitivity = (budget: number): number => {
      const draws = Array.from({ length: 800 }, (_, i) =>
        requireAccuracy(stratify(
          buildWorld({ size: 2000, rate: 0.2, sensitivity: 0.7, specificity: 0.95, seed: 500 + i }),
          budget,
        )));

      return draws.reduce((sum, d) => sum + d.sensitivity.mean, 0) / draws.length;
    };

    const at100 = meanSensitivity(100);
    const at400 = meanSensitivity(400);

    expect(at100 - 0.7).toBeGreaterThan(0);
    expect(at100 - 0.7).toBeLessThan(0.03);
    expect(at400 - 0.7).toBeLessThan(at100 - 0.7);
    expect(at400).toBeCloseTo(0.7, 2);
  });

  test('specificity is unbiased at the budget this system uses', () => {
    const draws = Array.from({ length: 200 }, (_, i) =>
      requireAccuracy(stratify(
        buildWorld({ size: 2000, rate: 0.2, sensitivity: 0.7, specificity: 0.95, seed: 500 + i }),
        100,
      )));

    expect(draws.reduce((sum, d) => sum + d.specificity.mean, 0) / draws.length).toBeCloseTo(0.95, 2);
  });

  test('the design re-weighting is what makes it right — the naive tally is not', () => {
    // Equal quotas over-represent rare verdicts; a direct tally would report ≈0.9 for a true 0.7.
    const world = buildWorld({ size: 6000, rate: 0.2, sensitivity: 0.7, specificity: 0.95, seed: 13 });
    const strata = stratify(world, 200);

    const naiveSensitivity =
      strata.filter((s) => s.predictedEvent).reduce((n, s) => n + s.events, 0) /
      strata.reduce((n, s) => n + s.events, 0);

    const measured = requireAccuracy(strata).sensitivity;
    expect(naiveSensitivity).toBeGreaterThan(0.78);
    expect(naiveSensitivity).toBeGreaterThan(measured.hi);
    expect(measured.lo).toBeLessThan(0.7);
    expect(measured.hi).toBeGreaterThan(0.7);
  });

  test('sensitivity is uninformative when no draw was judged an event', () => {
    const { sensitivity, specificity } = requireAccuracy([
      { key: 'accepted', predictedEvent: false, population: 100, labeled: 20, events: 0 },
      { key: 'corrected', predictedEvent: true, population: 10, labeled: 10, events: 0 },
    ]);

    expect(sensitivity.mean).toBe(0);
    expect(sensitivity.lo).toBe(0);
    expect(sensitivity.hi).toBe(1);
    // Ten of 110 rows were called an event and none was: specificity 100/110.
    expect(specificity.mean).toBeCloseTo(100 / 110, 10);
  });
});

describe('the corrected interval', () => {
  test('is unbiased and covers the truth at its nominal 95%, where the raw rate does not', () => {
    let covered = 0;
    let rawCovered = 0;
    let estimateSum = 0;
    let truthSum = 0;
    const trials = 400;

    for (let seed = 1; seed <= trials; seed++) {
      const world = buildWorld({ size: 1500, rate: 0.2, sensitivity: 0.6, specificity: 0.98, seed });
      const truth = trueRate(world);
      const rate = calibrateAndCorrect(world, 100);
      estimateSum += rate.corrected.mean;
      truthSum += truth;

      if (rate.corrected.lo <= truth && truth <= rate.corrected.hi) covered++;
      // The uncorrected surface: classifier rate with a Wilson interval (as alignment.ts).
      const observed = observedRate(world);
      const raw = wilsonInterval(observed.events, observed.population);

      if (raw.lo <= truth && truth <= raw.hi) rawCovered++;
    }

    // Averaged over calibration sets, the correction lands on the truth.
    expect(estimateSum / trials).toBeCloseTo(truthSum / trials, 2);
    expect(covered / trials).toBeGreaterThan(0.93);
    expect(covered / trials).toBeLessThanOrEqual(1);
    // The uncorrected interval essentially never contains the answer.
    expect(rawCovered / trials).toBeLessThan(0.05);
  });

  test('holds its operating characteristics across the regimes this ledger can be in', () => {
    // The estimator's behaviour at the 100-label budget across classifier regimes.
    const regimes = [
      { rate: 0.2, sensitivity: 0.7, specificity: 0.95, splitEvent: true },
      { rate: 0.3, sensitivity: 0.75, specificity: 0.9, splitEvent: true },
      { rate: 0.1, sensitivity: 0.6, specificity: 0.98, splitEvent: true },
      { rate: 0.4, sensitivity: 0.8, specificity: 0.85, splitEvent: true },
    ];

    for (const regime of regimes) {
      let covered = 0;
      let biasSum = 0;
      const trials = 300;

      for (let seed = 1; seed <= trials; seed++) {
        const world = buildWorld({ size: 1500, ...regime, seed });
        const truth = trueRate(world);
        const rate = calibrateAndCorrect(world, 100);
        biasSum += rate.corrected.mean - truth;

        if (rate.corrected.lo <= truth && truth <= rate.corrected.hi) covered++;
      }

      const label = `rate=${regime.rate} sens=${regime.sensitivity} spec=${regime.specificity}`;
      expect(`${label} bias=${Math.abs(biasSum / trials) < 0.01}`).toBe(`${label} bias=true`);
      expect(`${label} cover=${covered / trials >= 0.95}`).toBe(`${label} cover=true`);
    }
  });

  test('never collapses to a point when the gold labels are unanimous', () => {
    const accuracy = requireAccuracy([
      { key: 'accepted', predictedEvent: false, population: 900, labeled: 25, events: 0 },
      { key: 'corrected', predictedEvent: true, population: 100, labeled: 25, events: 25 },
    ]);

    const rate = correctedRate({ events: 100, population: 1000 }, accuracy).rate;
    expect(accuracy.sensitivity.mean).toBe(1);
    expect(accuracy.specificity.mean).toBe(1);
    expect(rate?.corrected.mean).toBeCloseTo(0.1, 10);
    expect((rate?.corrected.hi ?? 0) - (rate?.corrected.lo ?? 0)).toBeGreaterThan(0.02);
  });

  test('more gold labels tighten it', () => {
    const world = buildWorld({ size: 4000, rate: 0.2, sensitivity: 0.7, specificity: 0.95, seed: 9 });

    const width = (budget: number): number => {
      const rate = calibrateAndCorrect(world, budget);

      return rate.corrected.hi - rate.corrected.lo;
    };

    expect(width(400)).toBeLessThan(width(100));
    expect(width(100)).toBeLessThan(width(30));
  });

  test('it is never narrower than the calibration set behind it', () => {
    // A thinner gold set must widen the interval.
    const world = buildWorld({ size: 4000, rate: 0.2, sensitivity: 0.7, specificity: 0.95, seed: 9 });
    const observed = observedRate(world);

    const width = (budget: number): number => {
      const rate = correctedRate(observed, requireAccuracy(stratify(world, budget))).rate;

      return (rate?.corrected.hi ?? 0) - (rate?.corrected.lo ?? 0);
    };

    expect(width(40)).toBeGreaterThan(width(400));
    expect(width(400)).toBeGreaterThan(wilsonInterval(observed.events, observed.population).hi -
      wilsonInterval(observed.events, observed.population).lo);
  });
});

describe('one calibration set corrects every slice', () => {
  test('slices with different true rates each recover their own', () => {
    // The newer version really trips the classifier less; calibration is drawn once over the pool.
    const older = buildWorld({ size: 2000, rate: 0.3, sensitivity: 0.7, specificity: 0.95, seed: 31 });
    const newer = buildWorld({ size: 2000, rate: 0.1, sensitivity: 0.7, specificity: 0.95, seed: 32 });
    const accuracy = requireAccuracy(stratify([...older, ...newer], 200));

    expect(requireRate(older, accuracy).corrected.mean).toBeCloseTo(trueRate(older), 1);
    expect(requireRate(newer, accuracy).corrected.mean).toBeCloseTo(trueRate(newer), 1);
    // The two remain distinguishable after correction.
    expect(requireRate(newer, accuracy).corrected.hi).toBeLessThan(requireRate(older, accuracy).corrected.lo);
  });

  test('re-weighting the pooled posteriors instead would report the pooled rate', () => {
    // The wrong approach: pooled ȳ_s barely moves off the pooled rate for a low-prevalence slice.
    const older = buildWorld({ size: 2000, rate: 0.3, sensitivity: 0.7, specificity: 0.95, seed: 31 });
    const newer = buildWorld({ size: 2000, rate: 0.1, sensitivity: 0.7, specificity: 0.95, seed: 32 });
    const pooled = stratify([...older, ...newer], 200);

    const sliceWeighted = pooled.reduce((sum, s) => {
      const inSlice = newer.filter((r) => r.predicted === s.key).length;

      return sum + (inSlice / newer.length) * (s.events / s.labeled);
    }, 0);

    expect(sliceWeighted).toBeGreaterThan(0.12);
    expect(requireRate(newer, requireAccuracy(pooled)).corrected.mean).toBeLessThan(0.13);
  });
});

describe('calibration gaps — no number rather than a wrong one', () => {
  const accuracy = requireAccuracy([
    { key: 'accepted', predictedEvent: false, population: 900, labeled: 30, events: 3 },
    { key: 'corrected', predictedEvent: true, population: 100, labeled: 30, events: 24 },
  ]);

  test('an empty population has nothing to correct', () => {
    expect(classifierAccuracy([]).gap?.kind).toBe('no_population');
    expect(correctedRate({ events: 0, population: 0 }, accuracy).gap?.kind).toBe('no_population');
  });

  test('no gold labels reads as uncalibrated', () => {
    const result = classifierAccuracy([
      { key: 'accepted', predictedEvent: false, population: 100, labeled: 0, events: 0 },
    ]);

    expect(result.accuracy).toBeNull();
    expect(result.gap && describeCalibrationGap(result.gap)).toBe('uncalibrated — no hand-labeled turns yet');
  });

  test('one unlabeled verdict blocks the profile and is named', () => {
    const result = classifierAccuracy([
      { key: 'accepted', predictedEvent: false, population: 900, labeled: 30, events: 2 },
      { key: 'frustrated', predictedEvent: true, population: 12, labeled: 0, events: 0 },
    ]);

    expect(result.accuracy).toBeNull();
    expect(result.gap?.strata).toEqual(['frustrated']);
    expect(result.gap && describeCalibrationGap(result.gap)).toContain('"frustrated"');
  });

  test('an empty stratum is not a gap — it carries no rows to be wrong about', () => {
    const result = classifierAccuracy([
      { key: 'accepted', predictedEvent: false, population: 900, labeled: 30, events: 2 },
      { key: 'corrected', predictedEvent: true, population: 100, labeled: 30, events: 24 },
      { key: 'frustrated', predictedEvent: true, population: 0, labeled: 0, events: 0 },
    ]);

    expect(result.gap).toBeNull();
  });

  test('a classifier no better than chance yields no corrected rate', () => {
    // Same event rate in both verdicts: sensitivity + specificity = 1 exactly.
    const chance = requireAccuracy([
      { key: 'accepted', predictedEvent: false, population: 800, labeled: 40, events: 8 },
      { key: 'corrected', predictedEvent: true, population: 200, labeled: 40, events: 8 },
    ]);

    expect(chance.sensitivity.mean + chance.specificity.mean).toBeCloseTo(1, 10);
    const result = correctedRate({ events: 200, population: 1000 }, chance);
    expect(result.rate).toBeNull();
    expect(result.gap && describeCalibrationGap(result.gap)).toContain('do not establish the classifier beats chance');
  });

  test('a corrected rate stays inside [0,1] when the observed rate is below chance', () => {
    const rate = correctedRate({ events: 5, population: 1000 }, accuracy).rate;
    expect(rate?.corrected.mean).toBe(0);
    expect(rate?.corrected.hi).toBeGreaterThan(0);
  });
});

describe('designWeightedKappa', () => {
  /** First rater is the stratum's classifier verdict, as the calibration report passes. */
  const gold = (key: string, population: number, actuals: string[]): GoldStratum =>
    ({ key, population, draws: actuals.map((b) => ({ a: key, b })) });

  test('perfect agreement is κ = 1', () => {
    const kappa = designWeightedKappa([
      gold('accepted', 800, Array<string>(20).fill('accepted')),
      gold('corrected', 200, Array<string>(20).fill('corrected')),
    ]);

    expect(kappa?.value).toBeCloseTo(1, 10);
    expect(kappa?.n).toBe(40);
  });

  test('a classifier that always guesses the majority verdict scores ~0', () => {
    const kappa = designWeightedKappa([
      gold('accepted', 1000, [...Array<string>(80).fill('accepted'), ...Array<string>(20).fill('corrected')]),
    ]);

    expect(kappa?.value).toBeCloseTo(0, 10);
  });

  test('partial agreement lands between, with an interval that contains it', () => {
    const kappa = designWeightedKappa([
      gold('accepted', 800, [...Array<string>(34).fill('accepted'), ...Array<string>(6).fill('corrected')]),
      gold('corrected', 200, [...Array<string>(28).fill('corrected'), ...Array<string>(12).fill('accepted')]),
    ]);

    expect(kappa?.value).toBeGreaterThan(0.3);
    expect(kappa?.value).toBeLessThan(0.8);
    expect(kappa?.lo).toBeLessThan(kappa?.value ?? 0);
    expect(kappa?.hi).toBeGreaterThan(kappa?.value ?? 1);
  });

  test('pins the hand-derived κ = 16/41 and reports nothing without labels', () => {
    const strata = [
      gold('accepted', 800, ['accepted', 'corrected', 'accepted', 'accepted']),
      gold('corrected', 200, ['corrected', 'accepted', 'corrected', 'corrected']),
    ];

    // Observed agreement is 0.75 against chance agreement 0.59, so κ = 16/41.
    const kappa = designWeightedKappa(strata);
    expect(kappa?.value).toBeCloseTo(16 / 41, 10);
    // Default bootstrap seed, so the interval is stable too.
    expect(designWeightedKappa(strata)).toEqual(kappa);
    expect(designWeightedKappa([gold('accepted', 800, [])])).toBeNull();
    expect(designWeightedKappa([])).toBeNull();
  });

  test('scores two raters who both vary, and is symmetric between them', () => {
    // Neither rater is the stratum verdict; κ is symmetric in the pair.
    const pairs = (spec: Array<[string, string, number]>): Array<{ a: string; b: string }> =>
      spec.flatMap(([a, b, n]) => Array<{ a: string; b: string }>(n).fill({ a, b }));

    const strata = [
      { key: 'accepted', population: 800, draws: pairs([['accepted', 'accepted', 30], ['corrected', 'accepted', 6], ['accepted', 'corrected', 4]]) },
      { key: 'corrected', population: 200, draws: pairs([['corrected', 'corrected', 30], ['accepted', 'corrected', 5], ['corrected', 'accepted', 5]]) },
    ];

    const forward = designWeightedKappa(strata);

    const swapped = designWeightedKappa(
      strata.map((s) => ({ ...s, draws: s.draws.map((d) => ({ a: d.b, b: d.a })) })),
    );

    expect(forward?.value).toBeCloseTo(swapped?.value ?? -1, 12);
    expect(forward?.value).toBeGreaterThan(0);
    expect(forward?.n).toBe(80);
  });

  test('weights a stratum by its population, not by how often it was drawn', () => {
    // Agreement in the rare stratum, disagreement in the common one: design weighting matters.
    const agree = Array<{ a: string; b: string }>(40).fill({ a: 'corrected', b: 'corrected' });

    const disagree = [
      ...Array<{ a: string; b: string }>(20).fill({ a: 'accepted', b: 'accepted' }),
      ...Array<{ a: string; b: string }>(20).fill({ a: 'accepted', b: 'corrected' }),
    ];

    const weighted = designWeightedKappa([
      { key: 'accepted', population: 900, draws: disagree },
      { key: 'corrected', population: 100, draws: agree },
    ]);

    const even = designWeightedKappa([
      { key: 'accepted', population: 500, draws: disagree },
      { key: 'corrected', population: 500, draws: agree },
    ]);

    expect(weighted?.value).toBeLessThan(even?.value ?? 0);
  });
});
