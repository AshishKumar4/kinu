// Bench report shapes and the acceptance rule. Pure: no LLM, no IO.
import { fnv1a64 } from '../utils/fnv1a';
import { computeGain, fmtPp, pairedBinaryComparison } from './stats';
import type { BootstrapOptions, GainStats, PairedBinaryStats, PairedOutcome } from './stats';
import type { SealedScorecard } from './split';
import type { AttemptBudget, AttemptOutcome, BudgetBreach } from './types';

export interface BenchRunConfig {
  corpus: string;
  budget: AttemptBudget;
  seed: number;
  variantA: string;
  variantB: string;
  repeats: number;
  /** Digest of both splits. */
  manifestHash: string;
}

/** Two runs are comparable only when this matches; budget and repeats are included. */
export function benchConfigHash(config: BenchRunConfig): string {
  return fnv1a64(JSON.stringify([
    config.corpus, config.budget.wallClockMs, config.budget.maxTokens,
    config.seed, config.variantA, config.variantB, config.repeats, config.manifestHash,
  ]));
}

export interface BenchCaseScore {
  taskId: string;
  attempts: number;
  passesA: number;
  passesB: number;
  /** Per-attempt mean, on the budget's scale. */
  durationMsA: number;
  durationMsB: number;
  /** null when any attempt was unmeasured; never rendered as zero. */
  tokensA: number | null;
  tokensB: number | null;
  /** null when any attempt lacked call evidence; never rendered as zero. */
  modelCallsA: number | null;
  modelCallsB: number | null;
  /** Largest working set either variant reached; null when any attempt was unmeasured. */
  peakPromptTokensA: number | null;
  peakPromptTokensB: number | null;
  breachA: BudgetBreach | null;
  breachB: BudgetBreach | null;
  errorA?: string;
  errorB?: string;
}

/** Repeats disagreed under at least one variant; surfaced, not averaged away. */
export function caseIsUnstable(c: BenchCaseScore): boolean {
  const unstable = (passes: number) => passes > 0 && passes < c.attempts;

  return unstable(c.passesA) || unstable(c.passesB);
}

export interface DevSplitReport {
  tasks: number;
  stats: PairedBinaryStats;
  /** Per-task detail only here: the dev split is the one adaptation may see. */
  cases: BenchCaseScore[];
}

export interface BenchReport {
  ranAt: number;
  runId: string;
  config: BenchRunConfig;
  configHash: string;
  dev: DevSplitReport;
  /** Aggregates only. null when the seal was not opened. */
  sealed: SealedScorecard | null;
  /** Lifetime opens per the ledger; high counts mean the held-out set is spent. */
  sealAccessOrdinal: number | null;
  budgetBreaches: number;
  decision: BenchDecision;
  headline: string;
}

export interface BenchDecision {
  accept: boolean;
  reason: string;
  /** Significant but underpowered: the finding stands, the magnitude is likely inflated. */
  caveat?: string;
}

/** Rejection by default: kept only when the held-out number improves under an
 *  exact paired test. Power does not gate acceptance; it only caveats magnitude. */
export function decideBenchOutcome(sealed: SealedScorecard | null): BenchDecision {
  if (!sealed) return { accept: false, reason: 'no held-out measurement — dev-split results alone never justify keeping a variant' };
  const s = sealed.stats;

  if (s.pairs === 0) return { accept: false, reason: 'held-out split was empty' };

  // Checked first: with no differing pair the floor rule would blame the task count.
  if (s.discordant === 0) return { accept: false, reason: `variants never disagreed on ${s.pairs} held-out tasks — no evidence either way` };

  if (!s.canReachSignificance) {
    return { accept: false, reason: `only ${s.discordant} of ${s.pairs} held-out tasks differed between the variants — the smallest p that many differing pairs can produce is ${s.floorPValue.toFixed(4)} > ${s.alpha}, so no outcome here could have accepted anything` };
  }

  if (s.effect <= 0) return { accept: false, reason: `held-out effect ${fmtPp(s.effect)} is not an improvement` };

  if (!s.significant) return { accept: false, reason: `held-out effect ${fmtPp(s.effect)} is not significant (p=${s.pValue.toFixed(4)})` };

  return {
    accept: true,
    reason: `held-out effect ${fmtPp(s.effect)} is significant (exact McNemar p=${s.pValue.toFixed(4)})`,
    caveat: s.resolvable
      ? undefined
      : `the design has 80% power only for effects ≥ ${fmtPp(s.mde)}, so ${fmtPp(s.effect)} is very likely an overestimate — ${s.pairsNeededForObserved} pairs would pin the magnitude down`,
  };
}

