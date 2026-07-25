// Bench report shapes + the acceptance rule. Pure — no LLM, no IO.
//
// Two reports: the paired variant comparison (B1) and the stateful-vs-stateless
// gain (Tier 3). Both are built from machine-computed outcomes and both are
// designed to be able to say "nothing here" — a harness that can only produce
// good news measures nothing.
import { fnv1a64 } from '../prompting/volatile-context.js';
import { computeGain, fmtPp, pairedBinaryComparison } from './stats.js';
import type { BootstrapOptions, GainStats, PairedBinaryStats, PairedOutcome } from './stats.js';
import type { SealedScorecard } from './split.js';
import type { AttemptBudget, AttemptOutcome, BudgetBreach } from './types.js';

export interface BenchRunConfig {
  corpus: string;
  budget: AttemptBudget;
  seed: number;
  variantA: string;
  variantB: string;
  /** Digest of the whole task corpus — both splits. */
  manifestHash: string;
}

/** Two runs are comparable only when this matches. Budget is part of it, so a
 *  variant cannot win by quietly being given a bigger compute envelope. */
export function benchConfigHash(config: BenchRunConfig): string {
  return fnv1a64(JSON.stringify([
    config.corpus, config.budget.wallClockMs, config.budget.maxTokens,
    config.seed, config.variantA, config.variantB, config.manifestHash,
  ]));
}

export interface BenchCaseScore {
  taskId: string;
  passedA: boolean;
  passedB: boolean;
  durationMsA: number;
  durationMsB: number;
  tokensA: number;
  tokensB: number;
  breachA: BudgetBreach | null;
  breachB: BudgetBreach | null;
  errorA?: string;
  errorB?: string;
}

export interface DevSplitReport {
  tasks: number;
  stats: PairedBinaryStats;
  /** Per-task detail, permitted here and ONLY here: the dev split is the one
   *  adaptation may look at. */
  cases: BenchCaseScore[];
}

export interface BenchReport {
  ranAt: number;
  runId: string;
  config: BenchRunConfig;
  configHash: string;
  dev: DevSplitReport;
  /** Aggregates only, by construction. null when the seal was not opened. */
  sealed: SealedScorecard | null;
  /** How many times this seal has been opened, ever, per the ledger. High
   *  counts mean the held-out set has been peeked at and is losing its value. */
  sealAccessOrdinal: number | null;
  budgetBreaches: number;
  decision: BenchDecision;
  headline: string;
}

export interface BenchDecision {
  accept: boolean;
  reason: string;
  /** Present when the result is significant but the design is underpowered for
   *  effects that size. The finding stands; the magnitude is probably inflated. */
  caveat?: string;
}

/** Rejection by default. A variant is kept only when the HELD-OUT number
 *  improves and an exact paired test says so. Anything else — no seal, a
 *  dev-only win, a split too small to produce evidence at all — is a rejection.
 *
 *  Power deliberately does NOT gate acceptance. The exact test is correctly
 *  sized at any n, so a significant result is a significant result; what low
 *  power costs is the effect ESTIMATE, which gets exaggerated. That is a caveat
 *  on the magnitude, not grounds to discard the finding — and gating on the
 *  normal-approximation MDE would be unsatisfiable on small corpora, where the
 *  threshold can exceed the 100pp an effect can physically reach. */
export function decideBenchOutcome(sealed: SealedScorecard | null): BenchDecision {
  if (!sealed) return { accept: false, reason: 'no held-out measurement — dev-split results alone never justify keeping a variant' };
  const s = sealed.stats;
  if (s.pairs === 0) return { accept: false, reason: 'held-out split was empty' };
  if (!s.canReachSignificance) {
    return { accept: false, reason: `the held-out split has only ${s.pairs} tasks — no result on it can reach p ≤ ${s.alpha} (best possible ${s.floorPValue.toFixed(4)}), so it cannot accept anything; grow the corpus` };
  }
  if (s.discordant === 0) return { accept: false, reason: `variants never disagreed on ${s.pairs} held-out tasks — no evidence either way` };
  if (s.effect <= 0) return { accept: false, reason: `held-out effect ${fmtPp(s.effect)} is not an improvement` };
  if (!s.significant) return { accept: false, reason: `held-out effect ${fmtPp(s.effect)} is not significant (p=${s.pValue.toFixed(4)})` };
  return {
    accept: true,
    reason: `held-out effect ${fmtPp(s.effect)} is significant (exact McNemar p=${s.pValue.toFixed(4)})`,
    ...(s.resolvable ? {} : {
      caveat: `the design has 80% power only for effects ≥ ${fmtPp(s.mde)}, so ${fmtPp(s.effect)} is very likely an overestimate — ${s.pairsNeededForObserved} pairs would pin the magnitude down`,
    }),
  };
}

