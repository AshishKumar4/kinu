// Paired statistics for the bench harness. Pure, deterministic, no IO.
//
// Every comparison this harness makes is PAIRED — the same task attempted by
// two variants — so a two-sample test would be both wrong (it discards the
// pairing) and weaker. Binary outcomes use exact McNemar; continuous outcomes
// use a seeded paired bootstrap. Both report an interval, and both report the
// instrument's own resolution so a "significant" result that the design cannot
// actually resolve is visible as such.
//
// THE UNIT OF PAIRING IS THE TASK, NOT THE ATTEMPT. With `repeats` attempts per
// task per variant, the repeats of one task are not independent observations —
// they share the task's difficulty, its defect, and its checks. Feeding k·n
// attempt pairs to an exact test as though they were k·n independent pairs is
// the classic pseudoreplication error and it inflates significance
// multiplicatively: n tasks that a candidate sweeps at k=3 would report
// 2·0.5^(3n) instead of the 2·0.5^n the design actually earns. So every task is
// collapsed to a per-task pass RATE first, and the test and the interval both
// operate on the n task-level differences.

import { fnv1a64 } from '../prompting/volatile-context';
import { seededRandom } from '../utils/stats';

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
  const g = [76.18009172947146, -86.50532032941678, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log((2.5066282746310007 * ser) / x);
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
 *  DIFFERENCE vector, which is what preserves the pairing — and, once the
 *  entries are per-TASK differences over repeats, makes this a cluster
 *  bootstrap: a task is resampled whole, so within-task correlation is carried
 *  into the interval instead of being washed out. */
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
  /** Independent pairs — i.e. TASKS. Never attempts: repeats of one task are
   *  not independent, and counting them here is what overstates power. */
  pairs: number;
  /** ψ: mean squared per-task difference, the null variance of one pair's
   *  contribution. For single-attempt binary outcomes a task's difference is
   *  −1, 0 or +1, so ψ is exactly the discordance rate — the classic McNemar
   *  quantity. With repeats the per-task difference is a difference of RATES,
   *  so ψ shrinks as run-to-run noise averages out, and that shrinkage is the
   *  real (and only) power gain repeats buy. */
  dispersion: number;
  alpha?: number;
  power?: number;
}

/** Smallest |effect| (on the pass-rate scale) that a paired design with `pairs`
 *  tasks and this dispersion can detect at the given alpha/power.
 *
 *  δ* = (z_{α/2} + z_β) · sqrt(ψ / n)
 *
 *  Calibration anchor: n = 157, ψ = 0.20, α = 0.05, power = 0.8 → δ* ≈ 0.10.
 *  Stating this number up front is the whole point: a 3pp difference at that n
 *  is BELOW the instrument's resolution and must not be read as a finding. */
export function minimumDetectableEffect(params: PowerParams): number {
  const { pairs, dispersion } = params;
  const alpha = params.alpha ?? DEFAULT_ALPHA;
  const power = params.power ?? DEFAULT_POWER;
  if (pairs <= 0 || dispersion <= 0) return Number.POSITIVE_INFINITY;
  const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);
  return z * Math.sqrt(dispersion / pairs);
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

/** Inverse of minimumDetectableEffect: TASKS needed to detect `effect`. */
export function requiredPairs(effect: number, params: Omit<PowerParams, 'pairs'>): number {
  const alpha = params.alpha ?? DEFAULT_ALPHA;
  const power = params.power ?? DEFAULT_POWER;
  if (effect === 0 || params.dispersion <= 0) return Number.POSITIVE_INFINITY;
  const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);
  return Math.ceil((params.dispersion * z * z) / (effect * effect));
}