export interface BuildBenchReportInput {
  runId: string;
  config: BenchRunConfig;
  devAttempts: readonly AttemptOutcome[];
  sealed: SealedScorecard | null;
  sealAccessOrdinal: number | null;
  ranAt?: number;
  bootstrap?: BootstrapOptions;
}

/** Cost fields are per-attempt means, so rows compare across k. */
function foldRepeats(attempts: readonly AttemptOutcome[]) {
  const n = attempts.length;
  const error = attempts.find((x) => x.error)?.error;
  const calls = attempts.map((attempt) => attempt.modelCalls);
  const tokens = attempts.map((attempt) => attempt.tokens);
  const peaks = attempts.map((attempt) => attempt.peakPromptTokens);

  return {
    passes: attempts.filter((x) => x.passed).length,
    durationMs: Math.round(attempts.reduce((s, x) => s + x.durationMs, 0) / n),
    // One unmeasured repeat makes the row's cost unknown, not smaller.
    tokens: tokens.every((count) => count !== undefined)
      ? Math.round(tokens.reduce((sum, count) => sum + count, 0) / n)
      : null,
    modelCalls: calls.every((count) => count !== undefined)
      ? calls.reduce((sum, count) => sum + count, 0) / n
      : null,
    // A maximum, not a mean: averaged peaks describe no real attempt.
    peakPromptTokens: peaks.every((peak) => peak !== undefined)
      ? peaks.reduce((m, peak) => Math.max(m, peak), 0)
      : null,
    breach: attempts.find((x) => x.budgetBreach)?.budgetBreach ?? null,
    breachCount: attempts.filter((x) => x.budgetBreach).length,
    error,
  };
}

