// Paired statistics for the bench harness. Pure, deterministic, no IO.
//
// Every comparison this harness makes is PAIRED — the same task attempted by
// two variants — so a two-sample test would be both wrong (it discards the
// pairing) and weaker. Binary outcomes use exact McNemar; continuous outcomes
// use a seeded paired bootstrap. Both report an interval, and both report the
// instrument's own resolution so a "significant" result that the design cannot
// actually resolve is visible as such.

import { fnv1a64 } from '../prompting/volatile-context.js';

/** Two-sided significance level used everywhere unless overridden. */
export const DEFAULT_ALPHA = 0.05;
/** Target power for detectable-effect statements. */
export const DEFAULT_POWER = 0.8;
/** Resamples for the paired bootstrap. Fixed so runs are reproducible. */
export const DEFAULT_BOOTSTRAP_ITERATIONS = 10_000;

/** Inverse standard-normal CDF (Acklam's rational approximation, |ε| < 1.15e-9).
 *  Used for the z multipliers in power/MDE statements. */
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
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** log C(n, k) — via log-gamma so large discordant counts stay exact enough. */
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

/** A well-mixed [0,1) drawn deterministically from a string.
 *
 *  FNV-1a alone is not good enough here: its bits avalanche poorly for short,
 *  similar inputs, and slicing 32 of them off a 64-bit digest gave a 50/50 split
 *  request an observed 80/20. Folding to 32 bits and finishing with lowbias32
 *  fixes the distribution, which matters because this decides which tasks are
 *  held out and which variant attempts a task first. */
export function unitHash(text: string): number {
  const digest = fnv1a64(text);
  let x = (parseInt(digest.slice(0, 8), 16) ^ parseInt(digest.slice(8), 16)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 0x1_0000_0000;
}

/** Deterministic PRNG (mulberry32) — the bootstrap must be reproducible from a seed. */
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

export interface Interval {
  lo: number;
  hi: number;
  /** Confidence level, e.g. 0.95. */
  level: number;
}

export interface BootstrapOptions {
  iterations?: number;
  seed?: number;
  alpha?: number;
}

/** Percentile bootstrap CI for the mean of paired differences. Resamples the
 *  DIFFERENCE vector, which is what preserves the pairing. */
export function pairedBootstrapCI(diffs: readonly number[], opts: BootstrapOptions = {}): { mean: number; ci: Interval } {
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
  pairs: number;
  /** Fraction of pairs on which the two variants disagree. */
  discordanceRate: number;
  alpha?: number;
  power?: number;
}

/** Smallest |effect| (on the pass-rate scale) that a paired McNemar design with
 *  `pairs` tasks and this discordance rate can detect at the given alpha/power.
 *
 *  δ* = (z_{α/2} + z_β) · sqrt(ψ / n)
 *
 *  Calibration anchor: n = 157, ψ = 0.20, α = 0.05, power = 0.8 → δ* ≈ 0.10.
 *  Stating this number up front is the whole point: a 3pp difference at that n
 *  is BELOW the instrument's resolution and must not be read as a finding. */
export function minimumDetectableEffect(params: PowerParams): number {
  const { pairs, discordanceRate } = params;
  const alpha = params.alpha ?? DEFAULT_ALPHA;
  const power = params.power ?? DEFAULT_POWER;
  if (pairs <= 0 || discordanceRate <= 0) return Number.POSITIVE_INFINITY;
  const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);
  return z * Math.sqrt(discordanceRate / pairs);
}

/** The smallest two-sided p an exact paired test can ever produce with `pairs`
 *  tasks: every pair discordant and all favouring one side. If this exceeds
 *  alpha, the split cannot establish ANY effect, however large — a property of
 *  the design that must be visible before anyone runs it. */
export function floorPValue(pairs: number): number {
  return binomialTwoSidedP(pairs, pairs);
}

/** Fewest pairs at which significance is reachable at all. At alpha=0.05 this
 *  is 6: 2·0.5⁶ = 0.03125 ≤ 0.05, while 5 pairs bottom out at 0.0625. */
export function minimumPairsForSignificance(alpha = DEFAULT_ALPHA): number {
  for (let n = 1; n <= 64; n++) if (floorPValue(n) <= alpha) return n;
  return Number.POSITIVE_INFINITY;
}

