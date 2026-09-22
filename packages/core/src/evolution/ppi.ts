/**
 * Prediction-powered inference: bias-corrected versions of classifier-reported
 * rates from a small gold-label sample (Angelopoulos, Bates, Fannjiang, Jordan &
 * Zrnic, "Prediction-powered inference", Science 382:669, 2023). The estimate is
 * consistent whatever the classifier's error; the classifier only sets the width.
 *
 * The gold sample is stratified on the prediction (calibration.ts), so strata enter
 * at population share w_s = N_s/N and PPI reduces to Σ_s w_s · ȳ_s (Cochran,
 * *Sampling Techniques* 3e, §5.3). The ȳ_s are posteriors and move with prevalence,
 * so they do not transport across slices. What transports is sensitivity and
 * specificity, estimated once globally; each slice is then corrected by Rogan–Gladen
 * (Rogan & Gladen, Am. J. Epidemiol. 107:71, 1978), with delta-method variance over
 * all three inputs.
 *
 * Proportion variances use the Agresti–Coull adjusted form (Agresti & Coull, Am.
 * Stat. 52:119, 1998); point estimates stay raw. The raw variance is zero whenever a
 * stratum's labels are unanimous, which would report a zero-width interval.
 */

import { seededRandom, Z_95, type ScoreInterval } from '../utils/stats';

/** The standard error is kept because recovering it from an interval clipped
 *  to [0,1] would understate it. */
export interface MeasuredProportion extends ScoreInterval {
  se: number;
}

export interface PredictionStratum {
  key: string;
  predictedEvent: boolean;
  population: number;
  labeled: number;
  /** Of those draws, how many the labeler judged to be the event (k_s). */
  events: number;
}

/** Why a corrected number cannot be produced; never worked around with a default. */
export interface CalibrationGap {
  kind:
    | 'no_population'
    | 'no_labels'
    /** Some verdict the classifier used has no gold label behind it. */
    | 'unlabeled_strata'
    /** The labels do not establish q̂₁ + q̂₀ > 1, so the correction's denominator
     *  is indistinguishable from zero. */
    | 'uninformative_classifier';
  strata: string[];
}

export function describeCalibrationGap(gap: CalibrationGap): string {
  switch (gap.kind) {
    case 'no_population':
      return 'no classifier-graded turns in this slice — there is no rate to correct';
    case 'no_labels':
      return 'uncalibrated — no hand-labeled turns yet';
    case 'unlabeled_strata':
      return 'uncalibrated — no hand-labeled turn the classifier called ' +
        `${gap.strata.map((s) => `"${s}"`).join(' or ')}, so those rows cannot be corrected`;
    case 'uninformative_classifier':
      return 'the labels do not establish the classifier beats chance (sensitivity + specificity is not ' +
        'measurably above 1) — nothing it reports can be corrected into a rate';
  }
}

function proportionVariance(events: number, n: number): number {
  const z2 = Z_95 * Z_95;
  const denominator = n + z2;
  const adjusted = (events + z2 / 2) / denominator;

  return (adjusted * (1 - adjusted)) / denominator;
}

function measured(value: number, se: number, n: number): MeasuredProportion {
  const halfWidth = Z_95 * se;

  return { mean: value, lo: Math.max(0, value - halfWidth), hi: Math.min(1, value + halfWidth), se, n };
}

/** Prevalence-free, so it transports to every slice. */
export interface ClassifierAccuracy {
  /** q̂₁ — P(classifier says event | it really is one). */
  sensitivity: MeasuredProportion;
  /** q̂₀ — P(classifier says non-event | it really is not one). */
  specificity: MeasuredProportion;
  /** The stratified PPI estimate Σ_s w_s ȳ_s over the labeled population. */
  prevalence: number;
}

export type ClassifierAccuracyResult =
  | { accuracy: ClassifierAccuracy; gap: null }
  | { accuracy: null; gap: CalibrationGap };

/**
 * Sensitivity and specificity under the stratified design: each confusion cell is
 * re-weighted to its population share, since the sample over-draws rare verdicts.
 * Delta-method SEs treat stratum means as independent and condition on the observed
 * verdict mix. No estimated events reports the uninformative [0,1] interval.
 */
