/**
 * Prediction-powered inference — turning a handful of hand labels into
 * bias-corrected versions of the rates a classifier reports about a whole
 * ledger.
 *
 * The problem: every rate this system surfaces about itself (K_align, the
 * per-scaffold outcome rates, the GEPA split's balance) counts a CLASSIFIER's
 * verdicts, not what actually happened. If that classifier misses a third of
 * the corrections, every one of those rates is off by an unknown amount in an
 * unknown direction, and no amount of extra turns fixes it — more data just
 * tightens the interval around the wrong number.
 *
 * The fix is a small set of GOLD labels: turns a human judged directly. PPI
 * (Angelopoulos, Bates, Fannjiang, Jordan & Zrnic, "Prediction-powered
 * inference", Science 382:669, 2023) combines the cheap classifier labels over
 * all N rows with expensive gold labels over n ≪ N of them:
 *
 *     θ̂_PP = (1/N) Σ_{i=1..N} f(X_i)  +  (1/n) Σ_{j=1..n} (Y_j − f(X_j))
 *              ─────── classifier ───────    ──────── rectifier ────────
 *
 * The rectifier is what buys unbiasedness: whatever f gets wrong on average,
 * the gold sample measures and subtracts. The estimate is consistent for the
 * true rate NO MATTER how bad f is; f only decides how tight the interval gets.
 *
 * Two things about this ledger shape the implementation.
 *
 *  1. The gold sample is STRATIFIED ON THE PREDICTION (see calibration.ts — a
 *     uniform draw would spend the whole budget on the majority verdict and
 *     measure nothing about the rare ones that matter most). A stratified
 *     sample needs an inverse-propensity-weighted rectifier: every stratum
 *     enters at its POPULATION share w_s = N_s/N, not its share of the labels.
 *     Since strata are defined BY the prediction, f is constant inside each one
 *     and the two halves telescope to the classical stratified estimator
 *     (Cochran, *Sampling Techniques* 3e, §5.3):
 *
 *         θ̂_PP = Σ_s w_s · ȳ_s
 *
 *  2. That form is only valid for the population the labels were drawn from.
 *     Its ingredients ȳ_s are posteriors — P(true event | classifier said s) —
 *     and posteriors move with prevalence. A scaffold version that genuinely
 *     corrects less often has different ȳ_s than the pooled ledger, so
 *     re-weighting the pooled ȳ_s by that version's verdict mix reports the
 *     POOLED rate back with extra steps. (`unit-ppi.test.ts` pins this: it was
 *     found by a failing transport test, not by reasoning.)
 *
 * So the estimate is factored the way epidemiology factors it. What transports
 * across slices is the classifier's error profile — sensitivity q̂₁ and
 * specificity q̂₀, which are conditional on the TRUTH and so are free of
 * prevalence. Those are estimated once, globally, from the stratified gold
 * sample (`classifierAccuracy`, which does the population re-weighting a naive
 * tally over an over-sampled gold set would get badly wrong). Each slice is
 * then corrected from its own observed rate p̂ by the Rogan–Gladen estimator
 * (Rogan & Gladen, Am. J. Epidemiol. 107:71, 1978):
 *
 *         θ̂ = (p̂ + q̂₀ − 1) / (q̂₁ + q̂₀ − 1)
 *
 * Applied to the whole ledger this is algebraically identical to Σ_s w_s ȳ_s —
 * the same PPI estimate, written so it also transports. `unit-ppi.test.ts`
 * asserts that identity rather than asserting it in prose.
 *
 * Uncertainty is propagated by the delta method over all three inputs, so a
 * corrected rate is never narrower than the calibration set that produced it:
 *
 *         Var(θ̂) = [ Var(p̂) + θ̂² Var(q̂₁) + (1 − θ̂)² Var(q̂₀) ] / (q̂₁ + q̂₀ − 1)²
 *
 * Every proportion's variance uses the Agresti–Coull adjusted form (Agresti &
 * Coull, Am. Stat. 52:119, 1998), p̃(1−p̃)/(n + z²) with p̃ = (k + z²/2)/(n + z²),
 * rather than the raw p̂(1−p̂)/n. Only the VARIANCE is adjusted — point
 * estimates stay unbiased — because the raw form collapses to exactly zero
 * whenever a stratum's labels are unanimous, which at n_s ≈ 25 is common and
 * would report a zero-width interval around a number resting on 25
 * observations. That is the same false precision utils/stats.ts exists to
 * prevent.
 *
 * MEASURED behaviour at the ~100-label budget this system uses, over 1,000
 * simulated calibration sets per regime (`unit-ppi.test.ts` pins it):
 *
 *   - the corrected rate is unbiased (|bias| ≤ 0.003) and its 95% interval
 *     covers the truth 98–99% of the time — conservative, which is the safe
 *     direction — where the uncorrected rate's interval covers it <5%;
 *   - specificity is unbiased; sensitivity, being a ratio estimate, runs about
 *     +0.016 high, decaying as O(1/n) to ~0 by 400 labels. It is reported, not
 *     patched: the corrected rate does not inherit it;
 *   - the sensitivity/specificity intervals themselves cover at 94% and 93%
 *     against a nominal 95% — slightly optimistic, because the delta method
 *     conditions on the observed verdict mix. Read them as diagnostics.
 *
 * Nothing here is outcome-specific; the vocabulary of turn outcomes lives in
 * calibration.ts. This module knows only "strata, populations, gold draws".
 */