/** Inverse of minimumDetectableEffect: pairs needed to detect `effect`. */
export function requiredPairs(effect: number, params: Omit<PowerParams, 'pairs'>): number {
  const alpha = params.alpha ?? DEFAULT_ALPHA;
  const power = params.power ?? DEFAULT_POWER;
  if (effect === 0 || params.discordanceRate <= 0) return Number.POSITIVE_INFINITY;
  const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);
  return Math.ceil((params.discordanceRate * z * z) / (effect * effect));
}

export interface PairedBinaryStats {
  pairs: number;
  /** Both variants passed. */
  bothPass: number;
  /** Both variants failed. */
  bothFail: number;
  /** Only the baseline (A) passed — McNemar's b. */
  onlyA: number;
  /** Only the candidate (B) passed — McNemar's c. */
  onlyB: number;
  discordant: number;
  discordanceRate: number;
  passRateA: number;
  passRateB: number;
  /** passRateB − passRateA, on the pass-rate scale. */
  effect: number;
  /** Paired bootstrap interval for `effect`. */
  ci: Interval;
  /** Exact McNemar (binomial) two-sided p-value. */
  pValue: number;
  alpha: number;
  power: number;
  /** Smallest effect this design could detect (see minimumDetectableEffect). */
  mde: number;
  /** |effect| / mde. Below 1 means the observed effect is smaller than what the
   *  design can resolve — do not over-read it, even if p < alpha. */
  resolutionRatio: number;
  resolvable: boolean;
  significant: boolean;
  /** Fewer than 10 discordant pairs. The exact p-value is still exact, but the
   *  normal-approximation MDE is unreliable here — say so rather than quote it
   *  as though it were tight. */
  smallSample: boolean;
  /** Smallest p this many pairs could ever produce. */
  floorPValue: number;
  /** False when floorPValue > alpha: no outcome on this split can be
   *  significant, so the split cannot accept or reject on evidence. */
  canReachSignificance: boolean;
  /** Pairs that would be needed to resolve the observed effect. */
  pairsNeededForObserved: number;
  verdict: string;
}

export interface PairedOutcome {
  taskId: string;
  /** Baseline variant passed. */
  a: boolean;
  /** Candidate variant passed. */
  b: boolean;
}

/** The headline comparison: exact McNemar + a paired bootstrap interval +
 *  an explicit resolution statement. `a` is the baseline, `b` the candidate. */
export function pairedBinaryComparison(
  outcomes: readonly PairedOutcome[],
  opts: BootstrapOptions & { power?: number } = {},
): PairedBinaryStats {
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  const power = opts.power ?? DEFAULT_POWER;
  const pairs = outcomes.length;
  let bothPass = 0, bothFail = 0, onlyA = 0, onlyB = 0;
  for (const o of outcomes) {
    if (o.a && o.b) bothPass++;
    else if (!o.a && !o.b) bothFail++;
    else if (o.a) onlyA++;
    else onlyB++;
  }
  const discordant = onlyA + onlyB;
  const discordanceRate = pairs === 0 ? 0 : discordant / pairs;
  const passRateA = pairs === 0 ? 0 : (bothPass + onlyA) / pairs;
  const passRateB = pairs === 0 ? 0 : (bothPass + onlyB) / pairs;
  const diffs = outcomes.map((o) => (o.b ? 1 : 0) - (o.a ? 1 : 0));
  const { mean: effect, ci } = pairedBootstrapCI(diffs, { ...opts, alpha });
  const pValue = binomialTwoSidedP(onlyB, discordant);
  const mde = minimumDetectableEffect({ pairs, discordanceRate, alpha, power });
  const resolutionRatio = Number.isFinite(mde) && mde > 0 ? Math.abs(effect) / mde : 0;
  const resolvable = resolutionRatio >= 1;
  const significant = pValue < alpha;
  const pairsNeededForObserved = requiredPairs(effect, { discordanceRate, alpha, power });

  const smallSample = discordant > 0 && discordant < 10;
  const floor = floorPValue(pairs);
  const canReachSignificance = pairs > 0 && floor <= alpha;

  let verdict: string;
  if (pairs === 0) verdict = 'no pairs ran — nothing to conclude';
  else if (discordant === 0) verdict = `variants never disagreed on ${pairs} tasks — this corpus cannot separate them`;
  else if (!canReachSignificance) {
    verdict = `${pairs} pairs can never reach p ≤ ${alpha} (the best possible p here is ${floor.toFixed(4)}) — this split cannot establish any effect; it needs at least ${minimumPairsForSignificance(alpha)} tasks`;
  }
  else if (significant && resolvable) verdict = `effect ${fmtPp(effect)} is significant (p=${pValue.toFixed(4)}) and above the design's resolution (${fmtPp(mde)})`;
  else if (significant) verdict = `effect ${fmtPp(effect)} is significant (p=${pValue.toFixed(4)}) but below the design's 80%-power threshold of ${fmtPp(mde)} — suggestive, not established; ${pairsNeededForObserved} pairs would settle it`;
  else verdict = `no detectable difference (p=${pValue.toFixed(4)}); this design resolves ${fmtPp(mde)}, so effects below that are invisible`;
  if (smallSample) verdict += ` [only ${discordant} discordant pairs — the p-value is exact, the ${fmtPp(mde)} threshold is a normal approximation and loose here]`;

  return {
    pairs, bothPass, bothFail, onlyA, onlyB, discordant, discordanceRate,
    passRateA, passRateB, effect, ci, pValue, alpha, power,
    mde, resolutionRatio, resolvable, significant, smallSample,
    floorPValue: floor, canReachSignificance, pairsNeededForObserved, verdict,
  };
}

