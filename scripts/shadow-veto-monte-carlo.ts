/**
 * Shadow-promotion veto — binomial Monte Carlo (FORMAL-RIGOR-PLAN Part 3).
 *
 * The scaffold self-evolution loop promotes a "pending" variant over the live
 * one only if it wins enough shadow trials under the rule in
 * `packages/core/src/scaffold/shadow.ts` (decidePromotion). This script settles
 * that rule's constants with a pure simulation (NO LLM calls): it draws judge
 * verdicts from a parametric world and applies the REAL decidePromotion —
 * imported, not reimplemented — one recorded trial at a time, first
 * promote/rollback terminal, exactly as runAutoShadowEval does.
 *
 * Run: bun scripts/shadow-veto-monte-carlo.ts
 *
 * ── What is modelled ──────────────────────────────────────────────
 * One JUDGE CALL is a draw from {tie, pending, current}:
 *
 *     P(tie)     = tieRate
 *     P(pending) = (1 - tieRate) · clamp01(winRate ± bias)
 *
 * `bias` is the systematic, DIRECTIONAL handicap on the pending — position
 * bias plus the status-quo pull of an explicit CURRENT/PENDING label. It is
 * signed by presentation order: `+bias` when the pending is shown first,
 * `-bias` when it is shown second. This is the term the original sweep did not
 * have; it assumed judge error was symmetric noise, which a directional bias
 * is not.
 *
 * Two judging PROTOCOLS turn calls into one recorded trial:
 *
 *   single    — the pre-fix protocol. One call, the incumbent pinned to
 *               "Response A" and labelled CURRENT, so the bias is a constant
 *               handicap on the pending, every trial, forever.
 *   doubleWin — the current protocol (scaffold/auto-judge.ts). Neutral labels,
 *               randomized order, TWO calls with the orders swapped; a
 *               candidate takes the trial only by winning both, and a flip is
 *               recorded as a tie.
 *
 * `agreement` is how consistent one judge is with itself on identical content:
 * with probability `agreement` the two calls of a trial share their random
 * variate (so they can only differ where the ±bias band moved the threshold —
 * i.e. exactly the order-driven verdicts the double-win rule is built to
 * catch), otherwise the second call is an independent redraw. agreement=1 is
 * the ideal instrument, agreement=0 a memoryless judge — the pessimistic bound
 * for the tie rate, and therefore for P(promote).
 *
 * ── Faithfulness fix ──────────────────────────────────────────────
 * The earlier simulator stopped after maxTrials and scored the leftover as a
 * rollback, on the assumption that the ceiling always forces a decision. It
 * does not: decidePromotion returns 'continue' whenever there are ZERO
 * decisive trials, whatever trialsSoFar says, and production simply keeps
 * evaluating. Rollouts here therefore run to HORIZON trials and report
 * `unresolved` separately — a category the double-win rule makes materially
 * more likely, and one that the "12 trials and it's settled" reading hid.
 *
 * NOTE: doc edited & maintained by Claude, presented as-is.
 */

import {
  decidePromotion,
  DEFAULT_SHADOW_CONFIG,
  type PendingScaffold,
  type ShadowConfig,
} from '../packages/core/src/index';

// ── Reproducible RNG (mulberry32) ──────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Judge model ────────────────────────────────────────────────────

type Verdict = 'pending' | 'current' | 'tie';

interface JudgeWorld {
  /** P(judge names the pending | decisive, no positional bias). */
  winRate: number;
  /** P(one call comes back a tie). */
  tieRate: number;
  /** Directional handicap on the pending, in probability points. */
  bias: number;
  /** P(the two calls of a trial share their variate). */
  agreement: number;
}

/** One judge call's verdict from a uniform variate. */
function callVerdict(u: number, world: JudgeWorld, pendingFirst: boolean): Verdict {
  if (u < world.tieRate) return 'tie';
  const shifted = world.winRate + (pendingFirst ? world.bias : -world.bias);
  const pPending = Math.min(1, Math.max(0, shifted));
  return u < world.tieRate + (1 - world.tieRate) * pPending ? 'pending' : 'current';
}

