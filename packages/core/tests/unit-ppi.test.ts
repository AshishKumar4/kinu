/**
 * Prediction-powered inference, validated against synthetic ground truth.
 *
 * Every test here builds a population whose TRUE event rate and whose
 * classifier's TRUE sensitivity/specificity are known by construction, draws a
 * stratified gold sample from it exactly the way calibration.ts does, and then
 * asks whether the estimator gets the known answer back. That is the only
 * honest way to validate a bias correction: on real data there is nothing to
 * compare against, which is the whole reason the correction is needed.
 *
 * No LLM calls, no storage, no clock — pure arithmetic on seeded draws.
 */
import { describe, test, expect } from 'bun:test';
import { seededRandom, wilsonInterval } from '../src/utils/stats.js';
import {
  correctedRate, classifierAccuracy, designWeightedKappa, describeCalibrationGap,
  type ClassifierAccuracy, type PredictionStratum, type GoldStratum,
} from '../src/evolution/ppi.js';
import { allocateLabelBudget } from '../src/evolution/calibration.js';

// ── Synthetic world ──────────────────────────────────────────────

interface SyntheticRow {
  /** What the row really is. */
  truth: boolean;
  /** What the classifier said about it. */
  predicted: string;
}

interface WorldSpec {
  size: number;
  /** True event rate. */
  rate: number;
  /** P(classifier says event | it is one). */
  sensitivity: number;
  /** P(classifier says non-event | it is not one). */
  specificity: number;
  seed: number;
  /** When set, "event" verdicts split across two keys — the three-verdict
   *  shape the real classifier has. */
  splitEvent?: boolean;
}

/** A population of rows with a known truth and a known classifier error
 *  profile. The classifier's OBSERVED rate will be wrong by construction. */
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

/** The stratified gold draw calibration.ts performs, using its real budget
 *  allocation, taken as a SPREAD (systematic) sample of each stratum rather
 *  than a prefix.
 *
 *  The spread is not cosmetic. An early version of this helper took a prefix,
 *  which on a ledger built by concatenating two eras drew the whole gold set
 *  from the first one; the stratum means then described that era while the
 *  population weights described the whole ledger, and the mismatch showed up
 *  as a 6-point transport error that no budget could fix. Any draw that is not
 *  representative WITHIN a stratum breaks the estimator, and time order is
 *  exactly where a real ledger hides that. */
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

/** What the classifier reports about a slice — the input a corrected surface
 *  starts from. */
