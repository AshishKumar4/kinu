/**
 * Shadow-promotion veto — binomial Monte Carlo (FORMAL-RIGOR-PLAN Part 3).
 *
 * The scaffold self-evolution loop promotes a "pending" variant over the live
 * one only if it wins enough shadow trials under the rule in
 * `packages/core/src/scaffold/shadow.ts` (decidePromotion). The default
 * `maxRegressions: 0` means a SINGLE decisive loss rolls the pending back —
 * suspected of rejecting genuinely-better variants under judge noise. This
 * script settles the constant with a pure simulation (NO LLM calls): it draws
 * trial outcomes from a binomial world and applies the REAL decidePromotion
 * rule (imported, not reimplemented) exactly as production does — one recorded
 * trial at a time, first promote/rollback is terminal (mirrors
 * runAutoShadowEval in scaffold/auto-judge.ts).
 *
 * Sweep: true win-rate {0.55,0.6,0.7,0.8} × tie-rate {0.3,0.5,0.7}
 *        × maxRegressions {0,1,2} × minDecisiveTrials {3,5}.
 * For each cell we report P(promote) for a genuinely-BETTER scaffold (the swept
 * win-rate, >0.5) and for its genuinely-WORSE mirror (1 - win-rate, <0.5). The
 * frontier config keeps false-promotion (worse) < 5% while maximizing
 * true-promotion (better). All other knobs stay at DEFAULT_SHADOW_CONFIG.
 *
 * Run: bun scripts/shadow-veto-monte-carlo.ts
 *
 * NOTE: doc edited & maintained by Claude, presented as-is.
 */

import {
  decidePromotion,
  DEFAULT_SHADOW_CONFIG,
  type PendingScaffold,
  type ShadowConfig,
} from '../packages/core/src/index.js';

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

/**
 * One shadow rollout. Trials arrive one at a time; after each we record it and
 * ask decidePromotion — the FIRST promote/rollback is terminal, exactly like
 * auto-judge's per-trial check. maxTrials forces a decision, so this always
 * returns 'promote' or 'rollback'.
 */
function simulateOnce(
  trueWinRate: number,
  tieRate: number,
  config: ShadowConfig,
  rng: () => number,
): 'promote' | 'rollback' {
  let pendingWins = 0, currentWins = 0, ties = 0;
  for (let t = 1; t <= config.maxTrials; t++) {
    if (rng() < tieRate) {
      ties++;
    } else if (rng() < trueWinRate) {
      pendingWins++;
    } else {
      currentWins++;
    }
    const pending: PendingScaffold = {
      version: 1, writtenAt: 0, rationale: '',
      trialsSoFar: pendingWins + currentWins + ties,
      pendingWins, currentWins, ties,
    };
    const { decision } = decidePromotion(pending, config);
    if (decision !== 'continue') return decision;
  }
  // Unreachable: trialsSoFar hits maxTrials, which forces a decision.
  return 'rollback';
}

function pPromote(
  trueWinRate: number,
  tieRate: number,
  config: ShadowConfig,
  trials: number,
  seed: number,
): number {
  const rng = mulberry32(seed);
  let promotions = 0;
  for (let i = 0; i < trials; i++) {
    if (simulateOnce(trueWinRate, tieRate, config, rng) === 'promote') promotions++;
  }
  return promotions / trials;
}

// ── Sweep ──────────────────────────────────────────────────────────
const WIN_RATES = [0.55, 0.6, 0.7, 0.8];
const TIE_RATES = [0.3, 0.5, 0.7];
const MAX_REGRESSIONS = [0, 1, 2];
const MIN_DECISIVE = [3, 5];
const TRIALS = 200_000;
const BASE_SEED = 0x5eed;

interface Row {
  maxRegressions: number;
  minDecisiveTrials: number;
  winRate: number;
  tieRate: number;
  pBetter: number;   // P(promote | genuinely-better, this win-rate)
  pWorse: number;    // P(promote | genuinely-worse, mirror 1-winRate)
}

const rows: Row[] = [];
let seed = BASE_SEED;
for (const maxRegressions of MAX_REGRESSIONS) {
  for (const minDecisiveTrials of MIN_DECISIVE) {
    for (const winRate of WIN_RATES) {
      for (const tieRate of TIE_RATES) {
        const config: ShadowConfig = { ...DEFAULT_SHADOW_CONFIG, maxRegressions, minDecisiveTrials };
        const pBetter = pPromote(winRate, tieRate, config, TRIALS, seed++);
        const pWorse = pPromote(1 - winRate, tieRate, config, TRIALS, seed++);
        rows.push({ maxRegressions, minDecisiveTrials, winRate, tieRate, pBetter, pWorse });
      }
    }
  }
}