type Protocol = 'single' | 'doubleWin';

/** One recorded trial under the given protocol. */
function sampleTrial(protocol: Protocol, world: JudgeWorld, rng: () => number): Verdict {
  if (protocol === 'single') {
    // The pending is always second, and always labelled PENDING.
    return callVerdict(rng(), world, false);
  }
  const pendingFirst = rng() < 0.5;
  const u1 = rng();
  const u2 = rng() < world.agreement ? u1 : rng();
  const first = callVerdict(u1, world, pendingFirst);
  const second = callVerdict(u2, world, !pendingFirst);
  return first === second && first !== 'tie' ? first : 'tie';
}

// ── Rollouts ───────────────────────────────────────────────────────

/** Trials a rollout may accumulate before we call it stuck. Well past
 *  maxTrials=12; a pending still undecided here is not going to resolve. */
const HORIZON = 100;

type Outcome = 'promote' | 'rollback' | 'unresolved';

function simulateOnce(
  protocol: Protocol,
  world: JudgeWorld,
  config: ShadowConfig,
  rng: () => number,
): Outcome {
  let pendingWins = 0, currentWins = 0, ties = 0;
  for (let t = 1; t <= HORIZON; t++) {
    const verdict = sampleTrial(protocol, world, rng);
    if (verdict === 'pending') pendingWins++;
    else if (verdict === 'current') currentWins++;
    else ties++;
    const pending: PendingScaffold = {
      version: 1, writtenAt: 0, rationale: '',
      trialsSoFar: pendingWins + currentWins + ties,
      pendingWins, currentWins, ties,
    };
    const { decision } = decidePromotion(pending, config);
    if (decision !== 'continue') return decision;
  }
  return 'unresolved';
}

interface Rates { promote: number; rollback: number; unresolved: number }

function rollout(
  protocol: Protocol,
  world: JudgeWorld,
  config: ShadowConfig,
  sims: number,
  seed: number,
): Rates {
  const rng = mulberry32(seed);
  let promote = 0, rollback = 0, unresolved = 0;
  for (let i = 0; i < sims; i++) {
    const outcome = simulateOnce(protocol, world, config, rng);
    if (outcome === 'promote') promote++;
    else if (outcome === 'rollback') rollback++;
    else unresolved++;
  }
  return { promote: promote / sims, rollback: rollback / sims, unresolved: unresolved / sims };
}

/** The trial-level distribution a protocol induces — the input the promotion
 *  rule actually sees, as opposed to the per-call parameters. */
function trialStats(protocol: Protocol, world: JudgeWorld, sims: number, seed: number) {
  const rng = mulberry32(seed);
  let pending = 0, current = 0, ties = 0;
  for (let i = 0; i < sims; i++) {
    const v = sampleTrial(protocol, world, rng);
    if (v === 'pending') pending++;
    else if (v === 'current') current++;
    else ties++;
  }
  const decisive = pending + current;
  return { tieRate: ties / sims, winRate: decisive === 0 ? 0.5 : pending / decisive };
}

// ── Sweep parameters ───────────────────────────────────────────────
const WIN_RATES = [0.55, 0.6, 0.7, 0.8];
const TIE_RATES = [0.3, 0.5, 0.7];
const MAX_REGRESSIONS = [0, 1, 2];
const MIN_DECISIVE = [3, 5];
const SIMS = 200_000;
const BASE_SEED = 0x5eed;

/** Headline operating point: 10pp of directional bias (the low end of the
 *  10-25pp the self-preference / position-bias literature reports) and a judge
 *  that is content-consistent half the time. */
const HEADLINE_BIAS = 0.10;
const HEADLINE_AGREEMENT = 0.5;

const pct = (x: number) => (x * 100).toFixed(1).padStart(5);
let seed = BASE_SEED;

const world = (winRate: number, tieRate: number, bias: number, agreement: number): JudgeWorld =>
  ({ winRate, tieRate, bias, agreement });