function observedRate(rows: ReadonlyArray<SyntheticRow>): { events: number; population: number } {
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

/** The whole pipeline: calibrate on a gold draw from these rows, then correct
 *  the same rows' observed rate. */
function calibrateAndCorrect(rows: ReadonlyArray<SyntheticRow>, budget: number) {
  return requireRate(rows, requireAccuracy(stratify(rows, budget)));
}

// ── Recovery ─────────────────────────────────────────────────────

describe('the corrected rate recovers a known truth through a biased classifier', () => {
  test('a classifier that misses a third of the events is corrected back up', () => {
    // 20% true event rate, 67% sensitivity, 97% specificity. The classifier
    // reports roughly 0.2·0.67 + 0.8·0.03 ≈ 0.157 — a 20% relative undercount
    // that no amount of extra turns would ever reveal.
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

    // Σ_s w_s ȳ_s — PPI's stratified rectifier form, computed directly.
    const population = strata.reduce((n, s) => n + s.population, 0);
    const stratified = strata.reduce((sum, s) => sum + (s.population / population) * (s.events / s.labeled), 0);

    expect(accuracy.prevalence).toBeCloseTo(stratified, 12);
    expect(requireRate(world, accuracy).corrected.mean).toBeCloseTo(stratified, 10);
  });
});

// ── The classifier's own error profile ───────────────────────────

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
    // Sensitivity is a RATIO of weighted sums (A/θ̂), so it inherits the usual
    // O(1/n) ratio bias — dominated by the majority stratum's variance times
    // the weight it carries. It is real, it is upward, and at the ~100 labels
    // this system budgets it is worth about +0.016. It is reported rather than
    // patched: the corrected RATE, which is what every surface consumes, does
    // not inherit it (see the coverage test below).
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
    // Equal quotas over-represent the rare "event" verdict several times over.
    // Tallying the gold sample directly reports a sensitivity near 0.9 for a
    // classifier whose real sensitivity is 0.7.
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

// ── Interval honesty ─────────────────────────────────────────────

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
      // What the UNCORRECTED surface reports today: the classifier's own rate
      // with a Wilson interval over the whole ledger (alignment.ts, verbatim).
      const observed = observedRate(world);
      const raw = wilsonInterval(observed.events, observed.population);
      if (raw.lo <= truth && truth <= raw.hi) rawCovered++;
    }
    // The headline claim: averaged over calibration sets, the correction lands
    // on the truth. This is what every surface downstream depends on.
    expect(estimateSum / trials).toBeCloseTo(truthSum / trials, 2);
    expect(covered / trials).toBeGreaterThan(0.93);
    expect(covered / trials).toBeLessThanOrEqual(1);
    // The uncorrected surface is confidently wrong: a tight interval that
    // essentially never contains the answer.
    expect(rawCovered / trials).toBeLessThan(0.05);
  });

  test('holds its operating characteristics across the regimes this ledger can be in', () => {
    // The published behaviour of the estimator at the 100-label budget: what a
    // reader of a corrected K_align is entitled to assume. Each row is a
    // different classifier and a different true rate; all use the real
    // allocation and the real draw.
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
    // Same ledger, same observed rate, a thinner gold set: the interval must
    // widen. A correction cannot manufacture precision it did not buy.
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

// ── Transporting one calibration set across slices ───────────────

describe('one calibration set corrects every slice', () => {
  test('slices with different true rates each recover their own', () => {
    // Two scaffold versions: the newer one genuinely trips the classifier less
    // often. The calibration set is drawn once, over the pooled ledger.
    const older = buildWorld({ size: 2000, rate: 0.3, sensitivity: 0.7, specificity: 0.95, seed: 31 });
    const newer = buildWorld({ size: 2000, rate: 0.1, sensitivity: 0.7, specificity: 0.95, seed: 32 });
    const accuracy = requireAccuracy(stratify([...older, ...newer], 200));

    expect(requireRate(older, accuracy).corrected.mean).toBeCloseTo(trueRate(older), 1);
    expect(requireRate(newer, accuracy).corrected.mean).toBeCloseTo(trueRate(newer), 1);
    // And the two remain distinguishable after correction.
    expect(requireRate(newer, accuracy).corrected.hi).toBeLessThan(requireRate(older, accuracy).corrected.lo);
  });

  test('re-weighting the pooled posteriors instead would report the pooled rate', () => {
    // The wrong version of this, kept as a test because it is the mistake the
    // module note warns about: Σ_s w_s ȳ_s with POOLED ȳ_s barely moves off the
    // pooled rate when a slice's true prevalence is a third of it.
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

// ── Honest nulls ─────────────────────────────────────────────────

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
    // Gold labels find the same event rate in both verdicts: the verdict tells
    // you nothing, so sensitivity + specificity = 1 exactly.
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

// ── Agreement ────────────────────────────────────────────────────

describe('designWeightedKappa', () => {
  /** A stratum whose first rater is the classifier verdict the stratum is
   *  named for — the shape the calibration report passes in. */
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

  test('is reproducible from its seed and reports nothing without labels', () => {
    const strata = [
      gold('accepted', 800, ['accepted', 'corrected', 'accepted', 'accepted']),
      gold('corrected', 200, ['corrected', 'accepted', 'corrected', 'corrected']),
    ];
    expect(designWeightedKappa(strata)).toEqual(designWeightedKappa(strata));
    expect(designWeightedKappa([gold('accepted', 800, [])])).toBeNull();
    expect(designWeightedKappa([])).toBeNull();
  });

  test('scores two raters who both vary, and is symmetric between them', () => {
    // Neither rater is the stratum's own verdict here — the ensemble-vs-labeler
    // comparison. κ is a property of the pair, so swapping them cannot move it.
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
    // Same 40 draws per stratum; the raters agree in the rare one and disagree
    // in the common one. A tally that ignored the design would call this good.
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