import { seededRandom, Z_95, type ScoreInterval } from '../utils/stats';

/** A proportion with its interval AND its standard error. The error is kept
 *  because corrections downstream propagate it, and recovering it from an
 *  interval clipped to [0,1] would understate it. */
export interface MeasuredProportion extends ScoreInterval {
  se: number;
}

/** One prediction stratum: what the classifier said, how many ledger rows it
 *  said it about, and what the gold draws from those rows turned out to be. */
export interface PredictionStratum {
  /** The classifier's verdict — this stratum's identity. */
  key: string;
  /** True when this verdict counts as the event whose rate is being corrected. */
  predictedEvent: boolean;
  /** Ledger rows the classifier assigned here (N_s). */
  population: number;
  /** Gold-labeled draws from this stratum (n_s). */
  labeled: number;
  /** Of those draws, how many the labeler judged to BE the event (k_s). */
  events: number;
}

/** Why a corrected number cannot be produced. Reported instead of a number;
 *  never worked around with a default. */
export interface CalibrationGap {
  kind:
    /** Nothing to correct — the slice is empty. */
    | 'no_population'
    /** No gold labels exist at all. */
    | 'no_labels'
    /** Some verdict the classifier used has no gold label behind it, so what
     *  those rows really are is unknown and no weighting can invent it. */
    | 'unlabeled_strata'
    /** The labels do not establish q̂₁ + q̂₀ > 1: as far as they can tell, the
     *  classifier's verdicts carry no information about the truth. Dividing by
     *  a denominator indistinguishable from zero turns that into an
     *  arbitrarily large "correction" instead of an admission. */
    | 'uninformative_classifier';
  /** The verdicts missing gold labels, for 'unlabeled_strata'. */
  strata: string[];
}

/** One honest sentence per gap. */
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

/** Agresti–Coull variance of a proportion — see the module note on why the raw
 *  p̂(1−p̂)/n is not used. */
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

// ── The classifier's error profile (estimated once, globally) ────

/** How the classifier performs against the gold labels, on the binary event
 *  the strata's `predictedEvent` flag defines. Prevalence-free: this is the
 *  part that transports to every slice. */
export interface ClassifierAccuracy {
  /** q̂₁ — P(classifier says event | it really is one). */
  sensitivity: MeasuredProportion;
  /** q̂₀ — P(classifier says non-event | it really is not one). */
  specificity: MeasuredProportion;
  /** The corrected event rate over the population the labels were drawn from —
   *  the stratified PPI estimate Σ_s w_s ȳ_s, which is what identifies the
   *  ratios below. Carried because it is also the ledger-wide answer. */
  prevalence: number;
}

export type ClassifierAccuracyResult =
  | { accuracy: ClassifierAccuracy; gap: null }
  | { accuracy: null; gap: CalibrationGap };

/**
 * Sensitivity and specificity under the stratified design.
 *
 * These are NOT the naive tallies over the gold sample. The sample deliberately
 * over-draws the rare verdicts, so the gold set's own confusion matrix is a
 * distorted picture of the ledger's; every cell has to be re-weighted back to
 * its population share first:
 *
 *     A = P(f = event ∧ Y = event)     = Σ_{s: predictedEvent} w_s ȳ_s
 *     B = P(f ≠ event ∧ Y = event)     = Σ_{s: ¬predictedEvent} w_s ȳ_s
 *     C = P(f ≠ event ∧ Y ≠ event)     = Σ_{s: ¬predictedEvent} w_s (1 − ȳ_s)
 *     D = P(f = event ∧ Y ≠ event)     = Σ_{s: predictedEvent} w_s (1 − ȳ_s)
 *     q̂₁ = A/(A+B) = A/θ̂        q̂₀ = C/(C+D) = C/(1−θ̂)
 *
 * Standard errors come from the delta method on those ratios, treating the
 * stratum means as independent (they are — disjoint samples) and conditioning
 * on the observed verdict mix, since a test characteristic is a property of
 * the classifier rather than of how often the ledger happened to trip it:
 *
 *     Var(q̂₁) = [ (1−q̂₁)² Σ_{event} w_s² v_s + q̂₁² Σ_{¬event} w_s² v_s ] / θ̂²
 *     Var(q̂₀) = [ (1−q̂₀)² Σ_{¬event} w_s² v_s + q̂₀² Σ_{event} w_s² v_s ] / (1−θ̂)²
 *
 * A gold sample in which nothing is estimated to be an event can say nothing
 * about sensitivity; that case reports the uninformative [0,1] interval — the
 * same "no observations, no claim" answer utils/stats.ts gives.
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

// ── The same profile for a rater whose verdict varies within a stratum ──

/** One sampling stratum's gold draws, for a rater the sample was NOT stratified
 *  on. Each draw carries what that rater said about the turn and what the
 *  labeler found it to be. */