console.log(`Shadow-veto Monte Carlo — ${SIMS.toLocaleString()} sims/cell`);
console.log(`Fixed: minTrials=${DEFAULT_SHADOW_CONFIG.minTrials} maxTrials=${DEFAULT_SHADOW_CONFIG.maxTrials} ` +
  `promote≥${DEFAULT_SHADOW_CONFIG.promoteThreshold} rollback≤${DEFAULT_SHADOW_CONFIG.rollbackThreshold} ` +
  `horizon=${HORIZON}`);
console.log(`Judge world: bias=${HEADLINE_BIAS} agreement=${HEADLINE_AGREEMENT}\n`);

// ── 1. What each protocol does to the trial distribution ───────────
console.log('1. INDUCED TRIAL DISTRIBUTION (per-call win/tie → recorded trial win/tie)');
console.log('win%  tie%  │ single: tie%  win%  │ doubleWin: tie%  win%');
console.log('─'.repeat(66));
for (const winRate of WIN_RATES) {
  for (const tieRate of TIE_RATES) {
    const w = world(winRate, tieRate, HEADLINE_BIAS, HEADLINE_AGREEMENT);
    const single = trialStats('single', w, SIMS, seed++);
    const dbl = trialStats('doubleWin', w, SIMS, seed++);
    console.log(
      `${pct(winRate)} ${pct(tieRate)}  │        ${pct(single.tieRate)} ${pct(single.winRate)}  │` +
      `           ${pct(dbl.tieRate)} ${pct(dbl.winRate)}`,
    );
  }
}

// ── 2. Config frontier under each protocol ─────────────────────────
// Objective and bars are unchanged from the original calibration. STRICT bar:
// worst-case P(promote worse) over ALL worse worlds < 5% — unattainable in
// principle at this trial budget (telling a 45%-win variant from a 55% one to
// <5% error needs hundreds of decisive trials). OPERATIONAL bar: < 5% against
// CLEARLY-worse variants (true win ≤ 0.30) at tie rates ≤ 0.5, maximizing mean
// P(promote better). Near-coin-flip variants are indistinguishable at this
// budget AND low-harm — they are ≈ the incumbent, and every promotion stays
// revertable from the Evolution Changelog.
interface Agg {
  protocol: Protocol; maxRegressions: number; minDecisiveTrials: number;
  meanBetter: number; worstWorseAll: number; worstWorseClear: number;
  worstUnresolved: number;
}

function sweep(protocol: Protocol, bias: number, agreement: number, maxTrials = 12): Agg[] {
  const aggs: Agg[] = [];
  for (const maxRegressions of MAX_REGRESSIONS) {
    for (const minDecisiveTrials of MIN_DECISIVE) {
      const config: ShadowConfig = { ...DEFAULT_SHADOW_CONFIG, maxRegressions, minDecisiveTrials, maxTrials };
      const better: number[] = [], worseAll: number[] = [], worseClear: number[] = [];
      let worstUnresolved = 0;
      for (const winRate of WIN_RATES) {
        for (const tieRate of TIE_RATES) {
          const good = rollout(protocol, world(winRate, tieRate, bias, agreement), config, SIMS, seed++);
          const bad = rollout(protocol, world(1 - winRate, tieRate, bias, agreement), config, SIMS, seed++);
          better.push(good.promote);
          worseAll.push(bad.promote);
          if (winRate >= 0.7 && tieRate <= 0.5) worseClear.push(bad.promote);
          worstUnresolved = Math.max(worstUnresolved, good.unresolved, bad.unresolved);
        }
      }
      aggs.push({
        protocol, maxRegressions, minDecisiveTrials,
        meanBetter: better.reduce((s, x) => s + x, 0) / better.length,
        worstWorseAll: Math.max(...worseAll),
        worstWorseClear: Math.max(...worseClear),
        worstUnresolved,
      });
    }
  }
  return aggs;
}

