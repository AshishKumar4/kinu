// Paired statistics for the bench harness. Pure, deterministic, no IO.
// The unit of pairing is the task, not the attempt: repeats are collapsed to a
// per-task pass rate first, since counting attempts as pairs is pseudoreplication.

import { fnv1a64 } from '../utils/fnv1a';
import { seededRandom } from '../utils/stats';

export const DEFAULT_ALPHA = 0.05;

export const DEFAULT_POWER = 0.8;

export const DEFAULT_BOOTSTRAP_ITERATIONS = 10_000;

/** Inverse standard-normal CDF (Acklam's rational approximation, |ε| < 1.15e-9). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error(`normalQuantile: p must be in (0,1), got ${p}`);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));

    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  if (p > 1 - pLow) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;

  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function logGamma(x: number): number {
  const g = [76.18009172947146, -86.50532032941678, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;

  for (let j = 0; j < 6; j++) ser += g[j] / ++y;

  return -tmp + Math.log((2.5066282746310007 * ser) / x);
}

function logChoose(n: number, k: number): number {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/** Exact two-sided p-value for X ~ Binomial(n, 1/2), the null McNemar uses. */
export function binomialTwoSidedP(successes: number, trials: number): number {
  if (trials === 0) return 1;
  const k = Math.min(successes, trials - successes);
  let tail = 0;

  for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(trials, i) - trials * Math.LN2);

  return Math.min(1, 2 * tail);
}

/** A well-mixed [0,1) from a string. Plain FNV-1a bits skew short similar inputs,
 *  so the digest is folded to 32 bits and finished with lowbias32. */
export function unitHash(text: string): number {
  const digest = fnv1a64(text);
  let x = (parseInt(digest.slice(0, 8), 16) ^ parseInt(digest.slice(8), 16)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;

  return x / 0x1_0000_0000;
}

export interface Interval {
  lo: number;
  hi: number;
  level: number;
}

export interface BootstrapOptions {
  iterations?: number;
  seed?: number;
  alpha?: number;
}

/** Percentile bootstrap over paired differences. With per-task differences this
 *  is a cluster bootstrap. */
export function pairedBootstrapCI(diffs: readonly number[], opts: BootstrapOptions = {}) {
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  const iterations = opts.iterations ?? DEFAULT_BOOTSTRAP_ITERATIONS;
  const n = diffs.length;
  const mean = n === 0 ? 0 : diffs.reduce((s, d) => s + d, 0) / n;

  if (n === 0) return { mean: 0, ci: { lo: 0, hi: 0, level: 1 - alpha } };
  const rand = seededRandom(opts.seed ?? 1);
  const means = new Float64Array(iterations);

  for (let it = 0; it < iterations; it++) {
    let sum = 0;

    for (let i = 0; i < n; i++) sum += diffs[Math.floor(rand() * n)];
    means[it] = sum / n;
  }

  means.sort();
  const pick = (q: number) => means[Math.min(iterations - 1, Math.max(0, Math.round(q * (iterations - 1))))];

  return { mean, ci: { lo: pick(alpha / 2), hi: pick(1 - alpha / 2), level: 1 - alpha } };
}

export interface PowerParams {
  /** Tasks, never attempts. */
  pairs: number;
  /** ψ: mean squared per-task difference (the discordance rate at one attempt per task). */
  dispersion: number;
  alpha?: number;
  power?: number;
}

/** Smallest |effect| detectable: δ* = (z_{α/2} + z_β) · sqrt(ψ / n). */
export function minimumDetectableEffect(params: PowerParams): number {
  const { pairs, dispersion } = params;
  const alpha = params.alpha ?? DEFAULT_ALPHA;
  const power = params.power ?? DEFAULT_POWER;

  if (pairs <= 0 || dispersion <= 0) return Number.POSITIVE_INFINITY;
  const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);

  return z * Math.sqrt(dispersion / pairs);
}

/** Smallest two-sided p an exact paired test can produce with `pairs` tasks. */
export function floorPValue(pairs: number): number {
  return binomialTwoSidedP(pairs, pairs);
}

