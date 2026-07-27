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
  tokensA: number;
  tokensB: number;
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

/** Per-attempt figures collapsed to one row. Mean rather than total for the
 *  cost fields, so a k=3 row is read against the same per-attempt budget a k=1
 *  row is. */
function foldRepeats(attempts: readonly AttemptOutcome[]): {
  passes: number; durationMs: number; tokens: number;
  breach: BudgetBreach | null; error?: string; breachCount: number;
} {
  const n = attempts.length;
  const error = attempts.find((x) => x.error)?.error;
  return {
    passes: attempts.filter((x) => x.passed).length,
    durationMs: Math.round(attempts.reduce((s, x) => s + x.durationMs, 0) / n),
    tokens: Math.round(attempts.reduce((s, x) => s + x.tokens, 0) / n),
    breach: attempts.find((x) => x.budgetBreach)?.budgetBreach ?? null,
    breachCount: attempts.filter((x) => x.budgetBreach).length,
    ...(error === undefined ? {} : { error }),
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
      breachA: foldA.breach, breachB: foldB.breach,
      ...(foldA.error ? { errorA: foldA.error } : {}),
      ...(foldB.error ? { errorB: foldB.error } : {}),
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
  lines.push(`Tasks: ${s.tasks} (identical sequence, both arms)` +
    (report.config.repeats > 1 ? ` × ${report.config.repeats} passes; per-task reward is the mean over passes` : ''));
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