export function classifierAccuracy(strata: ReadonlyArray<PredictionStratum>): ClassifierAccuracyResult {
  const populated = strata.filter((s) => s.population > 0);

  if (populated.reduce((n, s) => n + s.population, 0) === 0) {
    return { accuracy: null, gap: { kind: 'no_population', strata: [] } };
  }

  if (populated.every((s) => s.labeled === 0)) {
    return { accuracy: null, gap: { kind: 'no_labels', strata: [] } };
  }

  const unlabeled = populated.filter((s) => s.labeled === 0).map((s) => s.key);

  if (unlabeled.length > 0) {
    return { accuracy: null, gap: { kind: 'unlabeled_strata', strata: unlabeled } };
  }

  const population = populated.reduce((n, s) => n + s.population, 0);
  const weight = (s: PredictionStratum): number => s.population / population;
  const goldMean = (s: PredictionStratum): number => s.events / s.labeled;

  const over = (want: boolean, pick: (s: PredictionStratum) => number): number =>
    populated.reduce((sum, s) => sum + (s.predictedEvent === want ? pick(s) : 0), 0);

  const a = over(true, (s) => weight(s) * goldMean(s));
  const c = over(false, (s) => weight(s) * (1 - goldMean(s)));
  const prevalence = a + over(false, (s) => weight(s) * goldMean(s));

  const noise = (want: boolean): number =>
    over(want, (s) => weight(s) ** 2 * proportionVariance(s.events, s.labeled));

  const labels = populated.reduce((n, s) => n + s.labeled, 0);

  const ratio = (numerator: number, scale: number, ownNoise: number, otherNoise: number): MeasuredProportion => {
    if (scale <= 0) return { mean: 0, lo: 0, hi: 1, se: Number.POSITIVE_INFINITY, n: 0 };
    const value = numerator / scale;

    return measured(value, Math.sqrt((1 - value) ** 2 * ownNoise + value ** 2 * otherNoise) / scale, labels);
  };

  return {
    accuracy: {
      sensitivity: ratio(a, prevalence, noise(true), noise(false)),
      specificity: ratio(c, 1 - prevalence, noise(false), noise(true)),
      prevalence,
    },
    gap: null,
  };
}

/** Gold draws for a rater the sample was not stratified on: each draw carries
 *  that rater's verdict and the labeler's. */
export interface AccuracyStratum {
  key: string;
  population: number;
  draws: ReadonlyArray<{ predictedEvent: boolean; event: boolean }>;
}

/**
 * Splits each sampling stratum on the rater's verdict, with N̂ = N_s · m/n_s.
 * The point estimate telescopes correctly; the closed-form interval does not, since
 * the halves are neither independent nor fixed-size, so the caller bootstraps.
 */
function splitOnPrediction(strata: ReadonlyArray<AccuracyStratum>): PredictionStratum[] {
  return strata.flatMap((stratum) => {
    if (stratum.draws.length === 0) {
      return [{ key: stratum.key, predictedEvent: false, population: stratum.population, labeled: 0, events: 0 }];
    }

    return [true, false].flatMap((predictedEvent) => {
      const cell = stratum.draws.filter((draw) => draw.predictedEvent === predictedEvent);

      return cell.length === 0 ? [] : [{
        key: `${stratum.key}/${predictedEvent ? 'flagged' : 'clear'}`,
        predictedEvent,
        population: (stratum.population * cell.length) / stratum.draws.length,
        labeled: cell.length,
        events: cell.filter((draw) => draw.event).length,
      }];
    });
  });
}

/** Fixed so a report is reproducible. */
const ACCURACY_RESAMPLES = 2000;

/**
 * Error profile of a rater the gold sample was not stratified on (ensemble.ts).
 * Point estimate from `classifierAccuracy` on the split draws; interval from the
 * stratified percentile bootstrap, which needs no independence between a
 * stratum's halves. Under-covers for a true rate within ~0.01 of a boundary.
 */
export function resampledAccuracy(
  strata: ReadonlyArray<AccuracyStratum>,
  opts: { seed?: number; iterations?: number } = {},
): ClassifierAccuracyResult {
  const point = classifierAccuracy(splitOnPrediction(strata));

  if (point.accuracy === null) return point;

  const random = seededRandom(opts.seed ?? 1);
  const sensitivities: number[] = [];
  const specificities: number[] = [];

  for (let i = 0; i < (opts.iterations ?? ACCURACY_RESAMPLES); i++) {
    const draw = classifierAccuracy(splitOnPrediction(strata.map((stratum) => ({
      ...stratum,
      draws: stratum.draws.map(() => stratum.draws[Math.floor(random() * stratum.draws.length)]),
    }))));

    if (draw.accuracy === null) continue;
    sensitivities.push(draw.accuracy.sensitivity.mean);
    specificities.push(draw.accuracy.specificity.mean);
  }

  const n = strata.reduce((count, stratum) => count + stratum.draws.length, 0);

  return {
    accuracy: {
      sensitivity: resampled(point.accuracy.sensitivity, sensitivities, n),
      specificity: resampled(point.accuracy.specificity, specificities, n),
      prevalence: point.accuracy.prevalence,
    },
    gap: null,
  };
}

/**
 * Bootstrap interval, never narrower than the closed form's. At a boundary every
 * resample can report exactly 1, which would claim certainty from a few draws.
 */
function resampled(closed: MeasuredProportion, samples: number[], n: number): MeasuredProportion {
  if (samples.length === 0) return { mean: closed.mean, lo: 0, hi: 1, se: Number.POSITIVE_INFINITY, n };
  const sorted = [...samples].sort((a, b) => a - b);

  const pick = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];

  const mean = sorted.reduce((sum, s) => sum + s, 0) / sorted.length;
  const spread = Math.sqrt(sorted.reduce((sum, s) => sum + (s - mean) ** 2, 0) / sorted.length);

  return {
    mean: closed.mean,
    lo: Math.min(pick(0.025), closed.lo),
    hi: Math.max(pick(0.975), closed.hi),
    se: Math.max(spread, closed.se),
    n,
  };
}