/** Percentage points, signed — the unit every effect in this harness is reported in. */
export function fmtPp(x: number): string {
  if (!Number.isFinite(x)) return 'n/a';
  return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}pp`;
}

export interface GainStats {
  /** Mean reward with all evolution state live. */
  statefulReward: number;
  /** Mean reward from a fresh v0 identity with empty stores. */
  statelessReward: number;
  /** statefulReward − statelessReward. */
  gain: number;
  /** gain / (1 − statelessReward) — the fraction of remaining headroom the
   *  evolution machinery captured. Undefined when there is no headroom. */
  normalizedGain: number | null;
  ci: Interval;
  pValue: number;
  tasks: number;
  verdict: string;
}

/** CL-Bench's stateful-vs-stateless primitive. `paired[i]` is the same task run
 *  under both arms; a gain at or below zero is a real, reportable result. */
export function computeGain(
  paired: readonly { taskId: string; stateful: number; stateless: number }[],
  opts: BootstrapOptions = {},
): GainStats {
  const tasks = paired.length;
  const mean = (pick: (p: { stateful: number; stateless: number }) => number) =>
    tasks === 0 ? 0 : paired.reduce((s, p) => s + pick(p), 0) / tasks;
  const statefulReward = mean((p) => p.stateful);
  const statelessReward = mean((p) => p.stateless);
  const diffs = paired.map((p) => p.stateful - p.stateless);
  const { mean: gain, ci } = pairedBootstrapCI(diffs, opts);
  const headroom = 1 - statelessReward;
  const normalizedGain = headroom > 1e-9 ? gain / headroom : null;
  // Binary-safe significance: the same exact paired test, on sign of the diff.
  const wins = diffs.filter((d) => d > 0).length;
  const losses = diffs.filter((d) => d < 0).length;
  const pValue = binomialTwoSidedP(wins, wins + losses);

  let verdict: string;
  if (tasks === 0) verdict = 'no tasks ran — no gain measured';
  else if (ci.lo <= 0 && ci.hi >= 0) verdict = `gain ${fmtPp(gain)} — interval spans zero; the evolution state showed no measurable contribution`;
  else if (gain > 0) verdict = `gain ${fmtPp(gain)}${normalizedGain === null ? '' : ` (${(normalizedGain * 100).toFixed(1)}% of headroom)`}`;
  else verdict = `gain ${fmtPp(gain)} — the stateful arm did WORSE than a fresh v0 agent`;

  return { statefulReward, statelessReward, gain, normalizedGain, ci, pValue, tasks, verdict };
}
