/**
 * Confidence intervals for the scores this system reports about itself.
 *
 * Every quality number the evolution stack surfaces — the replay-eval mean,
 * a GEPA candidate's aggregate — is the mean of a handful of judge verdicts
 * in [0,1]. Reported bare, such a mean invites over-reading: at n=8 the 95%
 * interval around 0.5 is roughly ±0.28, wider than any improvement the
 * optimizer could plausibly find. Numbers here therefore travel with the
 * interval attached; there is no API that hands out the mean alone.
 *
 * Interval: the Wilson score interval, treating the sum of scores as the
 * "successes" of `n` trials.
 *   - The judges are prompted to answer 1.0 or 0.0, so the data are
 *     near-Bernoulli and Wilson is the standard small-n interval for exactly
 *     that shape.
 *   - For genuinely fractional scores it errs wide, never narrow: among
 *     [0,1]-bounded variables with mean p, the Bernoulli variance p(1-p)
 *     Wilson assumes is the maximum, so the interval covers at least as much
 *     as the truth.
 *   - Unlike a Wald or t interval it never collapses to a point when the
 *     verdicts agree (six unanimous 1.0s give [0.61, 1.0], not [1.0, 1.0])
 *     and never escapes [0,1]. Both matter here: unanimous judges are common,
 *     and a zero-width interval is precisely the false precision this exists
 *     to prevent.
 */

/** 97.5th percentile of the standard normal — a two-sided 95% interval. */
export const Z_95 = 1.959964;

/** Deterministic PRNG (mulberry32). Every resampling procedure here must be
 *  reproducible from a seed, so none of them may reach for `Math.random`. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A reported score and the 95% interval around it. Bounds are within [0,1]. */
export interface ScoreInterval {
  /** The observed mean. */
  mean: number;
  /** Lower 95% bound. */
  lo: number;
  /** Upper 95% bound. */
  hi: number;
  /** Observations behind the mean. */
  n: number;
}

/**
 * Wilson interval for `successes` out of `n`. Fractional successes are
 * allowed (see the module note). `n <= 0` yields the uninformative [0,1]
 * interval — no observations, no claim.
 */
export function wilsonInterval(successes: number, n: number): ScoreInterval {
  if (n <= 0) return { mean: 0, lo: 0, hi: 1, n: 0 };
  const p = Math.min(1, Math.max(0, successes / n));
  const z2 = Z_95 * Z_95;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const halfWidth = (Z_95 / denominator) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    mean: p,
    lo: Math.max(0, center - halfWidth),
    hi: Math.min(1, center + halfWidth),
    n,
  };
}

/** Wilson interval over a set of observed [0,1] scores. */
export function scoreInterval(scores: ReadonlyArray<number>): ScoreInterval {
  return wilsonInterval(scores.reduce((sum, s) => sum + s, 0), scores.length);
}

/** The same interval expressed as loss (1 − score); bounds swap and flip. */
export function lossInterval(score: ScoreInterval): ScoreInterval {
  return { mean: 1 - score.mean, lo: 1 - score.hi, hi: 1 - score.lo, n: score.n };
}

/** `0.75 (95% CI 0.30–0.95)` — the one rendering of a reported score. */
export function formatScoreInterval(interval: ScoreInterval, digits = 2): string {
  return `${interval.mean.toFixed(digits)} (95% CI ${interval.lo.toFixed(digits)}–${interval.hi.toFixed(digits)})`;
}