function report(label: string, aggs: Agg[]): Agg | undefined {
  console.log(`\n2. CONFIG AGGREGATES — ${label}`);
  console.log('maxReg  minDec  mean P(better)  worst P(worse) ALL  worst P(worse≤0.3,tie≤0.5)  worst unresolved');
  console.log('─'.repeat(100));
  for (const a of aggs) {
    console.log(
      `${String(a.maxRegressions).padStart(4)}  ${String(a.minDecisiveTrials).padStart(6)}  ` +
      `${pct(a.meanBetter)}%         ${pct(a.worstWorseAll)}%              ${pct(a.worstWorseClear)}%` +
      `                      ${pct(a.worstUnresolved)}%`,
    );
  }
  const strict = aggs.filter(a => a.worstWorseAll < 0.05);
  console.log(`Strict frontier (<5% vs ALL worse worlds): ${strict.length === 0
    ? 'EMPTY — unattainable at this trial budget (see the bars above)'
    : strict.map(a => `(${a.maxRegressions},${a.minDecisiveTrials})`).join(' ')}`);
  const feasible = [...aggs].filter(a => a.worstWorseClear < 0.05).sort((a, b) => b.meanBetter - a.meanBetter);
  const best = feasible[0];
  console.log('OPERATIONAL FRONTIER (<5% vs clearly-worse at tie≤0.5, max true-promotion):');
  if (best) {
    console.log(`  maxRegressions=${best.maxRegressions}, minDecisiveTrials=${best.minDecisiveTrials}  ` +
      `mean P(better)=${pct(best.meanBetter)}%  worst P(clearly-worse)=${pct(best.worstWorseClear)}%  ` +
      `worst P(any-worse)=${pct(best.worstWorseAll)}%`);
  } else {
    console.log('  none met the bar — tighten thresholds.');
  }
  return best;
}

// Unbiased single-call world = the model the ORIGINAL calibration used. Kept
// so the constants in DEFAULT_SHADOW_CONFIG stay reproducible from this file.
const sweep0Best = report('single call, bias=0, maxTrials=12 (the original calibration)',
  sweep('single', 0, HEADLINE_AGREEMENT));
const singleBest = report(`single call, bias=${HEADLINE_BIAS}, maxTrials=12 (what production actually ran)`,
  sweep('single', HEADLINE_BIAS, HEADLINE_AGREEMENT));
const doubleBest = report(`order-swapped double-win, bias=${HEADLINE_BIAS}, maxTrials=12 (old budget)`,
  sweep('doubleWin', HEADLINE_BIAS, HEADLINE_AGREEMENT));

// ── 3. Sensitivity of the SHIPPING config to bias and judge consistency ──
console.log('\n3. SHIPPING CONFIG SENSITIVITY ' +
  `(maxRegressions=${DEFAULT_SHADOW_CONFIG.maxRegressions}, minDecisiveTrials=${DEFAULT_SHADOW_CONFIG.minDecisiveTrials})`);
console.log('Flagship world: true win-rate 0.70 / per-call tie-rate 0.50, and its 0.30 mirror.');
console.log('bias  agree │ single: P(better) P(worse) │ doubleWin: P(better) P(worse) unresolved');
console.log('─'.repeat(88));
for (const bias of [0, 0.05, 0.10, 0.15, 0.25]) {
  for (const agreement of [1.0, 0.5, 0.0]) {
    const good = (p: Protocol) => rollout(p, world(0.7, 0.5, bias, agreement), DEFAULT_SHADOW_CONFIG, SIMS, seed++);
    const bad = (p: Protocol) => rollout(p, world(0.3, 0.5, bias, agreement), DEFAULT_SHADOW_CONFIG, SIMS, seed++);
    const s = { good: good('single'), bad: bad('single') };
    const d = { good: good('doubleWin'), bad: bad('doubleWin') };
    console.log(
      `${bias.toFixed(2)}  ${agreement.toFixed(2)} │      ${pct(s.good.promote)}%  ${pct(s.bad.promote)}% │` +
      `         ${pct(d.good.promote)}%  ${pct(d.bad.promote)}%     ${pct(d.good.unresolved)}%`,
    );
  }
}

