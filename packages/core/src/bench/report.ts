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
  /** Attempts per task per variant. */
  repeats: number;
  /** Digest of the whole task corpus — both splits. */
  manifestHash: string;
}

/** Two runs are comparable only when this matches. Budget is part of it, so a
 *  variant cannot win by quietly being given a bigger compute envelope; repeats
 *  are part of it for the same reason — pass^k at k=3 and k=1 are different
 *  measurements and averaging noise away changes what the number means. */
export function benchConfigHash(config: BenchRunConfig): string {
  return fnv1a64(JSON.stringify([
    config.corpus, config.budget.wallClockMs, config.budget.maxTokens,
    config.seed, config.variantA, config.variantB, config.repeats, config.manifestHash,
  ]));
}

export interface BenchCaseScore {
  taskId: string;
  /** Repeats run per variant on this task. */
  attempts: number;
  passesA: number;
  passesB: number;
  /** Mean per attempt, so the number stays on the same scale as the budget. */
  durationMsA: number;
  durationMsB: number;
  /** Mean tokens per attempt. null means at least one attempt carried no token
   *  measurement at all — an unmeasured attempt summed as zero is exactly what
   *  made a variant whose meter broke look cheap. Same rule as `modelCallsA`:
   *  never rendered as zero. */
  tokensA: number | null;
  tokensB: number | null;
  /** Mean observed inference calls per attempt. null means call evidence was
   *  absent for at least one attempt; it must never be rendered as zero. */
  modelCallsA: number | null;
  modelCallsB: number | null;
  /** Largest working set either variant reached on this task — the number the
   *  context-discipline candidates are supposed to move. null when at least one
   *  attempt carried no measurement of it. */
  peakPromptTokensA: number | null;
  peakPromptTokensB: number | null;
  /** First breach seen across the repeats, or null when none breached. */
  breachA: BudgetBreach | null;
  breachB: BudgetBreach | null;
  /** First error seen across the repeats. */
  errorA?: string;
  errorB?: string;
}

/** Repeats disagreed under at least one variant: the task is unstable, and an
 *  unstable task averaged into a pass rate is a finding being hidden. */
export function caseIsUnstable(c: BenchCaseScore): boolean {
  const unstable = (passes: number) => passes > 0 && passes < c.attempts;
  return unstable(c.passesA) || unstable(c.passesB);
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
  // "Never disagreed" comes first because it is the more specific diagnosis of
  // the same fact: with no differing pair the floor is 1, so the rule below
  // fires too and says "the split has only N tasks", which names the wrong
  // quantity. The task count is an upper bound on what can decide; the differing
  // pairs are what decides.
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
  /** Attempts on the dev split, both variants. */
  devAttempts: readonly AttemptOutcome[];
  sealed: SealedScorecard | null;
  sealAccessOrdinal: number | null;
  ranAt?: number;
  bootstrap?: BootstrapOptions;
}

/** Per-attempt figures collapsed to one row. Mean rather than total for the
 *  cost fields, so a k=3 row is read against the same per-attempt budget a k=1
 *  row is. */