export function buildBenchReport(input: BuildBenchReportInput): BenchReport {
  const { config } = input;
  const byTask = new Map<string, { a: AttemptOutcome[]; b: AttemptOutcome[] }>();
  const seen = new Set<string>();

  for (const attempt of input.devAttempts) {
    const entry = byTask.get(attempt.taskId) ?? { a: [], b: [] };

    if (attempt.variantId === config.variantA) entry.a.push(attempt);
    else if (attempt.variantId === config.variantB) entry.b.push(attempt);
    else throw new Error(`attempt for unknown variant "${attempt.variantId}" on task ${attempt.taskId}`);

    if (!Number.isInteger(attempt.repeat) || attempt.repeat < 0 || attempt.repeat >= config.repeats) {
      throw new Error(`out-of-range repeat ${attempt.repeat} for ${attempt.taskId} (variant ${attempt.variantId}) — expected 0..${config.repeats - 1}`);
    }

    const key = `${attempt.variantId}:${attempt.taskId}:${attempt.repeat}`;
    const slotKey = `${attempt.slot}:${attempt.taskId}:${attempt.repeat}`;

    if (seen.has(key)) throw new Error(`duplicate repeat attempt ${key} (slot ${slotKey})`);
    seen.add(key);
    byTask.set(attempt.taskId, entry);
  }

  const cases: BenchCaseScore[] = [];
  const outcomes: PairedOutcome[] = [];
  let budgetBreaches = 0;

  for (const [taskId, { a, b }] of byTask) {
    if (a.length !== config.repeats || b.length !== config.repeats) {
      throw new Error(`unpaired task ${taskId}: expected ${config.repeats} attempt(s) per variant, got ${a.length} and ${b.length} — a paired design cannot drop half a pair`);
    }

    // Sorted so the report is byte-identical regardless of runner order.
    const byRepeat = (x: AttemptOutcome, y: AttemptOutcome) => x.repeat - y.repeat;
    a.sort(byRepeat);
    b.sort(byRepeat);
    const foldA = foldRepeats(a);
    const foldB = foldRepeats(b);
    budgetBreaches += foldA.breachCount + foldB.breachCount;
    cases.push({
      taskId,
      attempts: config.repeats,
      passesA: foldA.passes, passesB: foldB.passes,
      durationMsA: foldA.durationMs, durationMsB: foldB.durationMs,
      tokensA: foldA.tokens, tokensB: foldB.tokens,
      modelCallsA: foldA.modelCalls, modelCallsB: foldB.modelCalls,
      peakPromptTokensA: foldA.peakPromptTokens, peakPromptTokensB: foldB.peakPromptTokens,
      breachA: foldA.breach, breachB: foldB.breach,
      errorA: foldA.error,
      errorB: foldB.error,
    });
    outcomes.push({ taskId, a: a.map((x) => x.passed), b: b.map((x) => x.passed) });
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
  const k = config.repeats;
  const lines: string[] = [];
  lines.push(`Bench: ${config.variantB} (candidate) vs ${config.variantA} (baseline)`);
  lines.push(`Corpus: ${config.corpus}  manifest=${config.manifestHash}  config=${report.configHash}  seed=${config.seed}`);
  lines.push(`Budget: ${config.budget.wallClockMs}ms wall-clock, ${config.budget.maxTokens} tokens per attempt` +
    (report.budgetBreaches > 0 ? `  (${report.budgetBreaches} attempt(s) hit the budget)` : ''));
  lines.push(`Repeats: ${k} attempt(s) per task per variant`);
  lines.push('');
  lines.push(`DEV split (${dev.tasks} paired tasks) — adaptation may see this`);
  lines.push(renderPairedStats(dev.stats));
  lines.push(renderCost(dev.cases));

  for (const c of dev.cases) lines.push(`  ${renderCase(c)}`);
  lines.push('');
  const unstable = dev.cases.filter(caseIsUnstable);

  if (unstable.length > 0) {
    lines.push(`UNSTABLE on dev (repeats disagreed): ${unstable.length}/${dev.tasks} task(s)`);

    for (const c of unstable) lines.push(`  ${renderCase(c)}`);
    lines.push('');
  } else if (k > 1) {
    lines.push(`UNSTABLE on dev: none — every task agreed across all ${k} repeats`);
    lines.push('');
  }

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

function renderCase(c: BenchCaseScore): string {
  const mark = (passes: number, breach: BudgetBreach | null): string => {
    const suffix = breach ? `(${breach})` : '';

    if (c.attempts === 1) return `${passes === 1 ? 'pass' : 'FAIL'}${suffix}`;

    return `${passes}/${c.attempts}${suffix}`;
  };

  return `${c.taskId.padEnd(28)} A=${mark(c.passesA, c.breachA).padEnd(14)} B=${mark(c.passesB, c.breachB)}` +
    (caseIsUnstable(c) ? '  ~unstable' : '');
}

/** Mean tokens (cost) and peak prompt tokens (working set) are separate on purpose.
 *  `unreported` marks a task some attempt left unmeasured. */
function renderCost(cases: readonly BenchCaseScore[]): string {
  if (cases.length === 0) return '  cost: no attempts';

  const mean = (of: (c: BenchCaseScore) => number | null, digits: number): string => {
    let total = 0;

    for (const entry of cases) {
      const value = of(entry);

      if (value === null) return 'unreported';
      total += value;
    }

    return (total / cases.length).toFixed(digits);
  };

  const peak = (of: (c: BenchCaseScore) => number | null): string => {
    let max = 0;

    for (const entry of cases) {
      const value = of(entry);

      if (value === null) return 'unreported';
      max = Math.max(max, value);
    }

    return String(max);
  };

  return `  tokens/task A=${mean((c) => c.tokensA, 0)}  B=${mean((c) => c.tokensB, 0)}` +
    `   model calls/task A=${mean((c) => c.modelCallsA, 1)}  B=${mean((c) => c.modelCallsB, 1)}` +
    `   peak prompt tokens A=${peak((c) => c.peakPromptTokensA)}  B=${peak((c) => c.peakPromptTokensB)}`;
}

function renderPairedStats(s: PairedBinaryStats): string {
  const lines = [
    `  pass@1 A=${pct(s.passAtOneA)}  B=${pct(s.passAtOneB)}  effect=${fmtPp(s.effect)}` +
      `  95% CI [${fmtPp(s.ci.lo)}, ${fmtPp(s.ci.hi)}]`,
    `  pass^${s.repeats} A=${pct(s.passAllA)}  B=${pct(s.passAllB)}  effect=${fmtPp(s.effectAll)}` +
      (s.repeats === 1 ? '  (identical to pass@1 at 1 repeat)' : `  — solved in all ${s.repeats} attempts`),
    // Exact McNemar at one attempt per task; the exact sign test above it.
    `  ${s.repeats === 1 ? 'McNemar exact' : 'exact sign test over tasks'} p=${s.pValue.toFixed(4)}` +
      `  (b=${s.onlyA} favour A, c=${s.onlyB} favour B, ${s.discordant}/${s.pairs} discordant tasks)`,
    `  detectable at this n: ${fmtPp(s.mde)}  resolution=${s.resolutionRatio.toFixed(2)}x` +
      `  → ${s.verdict}`,
  ];

  if (s.repeats > 1) {
    lines.splice(2, 0, `  unstable: ${s.flakyEither}/${s.pairs} task(s) (A=${s.flakyA}, B=${s.flakyB})`);
  }

  return lines.join('\n');
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export interface GainTaskScore {
  taskId: string;
  index: number;
  stateful: number;
  stateless: number;
}

export interface GainReport {
  ranAt: number;
  runId: string;
  config: BenchRunConfig;
  configHash: string;
  sequence: string[];
  perTask: GainTaskScore[];
  cost: GainCostSummary;
  stats: GainStats;
  calibration: string;
  headline: string;
}

export interface GainArmCostSummary {
  attempts: number;
  /** null when any attempt was unmeasured. */
  totalTokens: number | null;
  meanTokens: number | null;
  /** null when any attempt lacked call evidence. */
  totalModelCalls: number | null;
  meanModelCalls: number | null;
  /** null when any attempt lacked a working-set measurement. */
  peakPromptTokens: number | null;
  budgetBreaches: number;
  errors: number;
}

export interface GainCostSummary {
  stateless: GainArmCostSummary;
  stateful: GainArmCostSummary;
}

export const GAIN_CALIBRATION =
  'CL-Bench reference: leader 22.3% normalized reward / 25.4% gain; dedicated memory systems there underperform naive in-context learning. Near-zero gain is a real result.';

export interface BuildGainReportInput {
  runId: string;
  config: BenchRunConfig;
  perTask: readonly GainTaskScore[];
  attempts: readonly AttemptOutcome[];
  ranAt?: number;
  bootstrap?: BootstrapOptions;
}

function gainArmCost(attempts: readonly AttemptOutcome[]): GainArmCostSummary {
  const reportedTokens = attempts.map((attempt) => attempt.tokens);

  const totalTokens = reportedTokens.every((tokens) => tokens !== undefined)
    ? reportedTokens.reduce((sum, tokens) => sum + tokens, 0)
    : null;

  const reportedCalls = attempts.map((attempt) => attempt.modelCalls);
  const hasCompleteCallEvidence = reportedCalls.every((calls) => calls !== undefined);

  const totalModelCalls = hasCompleteCallEvidence
    ? reportedCalls.reduce((sum, calls) => sum + calls, 0)
    : null;

  const reportedPeaks = attempts.map((attempt) => attempt.peakPromptTokens);

  return {
    attempts: attempts.length,
    totalTokens,
    meanTokens: totalTokens === null || attempts.length === 0 ? null : totalTokens / attempts.length,
    totalModelCalls,
    meanModelCalls: totalModelCalls === null || attempts.length === 0
      ? null
      : totalModelCalls / attempts.length,
    peakPromptTokens: reportedPeaks.every((peak) => peak !== undefined)
      ? reportedPeaks.reduce((peak, next) => Math.max(peak, next), 0)
      : null,
    budgetBreaches: attempts.filter((attempt) => attempt.budgetBreach !== null).length,
    errors: attempts.filter((attempt) => attempt.error !== undefined).length,
  };
}

function gainCostSummary(
  attempts: readonly AttemptOutcome[],
  perTask: readonly GainTaskScore[],
  config: BenchRunConfig,
): GainCostSummary {
  const expectedPerArm = perTask.length * config.repeats;
  const taskIds = new Set(perTask.map((task) => task.taskId));
  const seen = new Set<string>();

  for (const attempt of attempts) {
    if (!taskIds.has(attempt.taskId)) {
      throw new Error(`gain accounting contains unknown task ${attempt.taskId}`);
    }

    const expectedVariant = attempt.slot === 'a' ? config.variantA : config.variantB;

    if (attempt.variantId !== expectedVariant) {
      throw new Error(`gain accounting slot ${attempt.slot} contains variant ${attempt.variantId}; expected ${expectedVariant}`);
    }

    if (attempt.repeat < 0 || attempt.repeat >= config.repeats) {
      throw new Error(`gain accounting has out-of-range repeat ${attempt.repeat} for ${attempt.taskId}`);
    }

    const key = `${attempt.slot}:${attempt.taskId}:${attempt.repeat}`;

    if (seen.has(key)) throw new Error(`gain accounting repeats attempt ${key}`);
    seen.add(key);
  }

  const stateless = attempts.filter((attempt) => attempt.slot === 'a');
  const stateful = attempts.filter((attempt) => attempt.slot === 'b');

  if (stateless.length !== expectedPerArm || stateful.length !== expectedPerArm) {
    throw new Error(
      `gain accounting expected ${expectedPerArm} attempt per arm; got ${stateless.length} stateless and ${stateful.length} stateful`,
    );
  }

  return { stateless: gainArmCost(stateless), stateful: gainArmCost(stateful) };
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
    cost: gainCostSummary(input.attempts, perTask, input.config),
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
  lines.push(`Tasks: ${s.tasks} (identical sequence, both arms)` +
    (report.config.repeats > 1 ? ` × ${report.config.repeats} passes; per-task reward is the mean over passes` : ''));
  lines.push(`  tokens/attempt stateless=${formatMeasured(report.cost.stateless.meanTokens, 0)}` +
    `  stateful=${formatMeasured(report.cost.stateful.meanTokens, 0)}`);
  lines.push(`  model calls/attempt stateless=${formatMeasured(report.cost.stateless.meanModelCalls, 1)}` +
    `  stateful=${formatMeasured(report.cost.stateful.meanModelCalls, 1)}`);
  lines.push(`  peak prompt tokens stateless=${formatMeasured(report.cost.stateless.peakPromptTokens, 0)}` +
    `  stateful=${formatMeasured(report.cost.stateful.peakPromptTokens, 0)}`);
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

function formatMeasured(value: number | null, digits: number): string {
  return value === null ? 'unreported' : value.toFixed(digits);
}