export interface BuildBenchReportInput {
  runId: string;
  config: BenchRunConfig;
  /** Attempts on the dev split, both variants. */
  devAttempts: readonly AttemptOutcome[];
  sealed: SealedScorecard | null;
  sealAccessOrdinal: number | null;
  ranAt?: number;
  bootstrap?: BootstrapOptions;
}

export function buildBenchReport(input: BuildBenchReportInput): BenchReport {
  const { config } = input;
  const byTask = new Map<string, { a?: AttemptOutcome; b?: AttemptOutcome }>();
  for (const attempt of input.devAttempts) {
    const entry = byTask.get(attempt.taskId) ?? {};
    if (attempt.variantId === config.variantA) entry.a = attempt;
    else if (attempt.variantId === config.variantB) entry.b = attempt;
    else throw new Error(`attempt for unknown variant "${attempt.variantId}" on task ${attempt.taskId}`);
    byTask.set(attempt.taskId, entry);
  }

  const cases: BenchCaseScore[] = [];
  const outcomes: PairedOutcome[] = [];
  let budgetBreaches = 0;
  for (const [taskId, { a, b }] of byTask) {
    if (!a || !b) throw new Error(`unpaired task ${taskId}: a paired design cannot drop half a pair`);
    if (a.budgetBreach) budgetBreaches++;
    if (b.budgetBreach) budgetBreaches++;
    cases.push({
      taskId,
      passedA: a.passed, passedB: b.passed,
      durationMsA: a.durationMs, durationMsB: b.durationMs,
      tokensA: a.tokens, tokensB: b.tokens,
      breachA: a.budgetBreach, breachB: b.budgetBreach,
      ...(a.error ? { errorA: a.error } : {}),
      ...(b.error ? { errorB: b.error } : {}),
    });
    outcomes.push({ taskId, a: a.passed, b: b.passed });
  }
  cases.sort((x, y) => x.taskId.localeCompare(y.taskId));

  const stats = pairedBinaryComparison(outcomes, { seed: config.seed, ...input.bootstrap });
  const decision = decideBenchOutcome(input.sealed);
  const sealedStats = input.sealed?.stats;
  return {
    ranAt: input.ranAt ?? Date.now(),
    runId: input.runId,
    config,
    configHash: benchConfigHash(config),
    dev: { tasks: outcomes.length, stats, cases },
    sealed: input.sealed,
    sealAccessOrdinal: input.sealAccessOrdinal,
    budgetBreaches,
    decision,
    headline: sealedStats
      ? `held-out ${fmtPp(sealedStats.effect)} (${sealedStats.verdict})`
      : `dev-only ${fmtPp(stats.effect)} — no held-out measurement`,
  };
}

export function renderBenchSummary(report: BenchReport): string {
  const { config, dev } = report;
  const lines: string[] = [];
  lines.push(`Bench: ${config.variantB} (candidate) vs ${config.variantA} (baseline)`);
  lines.push(`Corpus: ${config.corpus}  manifest=${config.manifestHash}  config=${report.configHash}  seed=${config.seed}`);
  lines.push(`Budget: ${config.budget.wallClockMs}ms wall-clock, ${config.budget.maxTokens} tokens per attempt` +
    (report.budgetBreaches > 0 ? `  (${report.budgetBreaches} attempt(s) hit the budget)` : ''));
  lines.push('');
  lines.push(`DEV split (${dev.tasks} paired tasks) — adaptation may see this`);
  lines.push(renderPairedStats(dev.stats));
  for (const c of dev.cases) {
    const mark = (p: boolean, breach: BudgetBreach | null) => `${p ? 'pass' : 'FAIL'}${breach ? `(${breach})` : ''}`;
    lines.push(`  ${c.taskId.padEnd(28)} A=${mark(c.passedA, c.breachA).padEnd(14)} B=${mark(c.passedB, c.breachB)}`);
  }
  lines.push('');
  if (report.sealed) {
    lines.push(`SEALED split (${report.sealed.tasks} paired tasks) — aggregates only, opened ${report.sealAccessOrdinal ?? '?'} time(s)`);
    lines.push(renderPairedStats(report.sealed.stats));
  } else {
    lines.push('SEALED split: not opened');
  }
  lines.push('');
  lines.push(`DECISION: ${report.decision.accept ? 'KEEP' : 'REJECT'} — ${report.decision.reason}`);
  if (report.decision.caveat) lines.push(`  caveat: ${report.decision.caveat}`);
  return lines.join('\n');
}