export interface AccuracyStratum {
  /** The stratum the draws were sampled from — the classifier's verdict. */
  key: string;
  /** Ledger rows in this stratum. */
  population: number;
  draws: ReadonlyArray<{ predictedEvent: boolean; event: boolean }>;
}

/**
 * Re-express draws as prediction strata by splitting each sampling stratum on
 * what the rater said, and giving each half its share of the stratum's
 * population: N̂ = N_s · m/n_s.
 *
 * This is exactly what makes the POINT estimate right — Σ w_cell ȳ_cell
 * telescopes back to Σ_s w_s (rater-flagged ∧ event)_s / n_s. It is also
 * exactly what makes the closed-form interval wrong, which is why the caller
 * below throws that interval away and bootstraps instead: the two halves of a
 * stratum are neither independent of each other nor of fixed size, and
 * `classifierAccuracy`'s delta method assumes both.
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

/** Resamples for a resampled profile. Fixed so a report is reproducible. */
const ACCURACY_RESAMPLES = 2000;

/**
 * The error profile of a rater the gold sample was not stratified on — an LLM
 * panel judging turns that were drawn by the classifier's verdict
 * (evolution/ensemble.ts).
 *
 * The point estimate is `classifierAccuracy`'s, unchanged and unforked: the
 * draws are split on the rater's own verdict and handed to it, and the design
 * weighting telescopes to the right answer (see `splitOnPrediction`).
 *
 * The INTERVAL is the stratified percentile bootstrap `designWeightedKappa`
 * uses, for the same reason it does: resampling whole draws inside the stratum
 * that produced them is the design's own randomness, and it needs no
 * independence assumption between a stratum's two halves nor a fixed split
 * between them. `classifierAccuracy`'s closed form needs both — its delta
 * method is derived for strata that are disjoint samples, which post-split
 * halves are not.
 *
 * MEASURED, over 250 simulated calibration sets per regime at the ~100-label
 * budget, on a 3,000-row ledger with 15% negatives (`unit-ensemble.test.ts`
 * pins the ordering, not the decimals):
 *
 *   - the point estimate is unbiased to ≤0.01 in every regime, which is the
 *     part `classifierAccuracy` is doing and the reason it is reused;
 *   - the interval covers at 85–98% against a nominal 95% in the regimes that
 *     matter — a rater whose true rates are 0.6–0.9 — where the closed form
 *     applied to the same split covers at 44–75%;
 *   - it stays under-covering (66%) only for a rater whose true rate is within
 *     ~0.01 of a boundary, where the estimate is discrete and no interval from
 *     ~30 draws resolves it. No method here pretends otherwise, and it does not
 *     move the decision those numbers feed: see the bar in
 *     evolution/ensemble.ts, whose false-pass rate is measured at 0%.
 *
 * Percentile rather than basic/pivotal or normal-on-bootstrap-SE: all three
 * were measured over the same regimes and percentile covered best in every one
 * (basic ran 4–14 points worse, normal 1–3).
 *
 * `se` comes back as the bootstrap distribution's own spread — or the closed
 * form's, whichever is larger, for the boundary reason `resampled` explains —
 * so everything downstream that propagates it (`correctedRate`) propagates the
 * same uncertainty the interval shows.
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
 * A point estimate wearing its bootstrap distribution's interval — but never
 * narrower than the closed form's, in either direction.
 *
 * The floor matters at the boundary. A rater that flagged nothing it should not
 * have makes every resample report specificity exactly 1, so the percentile
 * interval is [1, 1]: a claim of certainty resting on forty draws. That is the
 * same false precision the Agresti–Coull adjustment exists to prevent
 * everywhere else in this module, and the closed form still carries it, so the
 * wider of the two bounds is taken. It can only improve coverage — the
 * measurement that chose the bootstrap is a claim about which is WIDER in the
 * regimes that matter, and there the bootstrap still wins.
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

// ── Correcting a slice's observed rate ───────────────────────────

/** A rate the gold labels corrected, next to the rate the classifier claimed. */
export interface CorrectedRate {
  /** θ̂ and its 95% interval; `n` is the gold labels behind the correction. */
  corrected: MeasuredProportion;
  /** The classifier's own uncorrected rate over the same slice. */
  raw: number;
  /** θ̂ − raw. The bias the labels measured, in rate units — the whole reason
   *  this module exists. */
  bias: number;
  /** Ledger rows the estimate covers. */
  population: number;
}