/** Fewest pairs at which significance is reachable (6 at alpha=0.05). */
export function minimumPairsForSignificance(alpha = DEFAULT_ALPHA): number {
  for (let n = 1; n <= 64; n++) if (floorPValue(n) <= alpha) return n;

  return Number.POSITIVE_INFINITY;
}

/** Tasks needed to detect `effect`. */
export function requiredPairs(effect: number, params: Omit<PowerParams, 'pairs'>): number {
  const alpha = params.alpha ?? DEFAULT_ALPHA;
  const power = params.power ?? DEFAULT_POWER;

  if (effect === 0 || params.dispersion <= 0) return Number.POSITIVE_INFINITY;
  const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);

  return Math.ceil((params.dispersion * z * z) / (effect * effect));
}

export interface PairedBinaryStats {
  pairs: number;
  repeats: number;
  /** Cost reporting only; never an inferential denominator. */
  attemptsPerVariant: number;
  bothPass: number;
  bothFail: number;
  /** Tied at a rate strictly between 0 and 1. */
  tiedPartial: number;
  /** McNemar's b. */
  onlyA: number;
  /** McNemar's c. */
  onlyB: number;
  discordant: number;
  discordanceRate: number;
  dispersion: number;
  passAtOneA: number;
  passAtOneB: number;
  /** pass^k: fraction of tasks solved in all k attempts. */
  passAllA: number;
  passAllB: number;
  flakyA: number;
  flakyB: number;
  /** Counts only: ids from the sealed split would leak per-task signal. */
  flakyEither: number;
  effect: number;
  effectAll: number;
  ci: Interval;
  /** Exact sign test over tasks whose rates differed (exact McNemar at repeats=1). */
  pValue: number;
  alpha: number;
  power: number;
  mde: number;
  /** |effect| / mde; below 1 the effect is under the design's resolution. */
  resolutionRatio: number;
  resolvable: boolean;
  significant: boolean;
  /** Fewer than 10 discordant pairs: the normal-approximation MDE is unreliable. */
  smallSample: boolean;
  /** 2^(1-discordant): computed over differing pairs, not all pairs. */
  floorPValue: number;
  canReachSignificance: boolean;
  pairsNeededForObserved: number;
  verdict: string;
}

export interface PairedOutcome {
  taskId: string;
  a: readonly boolean[];
  b: readonly boolean[];
}

export interface TaskRepeatSummary {
  taskId: string;
  repeats: number;
  passesA: number;
  passesB: number;
  rateA: number;
  rateB: number;
  allA: boolean;
  allB: boolean;
  flakyA: boolean;
  flakyB: boolean;
}

/** One row per task from here on, so k attempts can never count as k pairs. */
export function summarizeRepeats(outcome: PairedOutcome): TaskRepeatSummary {
  const repeats = outcome.a.length;

  if (repeats === 0) throw new Error(`task ${outcome.taskId} has no attempts`);

  if (outcome.b.length !== repeats) {
    throw new Error(`task ${outcome.taskId} ran ${repeats} baseline attempts but ${outcome.b.length} candidate attempts — a paired design cannot compare unequal repeats`);
  }

  const passesA = outcome.a.filter(Boolean).length;
  const passesB = outcome.b.filter(Boolean).length;

  return {
    taskId: outcome.taskId, repeats, passesA, passesB,
    rateA: passesA / repeats, rateB: passesB / repeats,
    allA: passesA === repeats, allB: passesB === repeats,
    flakyA: passesA > 0 && passesA < repeats,
    flakyB: passesB > 0 && passesB < repeats,
  };
}

/** Exact paired test over tasks, cluster bootstrap CI, and a resolution statement.
 *  `a` is the baseline, `b` the candidate. */
