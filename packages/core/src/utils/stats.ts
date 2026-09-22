/**
 * Wilson score intervals for self-reported [0,1] scores, treating the score sum as successes of `n` trials.
 * Errs wide for fractional scores and never collapses to a point on unanimous verdicts; no API returns a bare mean.
 */

/** Two-sided 95% z value. */
export const Z_95 = 1.959964;

/** Deterministic PRNG (mulberry32): resampling must be reproducible, so never `Math.random`. */
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

/** A reported score and its 95% interval; bounds within [0,1]. */
export interface ScoreInterval {
  mean: number;
  lo: number;
  hi: number;
  n: number;
}

/** Fractional successes allowed. `n <= 0` yields the uninformative [0,1] interval. */
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

export function scoreInterval(scores: ReadonlyArray<number>): ScoreInterval {
  return wilsonInterval(scores.reduce((sum, s) => sum + s, 0), scores.length);
}

/** The interval as loss (1 − score); bounds swap and flip. */
export function lossInterval(score: ScoreInterval): ScoreInterval {
  return { mean: 1 - score.mean, lo: 1 - score.hi, hi: 1 - score.lo, n: score.n };
}

/** `0.75 (95% CI 0.30–0.95)`: the one rendering of a reported score. */
export function formatScoreInterval(interval: ScoreInterval, digits = 2): string {
  return `${interval.mean.toFixed(digits)} (95% CI ${interval.lo.toFixed(digits)}–${interval.hi.toFixed(digits)})`;
}