export type CorrectedRateResult =
  | { rate: CorrectedRate; gap: null }
  | { rate: null; gap: CalibrationGap };

/**
 * Rogan–Gladen correction of one slice's observed rate, using an error profile
 * measured elsewhere. `observed` is the slice's own count of rows the
 * CLASSIFIER called an event; `accuracy` is the global profile.
 *
 * θ̂ is clipped to [0,1]: the estimator is unbiased but not range-respecting,
 * and a slice whose observed rate falls below the classifier's false-positive
 * rate can push it negative. The clip is applied to the reported point and to
 * the θ̂ used in the variance, so a clipped estimate still carries the full
 * width its inputs earn — it reads as "at most X%", not as certainty.
 *
 * The denominator q̂₁ + q̂₀ − 1 has to be measurably above zero, not merely
 * above zero: at exactly zero the verdict is independent of the truth and the
 * division is undefined, and just above zero it manufactures a vast
 * "correction" out of calibration noise. So the gate is the denominator
 * against its OWN 95% uncertainty. Below that, the honest answer is that these
 * labels have not established the classifier beats chance.
 *
 * Slices corrected from one shared calibration set share the q̂ terms and are
 * therefore correlated: fine for reading each one, not a licence to treat
 * their differences as independent tests.
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

// ── Agreement (Cohen's κ) ────────────────────────────────────────

/** One stratum's gold draws, kept as raw verdict PAIRS so the full multi-class
 *  confusion — not just the binary projection — can be rebuilt.
 *
 *  `key` is the SAMPLING stratum, not a rater: it carries the population weight
 *  and is the unit the bootstrap resamples within. Both raters vary per draw,
 *  which is what lets one estimator answer every pair — the classifier against
 *  the labeler (where rater `a` happens to be constant and equal to `key`), an
 *  ensemble against the labeler, and the ensemble against the classifier — all
 *  under the same stratified design. */
export interface GoldStratum {
  /** The stratum the draws were sampled from — the classifier's verdict. */
  key: string;
  /** Ledger rows in this stratum. */
  population: number;
  /** One entry per gold draw: what each of the two raters said about it. */
  draws: ReadonlyArray<{ a: string; b: string }>;
}

export interface KappaEstimate {
  /** Cohen's κ over the design-weighted confusion matrix. */
  value: number;
  lo: number;
  hi: number;
  /** Gold labels behind it. */
  n: number;
}

/** Resamples for the κ interval. Fixed so a report is reproducible. */
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
 * Cohen's κ between two raters, over the design-weighted confusion matrix (same
 * re-weighting as `classifierAccuracy`, and for the same reason). κ rather than
 * raw agreement because agreement alone is flattered by a skewed ledger: a
 * classifier that answers "accepted" every single time agrees with a labeler
 * ~85% of the time here while carrying no information at all, and κ scores
 * exactly that at 0.
 *
 * The interval is a stratified percentile bootstrap — resample each stratum's
 * gold draws within that stratum, the design that produced them — rather than a
 * closed form: κ's asymptotic variance (Fleiss, Cohen & Everitt, Psychol. Bull.
 * 72:323, 1969) assumes multinomial cell counts, which a stratified sample does
 * not have. Resampling whole DRAWS keeps the two raters' verdicts attached to
 * each other, which is what makes the interval valid for a pair of raters who
 * both vary — the ensemble comparisons in ensemble.ts.
 *
 * Weighting runs over the strata that carry gold draws. Callers gate this on
 * `classifierAccuracy` reporting no gap, so in practice that is every populated
 * stratum. Returns null with no gold labels, or when the marginals agree so
 * completely that chance agreement is 1 and κ is undefined.
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
    const resampled = drawn.map((s) => ({
      ...s,
      draws: s.draws.map(() => s.draws[Math.floor(random() * s.draws.length)]),
    }));
    const draw = kappaPoint(resampled, population);
    if (draw !== null) samples.push(draw);
  }
  samples.sort((a, b) => a - b);
  const pick = (q: number): number =>
    samples[Math.min(samples.length - 1, Math.max(0, Math.round(q * (samples.length - 1))))];
  const n = drawn.reduce((count, s) => count + s.draws.length, 0);
  return samples.length === 0 ? { value, lo: value, hi: value, n } : { value, lo: pick(0.025), hi: pick(0.975), n };
}