export interface CorrectedRate {
  /** θ̂ and its 95% interval; `n` is the gold labels behind the correction. */
  corrected: MeasuredProportion;
  raw: number;
  /** θ̂ − raw: the bias the labels measured. */
  bias: number;
  population: number;
}

export type CorrectedRateResult =
  | { rate: CorrectedRate; gap: null }
  | { rate: null; gap: CalibrationGap };

/**
 * Rogan–Gladen correction of one slice's observed classifier-event count using the
 * global error profile. θ̂ is clipped to [0,1] for both the point and the variance,
 * so a clipped estimate keeps its full width. Requires q̂₁ + q̂₀ − 1 above zero by
 * its own 95% uncertainty. Slices sharing a calibration set are correlated.
 */
export function correctedRate(
  observed: { events: number; population: number },
  accuracy: ClassifierAccuracy,
): CorrectedRateResult {
  if (observed.population <= 0) return { rate: null, gap: { kind: 'no_population', strata: [] } };
  const q1 = accuracy.sensitivity.mean;
  const q0 = accuracy.specificity.mean;
  const denominator = q1 + q0 - 1;
  const denominatorSe = Math.sqrt(accuracy.sensitivity.se ** 2 + accuracy.specificity.se ** 2);

  if (!(denominator > Z_95 * denominatorSe)) {
    return { rate: null, gap: { kind: 'uninformative_classifier', strata: [] } };
  }

  const raw = observed.events / observed.population;
  const estimate = Math.min(1, Math.max(0, (raw + q0 - 1) / denominator));

  const variance = (
    proportionVariance(observed.events, observed.population) +
    estimate ** 2 * accuracy.sensitivity.se ** 2 +
    (1 - estimate) ** 2 * accuracy.specificity.se ** 2
  ) / denominator ** 2;

  return {
    rate: {
      corrected: measured(estimate, Math.sqrt(variance), accuracy.sensitivity.n),
      raw,
      bias: estimate - raw,
      population: observed.population,
    },
    gap: null,
  };
}

/** Raw verdict pairs, so the full multi-class confusion can be rebuilt. `key` is
 *  the sampling stratum: it carries the population weight and is the unit the
 *  bootstrap resamples within. Both raters may vary per draw. */
export interface GoldStratum {
  key: string;
  population: number;
  /** One entry per gold draw: what each of the two raters said about it. */
  draws: ReadonlyArray<{ a: string; b: string }>;
}

export interface KappaEstimate {
  value: number;
  lo: number;
  hi: number;
  n: number;
}

/** Fixed so a report is reproducible. */
const KAPPA_RESAMPLES = 4000;

function kappaPoint(strata: ReadonlyArray<GoldStratum>, population: number): number | null {
  const byA = new Map<string, number>();
  const byB = new Map<string, number>();
  let observed = 0;

  for (const stratum of strata) {
    const share = stratum.population / population / stratum.draws.length;

    for (const draw of stratum.draws) {
      byA.set(draw.a, (byA.get(draw.a) ?? 0) + share);
      byB.set(draw.b, (byB.get(draw.b) ?? 0) + share);

      if (draw.a === draw.b) observed += share;
    }
  }

  let expected = 0;

  for (const [label, share] of byA) expected += share * (byB.get(label) ?? 0);

  return expected >= 1 ? null : (observed - expected) / (1 - expected);
}

/**
 * Cohen's κ over the design-weighted confusion matrix; raw agreement is flattered by
 * a skewed ledger. The interval is a stratified percentile bootstrap over whole draws,
 * since κ's asymptotic variance (Fleiss, Cohen & Everitt, Psychol. Bull. 72:323, 1969)
 * assumes multinomial cell counts. Null with no gold labels or when chance agreement is 1.
 */
export function designWeightedKappa(
  strata: ReadonlyArray<GoldStratum>,
  opts: { seed?: number; iterations?: number } = {},
): KappaEstimate | null {
  const drawn = strata.filter((s) => s.population > 0 && s.draws.length > 0);
  const population = drawn.reduce((n, s) => n + s.population, 0);

  if (population === 0) return null;
  const value = kappaPoint(drawn, population);

  if (value === null) return null;

  const iterations = opts.iterations ?? KAPPA_RESAMPLES;
  const random = seededRandom(opts.seed ?? 1);
  const samples: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const resampledStrata = drawn.map((s) => ({
      ...s,
      draws: s.draws.map(() => s.draws[Math.floor(random() * s.draws.length)]),
    }));

    const draw = kappaPoint(resampledStrata, population);

    if (draw !== null) samples.push(draw);
  }

  samples.sort((a, b) => a - b);

  const pick = (q: number): number =>
    samples[Math.min(samples.length - 1, Math.max(0, Math.round(q * (samples.length - 1))))];

  const n = drawn.reduce((count, s) => count + s.draws.length, 0);

  return samples.length === 0 ? { value, lo: value, hi: value, n } : { value, lo: pick(0.025), hi: pick(0.975), n };
}