export function pairedBinaryComparison(
  outcomes: readonly PairedOutcome[],
  opts: BootstrapOptions & { power?: number } = {},
): PairedBinaryStats {
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  const power = opts.power ?? DEFAULT_POWER;
  const summaries = outcomes.map(summarizeRepeats);
  const pairs = summaries.length;
  const repeats = summaries[0]?.repeats ?? 1;

  for (const s of summaries) {
    if (s.repeats !== repeats) {
      throw new Error(`task ${s.taskId} ran ${s.repeats} repeats but the split ran ${repeats} — a split with ragged repeats has no single pass^k`);
    }
  }

  let bothPass = 0, bothFail = 0, tiedPartial = 0, onlyA = 0, onlyB = 0;
  let flakyA = 0, flakyB = 0, flakyEither = 0;
  let allA = 0, allB = 0, rateSumA = 0, rateSumB = 0, squaredDiff = 0;

  for (const s of summaries) {
    if (s.rateA > s.rateB) onlyA++;
    else if (s.rateB > s.rateA) onlyB++;
    else if (s.allA) bothPass++;
    else if (s.passesA === 0) bothFail++;
    else tiedPartial++;

    if (s.flakyA) flakyA++;

    if (s.flakyB) flakyB++;

    if (s.flakyA || s.flakyB) flakyEither++;

    if (s.allA) allA++;

    if (s.allB) allB++;
    rateSumA += s.rateA;
    rateSumB += s.rateB;
    squaredDiff += (s.rateB - s.rateA) ** 2;
  }

  const discordant = onlyA + onlyB;
  const discordanceRate = pairs === 0 ? 0 : discordant / pairs;
  const dispersion = pairs === 0 ? 0 : squaredDiff / pairs;
  const passAtOneA = pairs === 0 ? 0 : rateSumA / pairs;
  const passAtOneB = pairs === 0 ? 0 : rateSumB / pairs;
  const passAllA = pairs === 0 ? 0 : allA / pairs;
  const passAllB = pairs === 0 ? 0 : allB / pairs;

  const diffs = summaries.map((s) => s.rateB - s.rateA);
  const { mean: effect, ci } = pairedBootstrapCI(diffs, { ...opts, alpha });
  const pValue = binomialTwoSidedP(onlyB, discordant);
  const mde = minimumDetectableEffect({ pairs, dispersion, alpha, power });
  const resolutionRatio = Number.isFinite(mde) && mde > 0 ? Math.abs(effect) / mde : 0;
  const resolvable = resolutionRatio >= 1;
  const significant = pValue < alpha;
  const pairsNeededForObserved = requiredPairs(effect, { dispersion, alpha, power });

  const smallSample = discordant > 0 && discordant < 10;
  // The floor comes from `discordant`, the set the p-value is computed over.
  const floor = floorPValue(discordant);
  const canReachSignificance = discordant > 0 && floor <= alpha;

  let verdict: string;

  if (pairs === 0) verdict = 'no pairs ran — nothing to conclude';
  else if (discordant === 0) verdict = `variants never disagreed on ${pairs} tasks — this corpus cannot separate them`;
  else if (!canReachSignificance) {
    verdict = `UNDECIDABLE: ${discordant} of ${pairs} task(s) differed between the arms, and the smallest p `
      + `that many differing pairs can produce is ${floor.toFixed(4)} > alpha ${alpha} — no outcome here `
      + `could have established an effect. It needs at least ${minimumPairsForSignificance(alpha)} `
      + 'DIFFERING pairs, which more tasks make possible but do not guarantee';
  }
  else if (significant && resolvable) verdict = `effect ${fmtPp(effect)} is significant (p=${pValue.toFixed(4)}) and above the design's resolution (${fmtPp(mde)})`;
  else if (significant) verdict = `effect ${fmtPp(effect)} is significant (p=${pValue.toFixed(4)}) but below the design's 80%-power threshold of ${fmtPp(mde)} — suggestive, not established; ${pairsNeededForObserved} pairs would settle it`;
  else verdict = `no detectable difference (p=${pValue.toFixed(4)}); this design resolves ${fmtPp(mde)}, so effects below that are invisible`;

  if (smallSample) verdict += ` [only ${discordant} discordant pairs — the p-value is exact, the ${fmtPp(mde)} threshold is a normal approximation and loose here]`;

  if (repeats > 1) verdict += ` [${repeats} repeats × ${pairs} tasks = ${pairs * repeats} attempts per variant, but still ${pairs} independent pairs — repeats buy precision within a task, never more tasks]`;

  return {
    pairs, repeats, attemptsPerVariant: pairs * repeats,
    bothPass, bothFail, tiedPartial, onlyA, onlyB, discordant, discordanceRate, dispersion,
    passAtOneA, passAtOneB, passAllA, passAllB, flakyA, flakyB, flakyEither,
    effect, effectAll: passAllB - passAllA, ci, pValue, alpha, power,
    mde, resolutionRatio, resolvable, significant, smallSample,
    floorPValue: floor, canReachSignificance, pairsNeededForObserved, verdict,
  };
}