function foldRepeats(attempts: readonly AttemptOutcome[]) {
  const n = attempts.length;
  const error = attempts.find((x) => x.error)?.error;
  const calls = attempts.map((attempt) => attempt.modelCalls);
  const tokens = attempts.map((attempt) => attempt.tokens);
  const peaks = attempts.map((attempt) => attempt.peakPromptTokens);
  return {
    passes: attempts.filter((x) => x.passed).length,
    durationMs: Math.round(attempts.reduce((s, x) => s + x.durationMs, 0) / n),
    // One unmeasured repeat makes the row's cost unknown, not smaller — the
    // all-or-nothing rule the model-call fold below has always used.
    tokens: tokens.every((count) => count !== undefined)
      ? Math.round(tokens.reduce((sum, count) => sum + count, 0) / n)
      : null,
    modelCalls: calls.every((count) => count !== undefined)
      ? calls.reduce((sum, count) => sum + count, 0) / n
      : null,
    // A peak is a maximum, not a mean: averaging peaks across repeats would
    // report a working set no attempt ever actually reached.
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
  for (const attempt of input.devAttempts) {
    const entry = byTask.get(attempt.taskId) ?? { a: [], b: [] };
    if (attempt.variantId === config.variantA) entry.a.push(attempt);
    else if (attempt.variantId === config.variantB) entry.b.push(attempt);
    else throw new Error(`attempt for unknown variant "${attempt.variantId}" on task ${attempt.taskId}`);
    byTask.set(attempt.taskId, entry);
  }

  const cases: BenchCaseScore[] = [];
  const outcomes: PairedOutcome[] = [];
  let budgetBreaches = 0;
  for (const [taskId, { a, b }] of byTask) {
    if (a.length !== config.repeats || b.length !== config.repeats) {
      throw new Error(`unpaired task ${taskId}: expected ${config.repeats} attempt(s) per variant, got ${a.length} and ${b.length} — a paired design cannot drop half a pair`);
    }
    // Repeat order is the pairing order for pass^k and flakiness alike; sorting
    // makes a report byte-identical whatever order the runner emitted in.
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
      errorA: foldA.error || undefined,
      errorB: foldB.error || undefined,
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
    // Surfaced rather than averaged into the pass rate: a task whose repeats
    // disagree is reporting instability, and instability read as a score is how
    // a marginal result becomes an artifact.
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
    const score = c.attempts === 1 ? (passes === 1 ? 'pass' : 'FAIL') : `${passes}/${c.attempts}`;
    return `${score}${breach ? `(${breach})` : ''}`;
  };
  return `${c.taskId.padEnd(28)} A=${mark(c.passesA, c.breachA).padEnd(14)} B=${mark(c.passesB, c.breachB)}` +
    (caseIsUnstable(c) ? '  ~unstable' : '');
}

/** Cost next to the effect, because a variant that wins by spending twice as
 *  much has not won the same thing. Two different numbers on purpose: mean
 *  tokens per task is what an attempt costs, peak prompt tokens is how big its
 *  working set got — and a context-discipline change is supposed to move the
 *  second without moving the first. The peak is a maximum over tasks; averaging
 *  peaks would report a working set nothing ever reached. Both read 0 for the
 *  deterministic controls, which make no model call and report that as measured
 *  zero; `unreported` is reserved for a task some attempt left unmeasured, since
 *  a missing measurement averaged in as zero is how an arm comes to look cheap. */
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
    // Named for what it actually is at each k: at one attempt per task the sign
    // test over discordant tasks IS exact McNemar; above it, it is the same
    // exact test on task-level rate differences.
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
  cost: GainCostSummary;
  stats: GainStats;
  /** Published reference points, so a number is read against something. */
  calibration: string;
  headline: string;
}

export interface GainArmCostSummary {
  attempts: number;
  /** null means at least one attempt carried no token measurement. An arm is
   *  compared against the other arm's spend, so one unmeasured attempt summed as
   *  zero would hand this arm a discount it never earned. */
  totalTokens: number | null;
  meanTokens: number | null;
  /** null means at least one attempt did not report call evidence. */
  totalModelCalls: number | null;
  meanModelCalls: number | null;
  /** null when at least one attempt carried no working-set measurement. */
  peakPromptTokens: number | null;
  budgetBreaches: number;
  errors: number;
}

export interface GainCostSummary {
  stateless: GainArmCostSummary;
  stateful: GainArmCostSummary;
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

/** A cost figure that may not have been measured. `unreported` rather than a
 *  number, because the whole point of the null is that no digit is honest here. */
function formatMeasured(value: number | null, digits: number): string {
  return value === null ? 'unreported' : value.toFixed(digits);
}