export interface PairedBinaryStats {
  /** Independent pairs — tasks, not attempts. */
  pairs: number;
  /** Attempts per task per variant. 1 restores the plain McNemar design. */
  repeats: number;
  /** Attempts per variant across the whole split, for cost reporting only. It
   *  is deliberately NOT the denominator of anything inferential. */
  attemptsPerVariant: number;
  /** Both variants passed every repeat. */
  bothPass: number;
  /** Both variants failed every repeat. */
  bothFail: number;
  /** Tied at a rate that is neither 0 nor 1 — only reachable with repeats. */
  tiedPartial: number;
  /** Baseline (A) had the higher pass rate — McNemar's b. */
  onlyA: number;
  /** Candidate (B) had the higher pass rate — McNemar's c. */
  onlyB: number;
  discordant: number;
  discordanceRate: number;
  /** ψ: mean squared per-task rate difference. Equals discordanceRate at
   *  repeats=1; below it once repeats average run-to-run noise away. */
  dispersion: number;
  /** pass@1 — mean over every attempt. The single-shot number. */
  passAtOneA: number;
  passAtOneB: number;
  /** pass^k — fraction of tasks solved in ALL k attempts. The reliability
   *  number, and identical to pass@1 when k=1. */
  passAllA: number;
  passAllB: number;
  /** Tasks whose repeats disagreed under that variant — unstable, not solved. */
  flakyA: number;
  flakyB: number;
  /** Tasks unstable under either variant. Counts only: this shape is what the
   *  sealed split emits, and ids there would leak per-task signal. */
  flakyEither: number;
  /** passAtOneB − passAtOneA, on the pass-rate scale. */
  effect: number;
  /** passAllB − passAllA: the same comparison on the reliability axis. */
  effectAll: number;
  /** Cluster (per-task) bootstrap interval for `effect`. */
  ci: Interval;
  /** Exact two-sided p over the tasks whose rates differed. At repeats=1 this
   *  is exact McNemar; above it, the exact sign test on task-level differences,
   *  which keeps one vote per task. */
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
  /** Smallest p this many DIFFERING pairs could ever produce: 2^(1-discordant).
   *  The denominator is `discordant`, not `pairs`, because that is the set the
   *  exact test is computed over — a task both arms agreed on contributes
   *  nothing to it. */
  floorPValue: number;
  /** False when floorPValue > alpha: no outcome on this split could have been
   *  significant, whatever the effect, so the split cannot accept or reject on
   *  evidence. A large `pairs` does not make this true; only differing pairs do. */
  canReachSignificance: boolean;
  /** Pairs that would be needed to resolve the observed effect. */
  pairsNeededForObserved: number;
  verdict: string;
}

export interface PairedOutcome {
  taskId: string;
  /** One entry per repeat: did the baseline pass that attempt? */
  a: readonly boolean[];
  /** One entry per repeat: did the candidate pass that attempt? */
  b: readonly boolean[];
}

/** How one task came out across its repeats, under both variants. */
export interface TaskRepeatSummary {
  taskId: string;
  repeats: number;
  passesA: number;
  passesB: number;
  rateA: number;
  rateB: number;
  /** Passed every repeat — the pass^k contribution. */
  allA: boolean;
  allB: boolean;
  /** Repeats disagreed: the task is unstable under that variant. */
  flakyA: boolean;
  flakyB: boolean;
}

/** Collapse a task's repeats to the quantities every downstream number is built
 *  from. This is the pseudoreplication firewall: after this point there is one
 *  row per task, so nothing can accidentally treat k attempts as k pairs. */
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

/** The headline comparison: an exact paired test over TASKS + a cluster
 *  bootstrap interval + an explicit resolution statement. `a` is the baseline,
 *  `b` the candidate.
 *
 *  With repeats=1 this is bit-for-bit the McNemar design it has always been: a
 *  task's rate is 0 or 1, so "rateB > rateA" is "only B passed", and the sign
 *  test over discordant tasks IS exact McNemar. With repeats>1 the same code
 *  keeps one vote per task, which is the whole point — the alternative, one
 *  vote per attempt, would report 2·0.5^(k·n) where the design earns 2·0.5^n. */
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
  // The floor belongs to the set the p-value is actually computed over, which is
  // `discordant` — `binomialTwoSidedP(onlyB, discordant)` above. Reading it off
  // `pairs` was the same defect computeGain was hardened for: 40 tasks of which
  // 2 differed reported canReachSignificance=true while the smallest p that
  // design can produce is 0.5. A large task count is an upper bound on the
  // decidable set, never the decidable set.
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
   *  evolution machinery captured. `null` when there is no headroom, and also
   *  when a reward left [0,1]: the ratio assumes a bounded scale, and CL-Bench's
   *  poker rewards are signed chip counts, where "fraction of headroom" is not a
   *  quantity. Reporting it there would be a number about nothing. */
  normalizedGain: number | null;
  ci: Interval;
  pValue: number;
  tasks: number;
  /** Tasks whose arms actually differed. This is the real denominator of the
   *  significance claim, and it is reported because it is routinely far below
   *  `tasks`: the first CL-Bench run had 5 tasks and 2 differences. */
  pairsWithDifference: number;
  /** Smallest p this many differing pairs could ever produce. */
  floorPValue: number;
  /** False when no outcome on this design could be significant. An inert
   *  contrast otherwise reports a neutral-looking p and reads as "no effect"
   *  when the truth is "measured nothing at all" — an empty denominator is
   *  vacuous per task and a failure per design. */
  canReachSignificance: boolean;
  verdict: string;
}

/** CL-Bench's stateful-vs-stateless primitive. `paired[i]` is the same task run
 *  under both arms; a gain at or below zero is a real, reportable result.
 *
 *  A gain that the design could not have resolved is NOT a reportable result,
 *  and this says so mechanically rather than leaving it to whoever reads the
 *  number: `canReachSignificance` is false below the exact test's own floor, and
 *  the verdict leads with that rather than with the point estimate. */
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
  // Binary-safe significance: the same exact paired test, on sign of the diff.
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