// ── 4. Rescaling the trial budget for the new tie rate ─────────────
// maxTrials is a budget in TRIALS, but the only informative trials are the
// decisive ones, and the double-win rule roughly halves how many of those a
// given number of turns yields. Everything the ceiling protects against gets
// worse when the ceiling fires early on two or three decisive trials — that is
// the documented residual leak (the forced decision promotes on a bare >0.5
// majority and does NOT consult minDecisiveTrials). So sweep the budget.
console.log('\n4. TRIAL-BUDGET RESCALING under the double-win protocol ' +
  `(maxRegressions=${DEFAULT_SHADOW_CONFIG.maxRegressions}, minDecisiveTrials=${DEFAULT_SHADOW_CONFIG.minDecisiveTrials})`);
console.log('maxTrials  mean P(better)  worst P(worse) ALL  worst P(worse≤0.3,tie≤0.5)  worst unresolved');
console.log('─'.repeat(94));
for (const maxTrials of [12, 16, 20, 24, 30, 40]) {
  const config: ShadowConfig = { ...DEFAULT_SHADOW_CONFIG, maxTrials };
  const better: number[] = [], worseAll: number[] = [], worseClear: number[] = [];
  let worstUnresolved = 0;
  for (const winRate of WIN_RATES) {
    for (const tieRate of TIE_RATES) {
      const w = (x: number) => world(x, tieRate, HEADLINE_BIAS, HEADLINE_AGREEMENT);
      const good = rollout('doubleWin', w(winRate), config, SIMS, seed++);
      const bad = rollout('doubleWin', w(1 - winRate), config, SIMS, seed++);
      better.push(good.promote);
      worseAll.push(bad.promote);
      if (winRate >= 0.7 && tieRate <= 0.5) worseClear.push(bad.promote);
      worstUnresolved = Math.max(worstUnresolved, good.unresolved, bad.unresolved);
    }
  }
  console.log(
    `${String(maxTrials).padStart(7)}    ${pct(better.reduce((s, x) => s + x, 0) / better.length)}%` +
    `         ${pct(Math.max(...worseAll))}%              ${pct(Math.max(...worseClear))}%` +
    `                      ${pct(worstUnresolved)}%`,
  );
}

// ── 5. The frontier at the rescaled budget ─────────────────────────
const rescaledBest = report(
  `order-swapped double-win, bias=${HEADLINE_BIAS}, maxTrials=${DEFAULT_SHADOW_CONFIG.maxTrials} (SHIPPING)`,
  sweep('doubleWin', HEADLINE_BIAS, HEADLINE_AGREEMENT, DEFAULT_SHADOW_CONFIG.maxTrials),
);

console.log('\nSUMMARY');
console.log(`  original calibration  (single call, bias=0,   maxTrials=12): frontier ` +
  `(${sweep0Best?.maxRegressions},${sweep0Best?.minDecisiveTrials})`);
console.log(`  what production ran   (single call, bias=${HEADLINE_BIAS}, maxTrials=12): frontier ` +
  `(${singleBest?.maxRegressions},${singleBest?.minDecisiveTrials})`);
console.log(`  double-win, old budget (maxTrials=12):                      frontier ` +
  `(${doubleBest?.maxRegressions},${doubleBest?.minDecisiveTrials})  ← breaks the 5% bar at (1,5)`);
console.log(`  double-win, rescaled   (maxTrials=${DEFAULT_SHADOW_CONFIG.maxTrials}):                      frontier ` +
  `(${rescaledBest?.maxRegressions},${rescaledBest?.minDecisiveTrials})`);
console.log(`  shipping DEFAULT_SHADOW_CONFIG: maxRegressions=${DEFAULT_SHADOW_CONFIG.maxRegressions}, ` +
  `minDecisiveTrials=${DEFAULT_SHADOW_CONFIG.minDecisiveTrials}, maxTrials=${DEFAULT_SHADOW_CONFIG.maxTrials}`);