// ── Per-cell table ─────────────────────────────────────────────────
const pct = (x: number) => (x * 100).toFixed(1).padStart(5);
console.log(`Shadow-veto Monte Carlo — ${TRIALS.toLocaleString()} sims/cell`);
console.log(`Fixed: minTrials=${DEFAULT_SHADOW_CONFIG.minTrials} maxTrials=${DEFAULT_SHADOW_CONFIG.maxTrials} ` +
  `promote≥${DEFAULT_SHADOW_CONFIG.promoteThreshold} rollback≤${DEFAULT_SHADOW_CONFIG.rollbackThreshold}\n`);
console.log('maxReg  minDec  win%  tie%  P(promote better)  P(promote WORSE=1-win)');
console.log('─'.repeat(72));
for (const r of rows) {
  console.log(
    `${String(r.maxRegressions).padStart(4)}  ${String(r.minDecisiveTrials).padStart(6)}  ` +
    `${pct(r.winRate)} ${pct(r.tieRate)}  ${pct(r.pBetter)}%           ${pct(r.pWorse)}%`,
  );
}

// ── Frontier: pick (maxRegressions, minDecisiveTrials) ─────────────
// STRICT bar first: worst-case P(promote worse) over ALL worse worlds < 5%.
// This is UNATTAINABLE for every swept config — and unattainable in principle:
// distinguishing a 45%-win variant from a 55% one with <5% error needs
// hundreds of decisive trials, and maxTrials=12 (≈3.6 decisive at tie-rate
// 0.7) can never provide them. The strict bar is a sample-size fact, not a
// config property. The OPERATIONAL bar applies the 5% criterion where it is
// statistically meaningful: clearly-worse variants (true win-rate ≤ 0.30,
// i.e. mirrors of the 0.70/0.80 better worlds) at tie rates ≤ 0.5. Near-
// coin-flip variants (0.45/0.40) are indistinguishable at this trial budget
// AND low-harm (≈ the incumbent, and every promotion stays revertable from
// the Evolution Changelog); the tie-0.7 world decides on ~3-4 decisive
// trials whatever the config. Objective: maximize mean P(promote better)
// over all better worlds.
console.log('\nConfig aggregates:');
console.log('maxReg  minDec  mean P(better)  worst P(worse) ALL  worst P(worse≤0.3, tie≤0.5)');
console.log('─'.repeat(80));
interface Agg {
  maxRegressions: number; minDecisiveTrials: number;
  meanBetter: number; worstWorseAll: number; worstWorseClear: number;
}
const aggs: Agg[] = [];
for (const maxRegressions of MAX_REGRESSIONS) {
  for (const minDecisiveTrials of MIN_DECISIVE) {
    const cell = rows.filter(r => r.maxRegressions === maxRegressions && r.minDecisiveTrials === minDecisiveTrials);
    const meanBetter = cell.reduce((s, r) => s + r.pBetter, 0) / cell.length;
    const worstWorseAll = Math.max(...cell.map(r => r.pWorse));
    const worstWorseClear = Math.max(...cell
      .filter(r => r.winRate >= 0.7 && r.tieRate <= 0.5)
      .map(r => r.pWorse));
    aggs.push({ maxRegressions, minDecisiveTrials, meanBetter, worstWorseAll, worstWorseClear });
  }
}
for (const a of aggs) {
  console.log(
    `${String(a.maxRegressions).padStart(4)}  ${String(a.minDecisiveTrials).padStart(6)}  ` +
    `${pct(a.meanBetter)}%         ${pct(a.worstWorseAll)}%              ${pct(a.worstWorseClear)}%`,
  );
}

const strict = aggs.filter(a => a.worstWorseAll < 0.05);
console.log(`\nStrict frontier (<5% vs ALL worse worlds): ${strict.length === 0
  ? 'EMPTY — unattainable at maxTrials=12 (see comment above)'
  : strict.map(a => `(${a.maxRegressions},${a.minDecisiveTrials})`).join(' ')}`);

const feasible = aggs.filter(a => a.worstWorseClear < 0.05);
feasible.sort((a, b) => b.meanBetter - a.meanBetter);
const best = feasible[0];
console.log('\nOPERATIONAL FRONTIER (<5% vs clearly-worse (win≤0.3) at tie≤0.5, max true-promotion):');
if (best) {
  console.log(`  maxRegressions=${best.maxRegressions}, minDecisiveTrials=${best.minDecisiveTrials}`);
  console.log(`  mean P(promote better)=${(best.meanBetter * 100).toFixed(1)}%  ` +
    `worst P(promote clearly-worse)=${(best.worstWorseClear * 100).toFixed(1)}%  ` +
    `worst P(promote any-worse)=${(best.worstWorseAll * 100).toFixed(1)}%`);
} else {
  console.log('  none met the bar — tighten thresholds.');
}