export function fmtPp(x: number): string {
  if (!Number.isFinite(x)) return 'n/a';

  return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}pp`;
}

export interface GainStats {
  statefulReward: number;
  statelessReward: number;
  gain: number;
  /** gain / (1 − statelessReward); null with no headroom or when rewards leave [0,1]. */
  normalizedGain: number | null;
  ci: Interval;
  pValue: number;
  tasks: number;
  /** The real denominator of the significance claim. */
  pairsWithDifference: number;
  floorPValue: number;
  canReachSignificance: boolean;
  verdict: string;
}

/** CL-Bench's stateful-vs-stateless comparison. `paired[i]` is one task under both arms. */
export function computeGain(
  paired: readonly { taskId: string; stateful: number; stateless: number }[],
  opts: BootstrapOptions & { alpha?: number } = {},
): GainStats {
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  const tasks = paired.length;

  const mean = (pick: (p: { stateful: number; stateless: number }) => number) =>
    tasks === 0 ? 0 : paired.reduce((s, p) => s + pick(p), 0) / tasks;

  const statefulReward = mean((p) => p.stateful);
  const statelessReward = mean((p) => p.stateless);
  const diffs = paired.map((p) => p.stateful - p.stateless);
  const { mean: gain, ci } = pairedBootstrapCI(diffs, opts);

  const bounded = paired.every((p) => (
    p.stateful >= 0 && p.stateful <= 1 && p.stateless >= 0 && p.stateless <= 1
  ));

  const headroom = 1 - statelessReward;
  const normalizedGain = bounded && headroom > 1e-9 ? gain / headroom : null;
  const wins = diffs.filter((d) => d > 0).length;
  const losses = diffs.filter((d) => d < 0).length;
  const pairsWithDifference = wins + losses;
  const pValue = binomialTwoSidedP(wins, pairsWithDifference);
  const floor = floorPValue(pairsWithDifference);
  const canReach = pairsWithDifference > 0 && floor <= alpha;

  let verdict: string;

  if (tasks === 0) verdict = 'no tasks ran — no gain measured';
  else if (!canReach) {
    verdict = `UNDECIDABLE: ${pairsWithDifference} of ${tasks} task(s) differed between the arms, and `
      + `${pairsWithDifference === 0
        ? 'a contrast where no task differed measured nothing at all'
        : `the smallest p that many differing pairs can produce is ${floor.toFixed(4)} > alpha ${alpha}`}`
      + `. The observed gain ${fmtPp(gain)} is not evidence of an effect in either direction — `
      + `${minimumPairsForSignificance(alpha)} differing pairs are the minimum.`;
  } else if (ci.lo <= 0 && ci.hi >= 0) verdict = `gain ${fmtPp(gain)} — interval spans zero; the evolution state showed no measurable contribution`;
  else if (gain > 0) verdict = `gain ${fmtPp(gain)}${normalizedGain === null ? '' : ` (${(normalizedGain * 100).toFixed(1)}% of headroom)`}`;
  else verdict = `gain ${fmtPp(gain)} — the stateful arm did WORSE than a fresh v0 agent`;

  return {
    statefulReward, statelessReward, gain, normalizedGain, ci, pValue, tasks,
    pairsWithDifference, floorPValue: floor, canReachSignificance: canReach, verdict,
  };
}