// ── 6. The promote/rollback BAND, which nothing above ever swept ────
// Sections 2, 4 and 5 sweep maxRegressions, minDecisiveTrials and maxTrials.
// `promoteThreshold` and `rollbackThreshold` came from DEFAULT_SHADOW_CONFIG in
// every one of those cells and were printed as "Fixed" — so the docblock over
// DEFAULT_SHADOW_CONFIG read as though all four numbers had been calibrated
// together when two of them were assumptions the sweep was conditioned on. They
// gate promotion of a self-modified scaffold into the live path, so they get the
// same treatment under the same bar and at the shipping operating point.
//
// Bands are symmetric around the 0.5 coin flip. An asymmetric band would encode
// a preference for the incumbent, which is a policy choice this simulator has no
// way to price, so it is not swept here — stating the omission rather than
// inventing a rationale for one.
const PROMOTE_BANDS: ReadonlyArray<readonly [number, number]> =
  [[0.55, 0.45], [0.60, 0.40], [0.65, 0.35], [0.70, 0.30]];

console.log('\n6. PROMOTE/ROLLBACK BAND at the shipping operating point ' +
  `(doubleWin, bias=${HEADLINE_BIAS}, maxRegressions=${DEFAULT_SHADOW_CONFIG.maxRegressions}, ` +
  `minDecisiveTrials=${DEFAULT_SHADOW_CONFIG.minDecisiveTrials}, maxTrials=${DEFAULT_SHADOW_CONFIG.maxTrials})`);
console.log('promote≥ rollback≤  mean P(better)  worst P(worse) ALL  worst P(worse≤0.3,tie≤0.5)  worst unresolved');
console.log('─'.repeat(104));
const bandRows: Array<{ promote: number; rollback: number; meanBetter: number; worstClear: number; worstAll: number }> = [];
for (const [promoteThreshold, rollbackThreshold] of PROMOTE_BANDS) {
  const config: ShadowConfig = { ...DEFAULT_SHADOW_CONFIG, promoteThreshold, rollbackThreshold };
  const better: number[] = [], worseAll: number[] = [], worseClear: number[] = [];
  let worstUnresolved = 0;
  for (const winRate of WIN_RATES) {
    for (const tieRate of TIE_RATES) {
      const w = (x: number) => world(x, tieRate, HEADLINE_BIAS, HEADLINE_AGREEMENT);
      const good = rollout('doubleWin', w(winRate), config, SIMS, seed++);
      const bad = rollout('doubleWin', w(1 - winRate), config, SIMS, seed++);
      better.push(good.promote);
      worseAll.push(bad.promote);
      if (winRate >= 0.7 && tieRate <= 0.5) worseClear.push(bad.promote);
      worstUnresolved = Math.max(worstUnresolved, good.unresolved, bad.unresolved);
    }
  }
  const row = {
    promote: promoteThreshold, rollback: rollbackThreshold,
    meanBetter: better.reduce((s, x) => s + x, 0) / better.length,
    worstClear: Math.max(...worseClear), worstAll: Math.max(...worseAll),
  };
  bandRows.push(row);
  console.log(
    `${promoteThreshold.toFixed(2).padStart(7)} ${rollbackThreshold.toFixed(2).padStart(9)}   ` +
    `${pct(row.meanBetter)}%         ${pct(row.worstAll)}%              ${pct(row.worstClear)}%` +
    `                      ${pct(worstUnresolved)}%`,
  );
}
const bandBest = [...bandRows].filter(r => r.worstClear < 0.05).sort((a, b) => b.meanBetter - a.meanBetter)[0];
console.log('OPERATIONAL FRONTIER over the band (<5% vs clearly-worse at tie≤0.5, max true-promotion):');
console.log(bandBest
  ? `  promote≥${bandBest.promote.toFixed(2)}, rollback≤${bandBest.rollback.toFixed(2)}  ` +
    `mean P(better)=${pct(bandBest.meanBetter)}%  worst P(clearly-worse)=${pct(bandBest.worstClear)}%`
  : '  none met the bar over the swept bands');
console.log(`  shipping band: promote≥${DEFAULT_SHADOW_CONFIG.promoteThreshold}, ` +
  `rollback≤${DEFAULT_SHADOW_CONFIG.rollbackThreshold}`);