function renderPairedStats(s: PairedBinaryStats): string {
  return [
    `  pass A=${(s.passRateA * 100).toFixed(1)}%  B=${(s.passRateB * 100).toFixed(1)}%  effect=${fmtPp(s.effect)}` +
      `  95% CI [${fmtPp(s.ci.lo)}, ${fmtPp(s.ci.hi)}]`,
    `  McNemar exact p=${s.pValue.toFixed(4)}  (b=${s.onlyA} only-A, c=${s.onlyB} only-B, ${s.discordant}/${s.pairs} discordant)`,
    `  detectable at this n: ${fmtPp(s.mde)}  resolution=${s.resolutionRatio.toFixed(2)}x` +
      `  → ${s.verdict}`,
  ].join('\n');
}

export interface GainTaskScore {
  taskId: string;
  /** Position in the sequence — the learning curve's x axis. */
  index: number;
  stateful: number;
  stateless: number;
}

export interface GainReport {
  ranAt: number;
  runId: string;
  config: BenchRunConfig;
  configHash: string;
  /** Task order, identical for both arms. */
  sequence: string[];
  perTask: GainTaskScore[];
  stats: GainStats;
  /** Published reference points, so a number is read against something. */
  calibration: string;
  headline: string;
}

/** CL-Bench's leaderboard, for honest expectation-setting: the leader reaches
 *  22.3% normalized reward and 25.4% gain, and purpose-built memory systems
 *  there lose to naive in-context learning. A gain near zero is a normal,
 *  reportable outcome — not a harness bug. */
export const GAIN_CALIBRATION =
  'CL-Bench reference: leader 22.3% normalized reward / 25.4% gain; dedicated memory systems there underperform naive in-context learning. Near-zero gain is a real result.';

export interface BuildGainReportInput {
  runId: string;
  config: BenchRunConfig;
  perTask: readonly GainTaskScore[];
  ranAt?: number;
  bootstrap?: BootstrapOptions;
}

export function buildGainReport(input: BuildGainReportInput): GainReport {
  const perTask = [...input.perTask].sort((a, b) => a.index - b.index);
  const stats = computeGain(perTask, { seed: input.config.seed, ...input.bootstrap });
  return {
    ranAt: input.ranAt ?? Date.now(),
    runId: input.runId,
    config: input.config,
    configHash: benchConfigHash(input.config),
    sequence: perTask.map((t) => t.taskId),
    perTask,
    stats,
    calibration: GAIN_CALIBRATION,
    headline: stats.verdict,
  };
}

export function renderGainSummary(report: GainReport): string {
  const s = report.stats;
  const lines: string[] = [];
  lines.push(`Gain: stateful (${report.config.variantB}) vs stateless (${report.config.variantA})`);
  lines.push(`Corpus: ${report.config.corpus}  manifest=${report.config.manifestHash}  config=${report.configHash}`);
  lines.push(`Budget: ${report.config.budget.wallClockMs}ms wall-clock, ${report.config.budget.maxTokens} tokens per attempt`);
  lines.push('');
  lines.push(`Tasks: ${s.tasks} (identical sequence, both arms)`);
  lines.push(`  stateful reward  ${(s.statefulReward * 100).toFixed(1)}%`);
  lines.push(`  stateless reward ${(s.statelessReward * 100).toFixed(1)}%`);
  lines.push(`  gain ${fmtPp(s.gain)}  95% CI [${fmtPp(s.ci.lo)}, ${fmtPp(s.ci.hi)}]  p=${s.pValue.toFixed(4)}`);
  lines.push(`  normalized gain ${s.normalizedGain === null ? 'undefined (no headroom)' : `${(s.normalizedGain * 100).toFixed(1)}% of headroom`}`);
  lines.push('');
  lines.push('  seq  task                          stateless  stateful');
  for (const t of report.perTask) {
    lines.push(`  ${String(t.index).padStart(3)}  ${t.taskId.padEnd(28)}  ${t.stateless.toFixed(2).padStart(9)}  ${t.stateful.toFixed(2).padStart(8)}`);
  }
  lines.push('');
  lines.push(`VERDICT: ${s.verdict}`);
  lines.push(report.calibration);
  return lines.join('\n');
}
