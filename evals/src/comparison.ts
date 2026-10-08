import { basename } from 'node:path';
import { renderThrownChain } from '@kinu.run/core/obs';
import { redact } from './redact';
import { rate, seconds, sign, signed, tokens, usd } from './format';
import { platformByTask, type PlatformReport, type TaskPlatform } from './platform';
import { renderRunReport } from './run-report';
import {
  parseResults, steadyCacheP5, steadyCacheShare, trials, type Assertion, type EvalFile, type HarnessRun, type PlanUsage, type ToolFailure,
} from './results';
import { MEASURE_NAMES, shifts, type Measure, type Shift, type Spread } from './shifts';
import { HARNESS_ERRORS } from './task';

export type EvalStats = {
  trials: number;
  passed: number;
  /** Trials a turn of which ended `reset`, the workspace's isolate reset for memory: failed, and counted apart. */
  resets: number;
  /** A trial's wall time less its waits on the model provider, which measure the account's rate limit. */
  meanDurationMs: number;
  meanWallTimeMs: number;
  /** The slowest trial: trials of a task run at once, so this is the task's wall time. */
  slowestTrialMs: number;
  meanModelTurns: number;
  meanToolCalls: number;
  meanToolErrors: number;
  /** Null when any trial lacks a cost: a mean over a subset would not compare across sides. */
  meanCostUsd: number | null;
  /** Token-weighted over non-infrastructure trials; null if any of those trials lacks prompt or cache-read counts. */
  cacheHitRate: number | null;
  /** The same over every request but each actor's first (`steadyCacheShare`), and that requests' own fifth percentile
   *  (`steadyCacheP5`); null with no such request. */
  steadyCacheHitRate: number | null;
  steadyCacheP5: number | null;
  /** Null when any trial lacks the count. */
  meanInputTokens: number | null;
  meanOutputTokens: number | null;
  /** Failed tool calls by tool and cause over every trial (`ToolFailure`), most first. */
  toolFailures: ToolFailure[];
  /** Each plan window over every trial: from the lowest use a trial began at to the highest it ended at. */
  planUsage: PlanUsage[];
  /** Each failed check as `t<turn> <check id>`, with how many trials failed it and the first evidence. Most frequent first. */
  failedChecks: { check: string; trials: number; evidence: string | null }[];
  /** Tool errors by tool and the first line of their message, most frequent first. */
  toolErrors: { tool: string; message: string; count: number }[];
  /** Trials that failed for infrastructure reasons rather than the agent's work, by message. */
  infrastructureErrors: { message: string; trials: number }[];
  /** Waits on the model provider across every trial (429 backoff, retry-after, cooldown): infrastructure. */
  providerWaits: number;
  providerWaitMs: number;
};

type Cohort = { taskId: string; model: string; arm: string; taskVersion: string; assertions: Assertion[] };

type Identity = { taskId: string; model: string; arm: string };

/** One check's attempts and passes on one side: a trial that stopped before the check did not attempt it. */
export type CheckRate = { attempted: number; passed: number };

/** One check, `t<turn> <id>`, on both sides, with the two-sided Fisher exact test on its passes over its attempts. */
export type CheckShift = { check: string; baseline: CheckRate; candidate: CheckRate; pValue: number };

/**
 * One task/model/arm cohort. `reason` is null exactly when both sides compare, and then `pValue` is the two-sided
 * Fisher exact test on the pass counts and `resetPValue` the same test on the reset counts; `shifts` compares every
 * other measure of a trial, and `checks` every check's pass rate. The pass and reset counts and the rises in
 * `WORSE_HIGHER` decide the verdict: the rest says where a change moved the work, for whoever fixes it.
 */
export type EvalComparisonRow = Identity & (
  | { reason: null; baseline: EvalStats; candidate: EvalStats; pValue: number; resetPValue: number; shifts: Shift[]; checks: CheckShift[] }
  | { reason: string; baseline: EvalStats | null; candidate: EvalStats | null }
);

/**
 * `regressed` when any comparable task's pass rate fell significantly (p < 0.05), its workspaces reset for memory
 * significantly more often, or it took significantly more model steps, tokens or malformed calls; `improved` when some
 * pass rate rose and none of that happened, `unchanged` when none moved beyond noise, `inconclusive` when nothing could
 * be compared.
 */
export type EvalVerdict = 'improved' | 'regressed' | 'unchanged' | 'inconclusive';

/** What one report measured: the deployed build, and the commit whose task definitions it ran. */
export type EvalSide = { productSha: string; evalCommit: string };

/** How the agent worked on one model across every task of one report: information, not a verdict. */
export type AgentProfile = {
  runs: number;
  meanModelTurns: number;
  meanInputTokens: number | null;
  meanOutputTokens: number | null;
  meanWallTimeMs: number;
  meanCostUsd: number | null;
  cacheHitRate: number | null;
  /** The same over every step but each actor's first in a run, which nothing can be cached for; null with no such step. */
  steadyCacheHitRate: number | null;
  /** The share of tool calls that were `eval` (code mode) rather than a native tool; null with no calls. */
  evalCallShare: number | null;
};

export type EvalSuiteTotals = { costUsd: number | null; wallTimeMs: number | null };

export type EvalComparison = {
  baseline: EvalSide | null;
  candidate: EvalSide;
  verdict: EvalVerdict;
  /** Files changed between the two deployed builds that the evals exercise. */
  changedFiles: string[];
  rows: EvalComparisonRow[];
  totals: { baseline: EvalSuiteTotals | null; candidate: EvalSuiteTotals };
  /** Per model, both sides pooled over every task. */
  profiles: { model: string; baseline: AgentProfile | null; candidate: AgentProfile }[];
  /** Each side's every trial as one cohort: the run's own measures. */
  overall: { baseline: EvalStats | null; candidate: EvalStats };
  /** What Workers Logs said of each task's workspaces on each side; null when neither side was read. */
  platform: PlatformRows | null;
};

/** Each task on both sides as the platform saw it, with the Fisher exact test on its trials that saw a bug. */
export type PlatformRows = {
  readonly why: { readonly baseline: string | null; readonly candidate: string | null };
  readonly tasks: readonly { readonly taskId: string; readonly baseline: TaskPlatform | null; readonly candidate: TaskPlatform | null; readonly pValue: number | null }[];
};

/** The platform logs read beside each side's report (`evals/scripts/platform-bugs.ts`). */
export type PlatformReads = { readonly baseline: PlatformReport | null; readonly candidate: PlatformReport | null };

/** Questions about two commits that only the caller, holding the repository, can answer. */
export type CommitQuestions = {
  /** Whether the code that defines or scores a trial differs between two eval commits. */
  definitionsChanged?: (baselineCommit: string, candidateCommit: string) => boolean;
  /** Files changed between two deployed builds that the evals exercise. */
  changedFiles?: (baselineSha: string, candidateSha: string) => string[];
};

const SIGNIFICANCE = 0.05;

const HARNESS_ERROR_NAMES: readonly string[] = HARNESS_ERRORS;

function cohortKey(identity: Identity): string {
  return JSON.stringify([identity.taskId, identity.model, identity.arm]);
}

function group(assertions: readonly Assertion[]): Map<string, Cohort> {
  const cohorts = new Map<string, Cohort>();

  for (const assertion of assertions) {
    const run = assertion.meta.harness.run;
    const { taskId, taskVersion, arm } = run.session.metadata;
    const identity = { taskId, model: run.usage.model, arm };
    const cohort = cohorts.get(cohortKey(identity));

    if (cohort === undefined) {
      cohorts.set(cohortKey(identity), { ...identity, taskVersion, assertions: [assertion] });
    } else {
      if (cohort.taskVersion !== taskVersion) throw new Error(`${taskId} has inconsistent task versions`);
      cohort.assertions.push(assertion);
    }
  }

  return cohorts;
}

function profile(assertions: readonly Assertion[]): AgentProfile {
  const runs = assertions.map((assertion) => assertion.meta.harness.run);
  const calls = runs.flatMap((run) => run.session.events.flatMap((event) => event.type === 'tool_call' ? [event.name] : []));
  const inputs = runs.flatMap((run) => run.usage.inputTokens === undefined ? [] : [run.usage.inputTokens]);
  const outputs = runs.flatMap((run) => run.usage.outputTokens === undefined ? [] : [run.usage.outputTokens]);
  const cost = totalCostUsd(runs);

  return {
    runs: runs.length,
    meanModelTurns: mean(runs.map((run) => run.output.metrics.modelTurns)),
    meanInputTokens: inputs.length === runs.length ? mean(inputs) : null,
    meanOutputTokens: outputs.length === runs.length ? mean(outputs) : null,
    meanWallTimeMs: mean(assertions.map((assertion) => assertion.duration)),
    meanCostUsd: cost === null ? null : cost / runs.length,
    cacheHitRate: cacheHitRate(assertions),
    steadyCacheHitRate: steadyCacheShare(assertions.filter((assertion) => !hasInfrastructureFailure(assertion))
      .map((assertion) => assertion.meta.harness.run.usage.metadata.steps)),
    evalCallShare: calls.length === 0 ? null : calls.filter((name) => name === 'eval').length / calls.length,
  };
}

function profiles(baseline: readonly Assertion[], candidate: readonly Assertion[]): EvalComparison['profiles'] {
  const models = [...new Set(candidate.map((assertion) => assertion.meta.harness.run.usage.model))].sort();
  const on = (assertions: readonly Assertion[], model: string) => assertions.filter((assertion) => assertion.meta.harness.run.usage.model === model);

  return models.map((model) => {
    const before = on(baseline, model);

    return { model, baseline: before.length === 0 ? null : profile(before), candidate: profile(on(candidate, model)) };
  });
}

/** A report measures one build with one set of definitions, or it is two reports. */
function sideOf(name: string, assertions: readonly Assertion[]): EvalSide {
  const builds = new Set(assertions.map((assertion) => assertion.meta.harness.run.session.metadata.productSha));
  const commits = new Set(assertions.map((assertion) => assertion.meta.harness.run.session.metadata.evalCommit));

  if (builds.size !== 1 || commits.size !== 1) {
    throw new Error(`${name} results mix builds [${[...builds].join(', ')}] or eval commits [${[...commits].join(', ')}]`);
  }

  const [productSha] = builds, [evalCommit] = commits;

  if (productSha === undefined || evalCommit === undefined) throw new Error(`${name} results name no build`);

  return { productSha, evalCommit };
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function totalCostUsd(runs: readonly HarnessRun[]): number | null {
  let total = 0;

  for (const run of runs) {
    const cost = run.usage.metadata.costUsd;

    if (cost === undefined) return null;
    total += cost;
  }

  return total;
}

function cacheHitRate(assertions: readonly Assertion[]): number | null {
  let prompt = 0, cached = 0;

  for (const assertion of assertions) {
    if (hasInfrastructureFailure(assertion)) continue;

    const { inputTokens, metadata } = assertion.meta.harness.run.usage;

    if (inputTokens === undefined || metadata.cacheReadTokens === undefined) return null;
    prompt += inputTokens;
    cached += metadata.cacheReadTokens;
  }

  return prompt > 0 ? cached / prompt : null;
}

/** Failed tool calls summed by tool and cause, most first. */
export function summedFailures(failures: readonly ToolFailure[]): ToolFailure[] {
  const summed = new Map<string, ToolFailure>();

  for (const { tool, cause, count } of failures) {
    const key = `${tool}\u0000${cause}`;

    summed.set(key, { tool, cause, count: (summed.get(key)?.count ?? 0) + count });
  }

  return [...summed.values()].sort((left, right) => right.count - left.count || left.tool.localeCompare(right.tool) || left.cause.localeCompare(right.cause));
}

/** Each plan window from the lowest use any trial began at to the highest any ended at. */
function widestPlanUsage(windows: readonly PlanUsage[]): PlanUsage[] {
  const widest = new Map<string, PlanUsage>();

  for (const window of windows) {
    const key = `${window.account}\u0000${window.measure}`;
    const held = widest.get(key);

    widest.set(key, held === undefined ? window : { ...held, from: Math.min(held.from, window.from), to: Math.max(held.to, window.to) });
  }

  return [...widest.values()];
}

function suiteTotals(files: readonly EvalFile[], assertions: readonly Assertion[]): EvalSuiteTotals {
  const costUsd = totalCostUsd(assertions.map((assertion) => assertion.meta.harness.run));
  let first = Infinity, last = -Infinity;

  // Trials overlap, so their durations cannot be added to get the suite's wall time.
  for (const file of files) {
    if (file.startTime === undefined || file.endTime === undefined) return { costUsd, wallTimeMs: null };
    first = Math.min(first, file.startTime);
    last = Math.max(last, file.endTime);
  }

  return { costUsd, wallTimeMs: last - first };
}

/** How many items share each key, most frequent first, keeping the first item for each key. */
function countBy<T>(items: readonly T[], key: (item: T) => string): { item: T; count: number }[] {
  const counts = new Map<string, { item: T; count: number }>();

  for (const item of items) {
    const entry = counts.get(key(item));

    if (entry === undefined) counts.set(key(item), { item, count: 1 });
    else entry.count += 1;
  }

  return [...counts.values()].sort((left, right) => right.count - left.count);
}

/** A harness-level error or a turn the deployment ended in error: the environment failed, not the build or the agent. */
export function hasInfrastructureFailure(assertion: Assertion): boolean {
  const run = assertion.meta.harness.run;

  return run.errors.some((error) => HARNESS_ERROR_NAMES.includes(error.name))
    || run.output.turns.some((turn) => turn.outcome.status === 'error');
}

/** The cancelled turn of a trial the run's cancel ended while it was open, which names what held its workspace. */
function cancellation(assertion: Assertion): string | null {
  const run = assertion.meta.harness.run;
  const turn = run.output.turns.find(({ outcome }) => outcome.status === 'cancelled');

  return turn === undefined ? null : `trial ${String(run.session.metadata.trial)}: ${turn.outcome.message ?? 'cancelled'}`;
}

function infrastructureMessage(assertion: Assertion): string {
  const run = assertion.meta.harness.run;
  const turn = run.output.turns.find(({ outcome }) => outcome.status === 'error');

  return turn?.outcome.message ?? run.errors[0]?.message.split('\n')[0] ?? 'infrastructure failure';
}

function stats({ assertions }: Pick<Cohort, 'assertions'>): EvalStats {
  const runs = assertions.map((assertion) => assertion.meta.harness.run);
  const metrics = runs.map((run) => run.output.metrics);
  const cost = totalCostUsd(runs);
  const measured = assertions.filter((assertion) => !hasInfrastructureFailure(assertion)).map((assertion) => assertion.meta.harness.run.usage.metadata.steps);
  const inputs = runs.flatMap((run) => run.usage.inputTokens === undefined ? [] : [run.usage.inputTokens]);
  const outputs = runs.flatMap((run) => run.usage.outputTokens === undefined ? [] : [run.usage.outputTokens]);

  // A turn the deployment refused, reset or hung failed on the build, so it is listed with the checks, its answer as the
  // evidence; a hang under what held it, so a job left running is not read as a model gone silent.
  const failedChecks = countBy(runs.flatMap((run) => run.output.turns.flatMap((turn) => [
    ...turn.outcome.status === 'refused' || turn.outcome.status === 'reset' || turn.outcome.status === 'hung'
      ? [{ id: `deployment.${turn.outcome.status}${turn.outcome.heldBy === undefined ? '' : ` (held by ${turn.outcome.heldBy.join(', ')})`}`,
        evidence: turn.outcome.message }]
      : [],
    ...turn.checks.filter((check) => !check.pass),
  ].map((check) => ({
    check: `t${String(turn.turn)} ${check.id}`,
    evidence: check.evidence === undefined ? null : JSON.stringify(check.evidence),
  })))), (failure) => failure.check);

  const toolErrors = countBy(runs.flatMap((run) => run.session.events.flatMap((event) =>
    event.type === 'tool_result' && event.error !== undefined
      ? [{ tool: event.name ?? 'unknown', message: event.error.message.trim().split('\n')[0] ?? '' }]
      : [])), (error) => `${error.tool}\n${error.message}`);

  const infrastructureErrors = countBy(assertions.filter(hasInfrastructureFailure).map(infrastructureMessage), (message) => message);

  return {
    trials: assertions.length,
    passed: assertions.filter((assertion) => assertion.status === 'passed').length,
    resets: runs.filter((run) => run.output.turns.some((turn) => turn.outcome.status === 'reset')).length,
    meanDurationMs: mean(assertions.map((assertion) => Math.max(0, assertion.duration - assertion.meta.harness.run.output.metrics.providerWaitMs))),
    meanWallTimeMs: mean(assertions.map((assertion) => assertion.duration)),
    slowestTrialMs: Math.max(0, ...assertions.map((assertion) => assertion.duration)),
    meanModelTurns: mean(metrics.map((value) => value.modelTurns)),
    meanToolCalls: mean(metrics.map((value) => value.toolCalls)),
    meanToolErrors: mean(metrics.map((value) => value.toolErrors)),
    meanCostUsd: cost === null ? null : cost / runs.length,
    cacheHitRate: cacheHitRate(assertions),
    steadyCacheHitRate: steadyCacheShare(measured),
    steadyCacheP5: steadyCacheP5(measured),
    meanInputTokens: inputs.length === runs.length ? mean(inputs) : null,
    meanOutputTokens: outputs.length === runs.length ? mean(outputs) : null,
    toolFailures: summedFailures(runs.flatMap((run) => run.output.toolFailures)),
    planUsage: widestPlanUsage(runs.flatMap((run) => run.usage.metadata.plan)),
    failedChecks: failedChecks.map(({ item, count }) => ({ ...item, trials: count })),
    toolErrors: toolErrors.map(({ item, count }) => ({ ...item, count })),
    infrastructureErrors: infrastructureErrors.map(({ item, count }) => ({ message: item, trials: count })),
    providerWaits: metrics.reduce((sum, value) => sum + value.providerWaits, 0),
    providerWaitMs: metrics.reduce((sum, value) => sum + value.providerWaitMs, 0),
  };
}

/**
 * Refuse a report that cannot serve as a baseline: every task file must have run, every cohort
 * must hold trials 1 to `expectedTrials` once each (a report joined from jobs that ran the same
 * block twice has the right count and half the trials), one build and one definition commit
 * throughout, and no trial may have failed for infrastructure reasons. Agent failures are
 * baseline data and pass. Returns each task's wall time, which the report records.
 */
export function validateEvalResults(text: string, expectedTrials: number): { taskId: string; slowestTrialMs: number }[] {
  const files = parseResults('the', text);

  for (const file of files) {
    if (file.assertionResults.length === 0) {
      throw new Error(`${basename(file.name)} ran no trials${file.message === undefined ? '' : `: ${file.message}`}`);
    }
  }

  const assertions = trials(files);
  sideOf('baseline', assertions);

  return [...group(assertions).values()].map((cohort) => {
    const numbers = cohort.assertions.map((assertion) => assertion.meta.harness.run.session.metadata.trial).sort((left, right) => left - right);

    if (numbers.length !== expectedTrials || numbers.some((number, index) => number !== index + 1)) {
      throw new Error(`${cohort.taskId} on ${cohort.model} (${cohort.arm}) holds trials [${numbers.join(', ')}], `
        + `expected 1 to ${String(expectedTrials)} once each`);
    }

    const cancelled = cohort.assertions.flatMap((assertion) => cancellation(assertion) ?? []);

    if (cancelled.length > 0) {
      throw new Error(`${cohort.taskId} on ${cohort.model} (${cohort.arm}) was cancelled with trials open: ${cancelled.join(' | ')}`);
    }

    const broken = cohort.assertions.filter(hasInfrastructureFailure);

    if (broken.length > 0) {
      throw new Error(`${cohort.taskId} on ${cohort.model} (${cohort.arm}) has ${String(broken.length)} infrastructure failures: ${broken.map(infrastructureMessage).join(' | ')}`);
    }

    return { taskId: cohort.taskId, slowestTrialMs: stats(cohort).slowestTrialMs };
  });
}

/**
 * Why `text` is not a complete report, or null when it is: `validateEvalResults` with `trials` a cohort, then, when
 * given, every one of `taskFiles` ran (a task missing from a report would read as removed) and the report is of
 * `build`, the build its leg was planned to measure. Builds are compared as `/api/health` names them, by prefix.
 */
export function whyIncomplete(text: string, expected: { trials: number; taskFiles?: readonly string[]; build?: string }): string | null {
  try {
    validateEvalResults(text, expected.trials);
    const files = parseResults('report', text);
    const ran = new Set(files.map((file) => basename(file.name)));
    const missing = (expected.taskFiles ?? []).filter((file) => !ran.has(basename(file)));

    if (missing.length > 0) return `${missing.join(', ')} did not run`;
    const { productSha } = sideOf('report', trials(files));
    const build = expected.build;

    if (build !== undefined && !productSha.startsWith(build) && !build.startsWith(productSha)) {
      return `its trials ran on build ${productSha}, not the planned ${build}`;
    }

    return null;
  } catch (error) {
    return renderThrownChain({ cause: error });
  }
}

/** The natural log of `count` choose `chosen`, as a sum of logs so large counts do not overflow. */
function logChoose(count: number, chosen: number): number {
  let sum = 0;

  for (let factor = chosen + 1; factor <= count; factor += 1) sum += Math.log(factor);

  for (let factor = 2; factor <= count - chosen; factor += 1) sum -= Math.log(factor);

  return sum;
}

/** Two-sided Fisher exact test on two pass counts: the chance, were both sides equally good, of a split at least as uneven. */
export function fisherExact(baseline: { passed: number; trials: number }, candidate: { passed: number; trials: number }): number {
  const passed = baseline.passed + candidate.passed;

  const probability = (baselinePassed: number) => Math.exp(
    logChoose(baseline.trials, baselinePassed) + logChoose(candidate.trials, passed - baselinePassed)
    - logChoose(baseline.trials + candidate.trials, passed));

  const observed = probability(baseline.passed);
  let total = 0;

  for (let baselinePassed = Math.max(0, passed - candidate.trials); baselinePassed <= Math.min(passed, baseline.trials); baselinePassed += 1) {
    // The tolerance keeps tables exactly as likely as the observed one despite floating-point noise.
    const chance = probability(baselinePassed);

    if (chance <= observed * (1 + 1e-7)) total += chance;
  }

  return Math.min(1, total);
}

function checkRates(assertions: readonly Assertion[]): Map<string, CheckRate> {
  const rates = new Map<string, CheckRate>();

  for (const assertion of assertions) {
    for (const turn of assertion.meta.harness.run.output.turns) {
      for (const check of turn.checks) {
        const key = `t${String(turn.turn)} ${check.id}`;
        const sofar = rates.get(key) ?? { attempted: 0, passed: 0 };

        rates.set(key, { attempted: sofar.attempted + 1, passed: sofar.passed + (check.pass ? 1 : 0) });
      }
    }
  }

  return rates;
}

/** Every check either side attempted, with its pass rate on both. */
function checkShifts(baseline: readonly Assertion[], candidate: readonly Assertion[]): CheckShift[] {
  const before = checkRates(baseline), after = checkRates(candidate);
  const none: CheckRate = { attempted: 0, passed: 0 };

  return [...new Set([...before.keys(), ...after.keys()])].map((check) => {
    const [was, is] = [before.get(check) ?? none, after.get(check) ?? none];

    return { check, baseline: was, candidate: is, pValue: fisherExact({ passed: was.passed, trials: was.attempted }, { passed: is.passed, trials: is.attempted }) };
  });
}

function passRate(side: EvalStats): number {
  return side.passed / side.trials;
}

/** Measures in which more is worse ("evals show no degradations", the owner): a rise beyond noise in any is a regression,
 *  as a fall in the pass rate is. Wall time and tool counts are the task's, not the build's; failed calls are the build's. */
const WORSE_HIGHER: ReadonlySet<Measure> = new Set(['modelSteps', 'inputTokens', 'outputTokens', 'toolErrors', 'badInputCalls', 'unknownToolCalls']);

function worsened(row: ComparedRow): Shift[] {
  return row.shifts.filter((shift) => WORSE_HIGHER.has(shift.measure) && shift.rose && shift.pValue < SIGNIFICANCE);
}

/** oh-my-pi's steady cache rate, 95–100% over a conversation: below it a model that evals run on regresses whatever the
 *  baseline did (the owner, 2026-10-08). Claude and ChatGPT spend the owner's plan and never run in a gate;
 *  `evals/scripts/cache-probe.ts` measures them by hand. */
export const CACHE_TARGET = 0.95;

function belowCacheTarget(profiled: EvalComparison['profiles']): EvalComparison['profiles'] {
  return profiled.filter(({ model, candidate }) => (model.startsWith('opencode-go/muse-') || model.startsWith('workers-ai/'))
    && candidate.steadyCacheHitRate !== null && candidate.steadyCacheHitRate < CACHE_TARGET);
}

/** Whether a compared cohort's workspaces reset for memory significantly more often than the baseline's. */
function resetMore(row: ComparedRow): boolean {
  return row.resetPValue < SIGNIFICANCE && row.candidate.resets > row.baseline.resets;
}

/** Tasks whose workspaces saw a platform bug in significantly more trials than the baseline's. */
function buggier(platform: PlatformRows | null): PlatformRows['tasks'] {
  return (platform?.tasks ?? []).filter(({ baseline, candidate, pValue }) => pValue !== null && pValue < SIGNIFICANCE
    && baseline !== null && candidate !== null && candidate.bugTrials / candidate.trials > baseline.bugTrials / baseline.trials);
}

/** A task the candidate passed in no trial while the baseline passed in some: a regression however few trials ran, which
 *  the exact test alone cannot call below four a side (3/3 against 0/3 is p = 0.10). */
function collapsed(row: ComparedRow): boolean {
  return row.candidate.trials > 0 && row.candidate.passed === 0 && row.baseline.passed > 0;
}

/** Whether a task's trials could show any fall at all: a baseline passing every trial against a candidate passing none
 *  is the strongest there is. At 3 a side it is p = 0.10, so no fall reaches significance and the run cannot say the
 *  task held; at 4, p = 0.029; at 5, a fall from 5/5 to 1/5 is p = 0.048 and to 2/5 is p = 0.17. */
export function canTellAFall(row: Pick<ComparedRow, 'baseline' | 'candidate'>): boolean {
  return fisherExact({ passed: row.baseline.trials, trials: row.baseline.trials }, { passed: 0, trials: row.candidate.trials }) < SIGNIFICANCE;
}

function verdictOf(rows: readonly EvalComparisonRow[], profiled: EvalComparison['profiles'], platform: PlatformRows | null): EvalVerdict {
  const compared = rows.flatMap((row) => row.reason === null ? [row] : []);

  if (compared.length === 0) return 'inconclusive';
  const moved = compared.filter((row) => row.pValue < SIGNIFICANCE);

  if (moved.some((row) => passRate(row.candidate) < passRate(row.baseline)) || compared.some(resetMore) || compared.some(collapsed)) return 'regressed';

  if (compared.some((row) => worsened(row).length > 0) || belowCacheTarget(profiled).length > 0 || buggier(platform).length > 0) return 'regressed';

  // Too few trials to tell a fall from noise is no evidence that nothing fell, and a promotion needs that evidence.
  if (!compared.every(canTellAFall)) return 'inconclusive';

  return moved.length > 0 ? 'improved' : 'unchanged';
}

/** Why a side's platform logs say nothing, or null when they were read. */
function unreadWhy(read: PlatformReport | null): string | null {
  if (read === null) return 'not read';

  return read.measured ? null : read.why;
}

/** Each task on both sides as the platform logs read it, or null when neither side's logs were read. */
function platformRows(baseline: readonly Assertion[], candidate: readonly Assertion[], reads: PlatformReads): PlatformRows | null {
  if (reads.baseline === null && reads.candidate === null) return null;

  const placed = (assertions: readonly Assertion[]) => assertions.map((assertion) => ({
    task: assertion.meta.harness.run.session.metadata.taskId, workspace: assertion.meta.harness.run.session.metadata.workspace ?? null,
  }));

  const [before, after] = [platformByTask(placed(baseline), reads.baseline), platformByTask(placed(candidate), reads.candidate)];
  const tasks = [...new Set([...before?.keys() ?? [], ...after?.keys() ?? []])].sort();

  return {
    why: { baseline: unreadWhy(reads.baseline), candidate: unreadWhy(reads.candidate) },
    tasks: tasks.map((taskId) => {
      const [was, is] = [before?.get(taskId) ?? null, after?.get(taskId) ?? null];

      const pValue = was === null || is === null ? null
        : fisherExact({ passed: was.bugTrials, trials: was.trials }, { passed: is.bugTrials, trials: is.trials });

      return { taskId, baseline: was, candidate: is, pValue };
    }),
  };
}

/** Compare two reports. With no baseline, every row is the candidate's alone and the verdict is inconclusive. */
export function compareEvalResults(
  baselineText: string | null, candidateText: string, questions: CommitQuestions = {}, reads: PlatformReads = { baseline: null, candidate: null },
): EvalComparison {
  const candidateFiles = parseResults('candidate', candidateText);
  const candidateAssertions = trials(candidateFiles);
  const candidate = sideOf('candidate', candidateAssertions);
  const next = group(candidateAssertions);
  const baselineFiles = baselineText === null ? [] : parseResults('baseline', baselineText);
  const baselineAssertions = trials(baselineFiles);
  const baseline = baselineText === null ? null : sideOf('baseline', baselineAssertions);
  const base = group(baselineAssertions);
  const changed = baseline !== null && (questions.definitionsChanged?.(baseline.evalCommit, candidate.evalCommit) ?? false);

  const rows = [...new Map([...base, ...next])].map(([key, cohort]): EvalComparisonRow => {
    const identity = { taskId: cohort.taskId, model: cohort.model, arm: cohort.arm };
    const before = base.get(key), after = next.get(key);

    if (before === undefined) return { ...identity, reason: baseline === null ? 'no baseline' : 'only in candidate', baseline: null, candidate: stats(cohort) };

    if (after === undefined) return { ...identity, reason: 'only in baseline', baseline: stats(before), candidate: null };

    // Why two cohorts cannot be compared, the first that holds; none means they can.
    const blockers: readonly (readonly [boolean, string])[] = [
      [changed, 'eval definition changed'],
      [before.taskVersion !== after.taskVersion, 'task version changed'],
      [before.assertions.length !== after.assertions.length, 'trial counts differ'],
      [before.assertions.some(hasInfrastructureFailure), 'baseline infrastructure errors'],
      [after.assertions.some(hasInfrastructureFailure), 'candidate infrastructure errors'],
    ];

    const reason = blockers.find(([blocked]) => blocked)?.[1] ?? null;

    const [baselineStats, candidateStats] = [stats(before), stats(after)];

    if (reason !== null) return { ...identity, reason, baseline: baselineStats, candidate: candidateStats };

    return {
      ...identity, reason, baseline: baselineStats, candidate: candidateStats, pValue: fisherExact(baselineStats, candidateStats),
      resetPValue: fisherExact(
        { passed: baselineStats.resets, trials: baselineStats.trials }, { passed: candidateStats.resets, trials: candidateStats.trials },
      ),
      shifts: shifts(before.assertions, after.assertions),
      checks: checkShifts(before.assertions, after.assertions),
    };
  }).sort((left, right) => left.taskId.localeCompare(right.taskId)
    || left.model.localeCompare(right.model) || left.arm.localeCompare(right.arm));

  const profiled = profiles(baselineAssertions, candidateAssertions);
  const platform = platformRows(baselineAssertions, candidateAssertions, reads);

  return {
    baseline, candidate, verdict: verdictOf(rows, profiled, platform),
    changedFiles: baseline === null ? [] : questions.changedFiles?.(baseline.productSha, candidate.productSha) ?? [],
    rows,
    totals: {
      baseline: baselineText === null ? null : suiteTotals(baselineFiles, baselineAssertions),
      candidate: suiteTotals(candidateFiles, candidateAssertions),
    },
    profiles: profiled,
    overall: { baseline: baselineText === null ? null : stats({ assertions: baselineAssertions }), candidate: stats({ assertions: candidateAssertions }) },
    platform,
  };
}

// ── The results comment ─────────────────────────────────────────────

function costDelta(baseline: EvalStats, candidate: EvalStats): string {
  if (baseline.meanCostUsd === null || candidate.meanCostUsd === null) return '\u2014';
  const delta = candidate.meanCostUsd - baseline.meanCostUsd;

  return `${sign(delta)}$${Math.abs(delta).toFixed(3)}`;
}

/** The one value every row shares, or null when they differ and must be shown per row. */
function uniform<T>(values: readonly T[]): T | null {
  const [first, ...rest] = values;

  return first !== undefined && rest.every((value) => value === first) ? first : null;
}

const VERDICT: Record<EvalVerdict, string> = {
  improved: '\u{1F7E2} Improved',
  regressed: '\u{1F534} Regressed',
  unchanged: '\u26AA Unchanged',
  inconclusive: '\u{1F7E1} Inconclusive',
};

type ComparedRow = Extract<EvalComparisonRow, { reason: null }>;

/** Text that came from a trial, as inline code: it is untrusted, may contain markup, and is scrubbed. */
function quoted(text: string, limit = 160): string {
  const flat = redact(text).replace(/\s+/g, ' ').replaceAll('`', "'").trim();

  return `\`${flat.length > limit ? `${flat.slice(0, limit - 1)}\u2026` : flat}\``;
}

/** Ten cells whatever the trial count, so bars line up down the table: green passed, red failed. */
function bar(side: EvalStats | null): string {
  if (side === null) return '\u2014';
  const passed = Math.round(passRate(side) * 10);

  return `${'\u{1F7E9}'.repeat(passed)}${'\u{1F7E5}'.repeat(10 - passed)} ${String(side.passed)}/${String(side.trials)}`;
}

/** A pass-rate change is coloured only when it is significant; otherwise it is noise. */
function passChange(row: ComparedRow): string {
  const delta = (passRate(row.candidate) - passRate(row.baseline)) * 100;

  if (row.pValue >= SIGNIFICANCE) return `\u26AA ${signed(delta, 0, ' pp')}`;

  return `${delta > 0 ? '\u{1F7E2}' : '\u{1F534}'} ${signed(delta, 0, ' pp')} (p = ${row.pValue.toFixed(2)})`;
}

function minutes(ms: number): string {
  return `${(ms / 60_000).toFixed(0)} min`;
}

function totalsTable(totals: EvalComparison['totals']): string[] {
  const row = (leg: string, side: EvalSuiteTotals | null) => `| ${leg} | ${usd(side?.costUsd ?? null)} | `
    + `${side?.wallTimeMs === undefined || side.wallTimeMs === null ? '—' : seconds(side.wallTimeMs)} |`;

  return [
    'Suite totals (all trials; wall spans the earliest start to the latest finish):', '',
    '| Leg | Cost (USD) | Wall time |', '| --- | --- | --- |',
    row('Baseline', totals.baseline), row('Candidate', totals.candidate),
  ];
}

/** What every row shares, said once above the table rather than on every row; null when rows differ. */
type Shared = { model: string | null; arm: string | null; trials: number | null };

function sharedBy(rows: readonly EvalComparisonRow[]): Shared {
  return {
    model: uniform(rows.map((row) => row.model)),
    arm: uniform(rows.map((row) => row.arm)),
    trials: uniform(rows.flatMap((row) => [row.baseline?.trials, row.candidate?.trials].filter((count) => count !== undefined))),
  };
}

function rowName(row: EvalComparisonRow, shared: Shared): string {
  return [row.taskId, ...shared.model === null ? [row.model] : [], ...shared.arm === null ? [row.arm] : []].join(' \u00b7 ');
}

/** The verdict's reason in one sentence: what could not be compared, or which tasks moved. */
function verdictReason(comparison: EvalComparison, shared: Shared): string {
  const moved = comparison.rows.flatMap((row) => row.reason === null && row.pValue < SIGNIFICANCE ? [row] : []);

  const change = (row: ComparedRow) => `${rowName(row, shared)} ${String(row.baseline.passed)}/${String(row.baseline.trials)} \u2192 `
    + `${String(row.candidate.passed)}/${String(row.candidate.trials)} (p = ${row.pValue.toFixed(2)})`;

  const compared = comparison.rows.flatMap((row) => row.reason === null ? [row] : []);
  const falls = compared.filter((row) => (moved.includes(row) ? passRate(row.candidate) < passRate(row.baseline) : collapsed(row))).map(change);
  const rises = moved.filter((row) => passRate(row.candidate) > passRate(row.baseline)).map(change);

  const resets = comparison.rows.flatMap((row) => row.reason === null && resetMore(row)
    ? [`${rowName(row, shared)} ${String(row.baseline.resets)}/${String(row.baseline.trials)} \u2192 `
      + `${String(row.candidate.resets)}/${String(row.candidate.trials)} (p = ${row.resetPValue.toFixed(2)})`]
    : []);

  const worse = comparison.rows.flatMap((row) => row.reason === null ? worsened(row).map((shift) => `${rowName(row, shared)} `
    + `${MEASURE_LABEL[shift.measure].name} ${spreadOf(shift.measure, shift.baseline)} \u2192 ${spreadOf(shift.measure, shift.candidate)} `
    + `(p = ${shift.pValue.toFixed(2)})`) : []);

  const uncached = belowCacheTarget(comparison.profiles).map(({ model, candidate }) => `${model} ${rate(candidate.steadyCacheHitRate)}`);

  switch (comparison.verdict) {
    case 'inconclusive': {
      const reasons = [...new Set(comparison.rows.flatMap((row) => row.reason ?? []))];

      const blind = compared.filter((row) => !canTellAFall(row)).map((row) => rowName(row, shared));

      return [
        ...reasons.length > 0 ? [`Not compared: ${reasons.join(', ')}.`] : [],
        ...blind.length > 0 ? [`Too few trials to tell any fall from noise, so not shown to hold: ${blind.join(', ')}.`] : [],
      ].join(' ') || 'No task can be compared.';
    }

    case 'unchanged': return `No task moved beyond what ${shared.trials === null ? 'these' : String(shared.trials)} runs can tell apart from noise.`;
    case 'improved': return `Rose: ${rises.join(', ')}.`;
    case 'regressed': return [
      ...falls.length > 0 ? [`Fell: ${falls.join(', ')}.`] : [],
      ...resets.length > 0 ? [`Reset for memory more often: ${resets.join(', ')}.`] : [],
      ...worse.length > 0 ? [`Worse: ${worse.join(', ')}.`] : [],
      ...uncached.length > 0 ? [`Steady cache hit below ${rate(CACHE_TARGET)}: ${uncached.join(', ')}.`] : [],
      ...rises.length > 0 ? [`Rose: ${rises.join(', ')}.`] : [],
    ].join(' ');
  }
}

/** Whether a run stands as its build's eval verdict, and the sentence that says why. */
export type EvalGateVerdict = { pass: boolean; reason: string };

/**
 * Whether a run stands as its candidate build's eval verdict, the question a promote asks: both legs, the baseline
 * deployment's and the candidate's, are complete reports (`validateEvalResults`), they were compared, and no cohort
 * regressed. Otherwise the reason it cannot stand. `incomplete` holds why each leg is not complete, or null when it is.
 */
export function evalGateVerdict(comparison: EvalComparison, incomplete: { baseline: string | null; candidate: string | null }): EvalGateVerdict {
  if (incomplete.candidate !== null) return { pass: false, reason: `The candidate's report is not complete: ${incomplete.candidate}` };

  if (incomplete.baseline !== null) return { pass: false, reason: `The baseline's report is not complete: ${incomplete.baseline}` };

  if (comparison.baseline === null) return { pass: false, reason: 'No baseline: no baseline report was compared with the candidate.' };

  const said = `${VERDICT[comparison.verdict]}. ${verdictReason(comparison, sharedBy(comparison.rows))}`;

  return { pass: comparison.verdict === 'unchanged' || comparison.verdict === 'improved', reason: said };
}

/** Which changed product files the evals exercise; nothing to say without a baseline. */
function exercisedLine({ baseline, changedFiles: files }: EvalComparison): string {
  if (baseline === null) return '';

  if (files.length === 0) return '**Evals exercise no file this change touches.**';

  return `**Evals exercise these changed files:** ${files.slice(0, 8).map((file) => `\`${basename(file)}\``).join(', ')}`
    + (files.length > 8 ? `, and ${String(files.length - 8)} more` : '');
}

function buildsLine({ baseline, candidate }: EvalComparison, shared: Shared): string {
  const builds = baseline === null
    ? `Build \`${candidate.productSha.slice(0, 9)}\` on kinu.run, no earlier build to compare against`
    : `Baseline build \`${baseline.productSha.slice(0, 9)}\` vs candidate build \`${candidate.productSha.slice(0, 9)}\`, both on kinu.run`;

  return [builds, ...shared.model === null ? [] : [shared.model], ...shared.arm === null ? [] : [`arm ${shared.arm}`],
    ...shared.trials === null ? [] : [`each task run ${String(shared.trials)} times per build`]].join(' \u00b7 ') + '.';
}

const SCORE_TABLE = [
  '| Task | Baseline | Candidate | Δ pass | Cache hit | Mean wall | Δ duration | Δ tool errors | Mean cost (USD) | Δ cost | Wall | 429 waits |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
];

function scoreRow(row: EvalComparisonRow, shared: Shared): string {
  const [passes, duration, toolErrors, cost] = row.reason !== null ? [`_not compared: ${row.reason}_`, '—', '—', '—'] : [
    passChange(row),
    signed((row.candidate.meanDurationMs - row.baseline.meanDurationMs) / 1000, 1, ' s'),
    signed(row.candidate.meanToolErrors - row.baseline.meanToolErrors, 1),
    costDelta(row.baseline, row.candidate),
  ];

  const wall = row.candidate === null ? '\u2014' : minutes(row.candidate.slowestTrialMs);
  const waits = row.candidate === null ? '\u2014' : `${minutes(row.candidate.providerWaitMs)} (\u00d7${String(row.candidate.providerWaits)})`;

  const cell = (value: (side: EvalStats) => string) => `${row.baseline === null ? '—' : value(row.baseline)} → `
    + `${row.candidate === null ? '—' : value(row.candidate)}`;

  return `| ${[rowName(row, shared), bar(row.baseline), bar(row.candidate), passes, cell((side) => rate(side.cacheHitRate)),
    cell((side) => seconds(side.meanWallTimeMs)), duration, toolErrors, cell((side) => usd(side.meanCostUsd)), cost, wall, waits].join(' | ')} |`;
}

const WAITS_NOTE = '_Durations leave out time the product spent waiting on the model provider; 429 waits are the '
  + 'candidate\u2019s total over all runs: the eval account\u2019s rate limit, infrastructure, never a task failure._';

const METRICS_NOTE = '_Mean wall, mean cost and cache hits show baseline → candidate. Wall time includes provider waits; '
  + 'cache hits are cache-read tokens / prompt tokens, excluding infrastructure trials. Tokens and cache hits count every '
  + 'agent\u2019s model calls, helpers and swarm nodes included, and cost is the whole workspace\u2019s spend. A dash means a '
  + 'count is missing, not zero or a rate over a subset._';

const MEASURE_LABEL: Record<Measure, { name: string; value: (amount: number) => string }> = {
  wallTimeMs: { name: 'wall time', value: seconds },
  modelSteps: { name: 'model steps', value: (amount) => amount.toFixed(1) },
  toolCalls: { name: 'tool calls', value: (amount) => amount.toFixed(1) },
  toolErrors: { name: 'tool errors', value: (amount) => amount.toFixed(1) },
  badInputCalls: { name: 'calls refused as bad input', value: (amount) => amount.toFixed(1) },
  unknownToolCalls: { name: 'calls to a tool not offered', value: (amount) => amount.toFixed(1) },
  inputTokens: { name: 'input tokens', value: tokens },
  outputTokens: { name: 'output tokens', value: tokens },
  costUsd: { name: 'cost', value: (amount) => usd(amount) },
};

/** A side's median, and its middle half in brackets: the spread a move must clear. */
function spreadOf(measure: Measure, side: Spread): string {
  const { value } = MEASURE_LABEL[measure];

  return `${value(side.median)} [${value(side.q1)}\u2013${value(side.q3)}]`;
}

/**
 * Per compared task, every measure and check that moved beyond noise (p < 0.05), baseline → candidate: where a change
 * moved the work, the first place to look for its cause. A pass rate that held while calls refused as bad input rose is
 * a description the model misreads, on its way to a failure.
 */
function movedSection(rows: readonly EvalComparisonRow[], shared: Shared): string[] {
  const moved = rows.flatMap((row) => {
    if (row.reason !== null) return [];

    const lines = [
      ...row.shifts.filter((shift) => shift.pValue < SIGNIFICANCE)
        .map((shift) => `${MEASURE_LABEL[shift.measure].name} ${spreadOf(shift.measure, shift.baseline)} \u2192 ${spreadOf(shift.measure, shift.candidate)} (p = ${shift.pValue.toFixed(2)})`),
      ...row.checks.filter((check) => check.pValue < SIGNIFICANCE)
        .map((check) => `\`${check.check}\` passed ${String(check.baseline.passed)}/${String(check.baseline.attempted)} \u2192 `
          + `${String(check.candidate.passed)}/${String(check.candidate.attempted)} (p = ${check.pValue.toFixed(2)})`),
    ];

    return lines.length === 0 ? [] : [`- **${rowName(row, shared)}**: ${lines.join('; ')}`];
  });

  const compared = rows.flatMap((row) => row.reason === null ? [row] : []);

  if (compared.length === 0) return [];

  // A measure a side did not record for every trial was not compared, which is not the same as not having moved.
  const unrecorded = compared.flatMap((row) => {
    const missing = MEASURE_NAMES.filter((measure) => !row.shifts.some((shift) => shift.measure === measure));

    return missing.length === 0 ? [] : [`${rowName(row, shared)}: ${missing.map((measure) => MEASURE_LABEL[measure].name).join(', ')}`];
  });

  return ['### What else moved beyond noise', '',
    ...moved.length > 0 ? moved : [`Nothing else that was compared moved beyond noise in the ${String(compared.length)} compared tasks, `
      + 'nor any check\u2019s pass rate.'],
    ...unrecorded.length > 0 ? ['', `Not compared, as not recorded for every trial on both sides: ${unrecorded.join('; ')}.`] : [],
    '', '_Medians, the middle half in brackets; a two-sided Mann\u2013Whitney test for the measures and Fisher\u2019s exact test for '
      + 'the checks. The pass and reset rates decide the verdict, and so does a rise in model steps, tokens or malformed calls, '
      + 'and a steady cache hit below 95% on Muse or Workers AI._', ''];
}

/** How the agent worked per model, the baseline in parentheses: information for a prompt or tool change. */
function profileTable(profiled: EvalComparison['profiles']): string[] {
  const lines = ['How the agent worked, per run over every task (information, not scored but for the steady cache hit; the baseline in parentheses):', '',
    '| Model | Runs | Model steps | Input tokens | Output tokens | Cache hit | Steady cache hit | Mean wall | Mean cost (USD) | `eval` share of tool calls |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];

  for (const { model, baseline: before, candidate: after } of profiled) {
    const cell = (value: (side: AgentProfile) => string) => `${value(after)}${before === null ? '' : ` (${value(before)})`}`;
    const share = (side: AgentProfile) => side.evalCallShare === null ? '\u2014' : `${(side.evalCallShare * 100).toFixed(0)}%`;

    lines.push(`| ${[model, String(after.runs), cell((side) => side.meanModelTurns.toFixed(1)),
      cell((side) => side.meanInputTokens === null ? '—' : tokens(side.meanInputTokens)), cell((side) => side.meanOutputTokens === null ? '—' : tokens(side.meanOutputTokens)),
      cell((side) => rate(side.cacheHitRate)), cell((side) => rate(side.steadyCacheHitRate)), cell((side) => seconds(side.meanWallTimeMs)),
      cell((side) => usd(side.meanCostUsd)), cell(share)].join(' | ')} |`);
  }

  return lines;
}

/** What failed in one task and why, for the person who has to fix it; nothing when every run passed cleanly. */
function failureSection(row: EvalComparisonRow, shared: Shared): string[] {
  const { candidate: side, baseline: before } = row;

  if (side === null) return [];
  const failed = side.trials - side.passed;

  if (failed === 0 && side.toolErrors.length === 0) return [];
  const outcome = failed === 0 ? `all ${String(side.trials)} runs passed` : `${String(failed)} of ${String(side.trials)} runs failed`;
  const lines = [`### ${rowName(row, shared)}: ${outcome}`, ''];

  if (side.failedChecks.length > 0) {
    lines.push('| Check | Baseline failed | Candidate failed |', '| --- | --- | --- |');

    for (const { check, trials: count } of side.failedChecks.slice(0, 8)) {
      const earlier = before?.failedChecks.find((failure) => failure.check === check)?.trials ?? 0;
      lines.push(`| \`${check}\` | ${before === null ? '\u2014' : String(earlier)} | ${String(count)} |`);
    }

    if (side.failedChecks.length > 8) lines.push(`| _${String(side.failedChecks.length - 8)} more checks_ | | |`);
    lines.push('');
  }

  const [top] = side.toolErrors;

  if (top !== undefined) {
    const others = side.toolErrors.length - 1;
    lines.push(`Most common tool error: \`${top.tool}\` ${quoted(top.message, 100)} \u00d7${String(top.count)}`
      + (others > 0 ? `, and ${String(others)} other kind${others === 1 ? '' : 's'}` : ''), '');
  }

  if (side.resets > 0) {
    lines.push(`Workspaces reset for memory, the build's own result: ${String(side.resets)} of ${String(side.trials)} runs`
      + `${before === null ? '' : ` (baseline ${String(before.resets)} of ${String(before.trials)})`}`, '');
  }

  if (side.infrastructureErrors.length > 0) {
    lines.push(`Infrastructure errors, not the agent's work: ${side.infrastructureErrors
      .map((error) => `${quoted(error.message, 100)} \u00d7${String(error.trials)}`).join(' \u00b7 ')}`, '');
  }

  return lines;
}

/**
 * The results comment: the verdict and the changed files the evals exercise, one table of every
 * task's scores and deltas, how the agent worked per model, then what failed and why, for the
 * person who has to fix it. What every row shares (the model, the arm, the trial count) is said once.
 */
export function renderEvalComparison(comparison: EvalComparison): string {
  const shared = sharedBy(comparison.rows);

  const header = [
    '# Eval results', '',
    `**Verdict: ${VERDICT[comparison.verdict]}.** ${verdictReason(comparison, shared)}`, '',
    exercisedLine(comparison), '',
    buildsLine(comparison, shared), '',
  ].filter((line, index, all) => line !== '' || all[index - 1] !== '');

  return [
    ...header,
    ...totalsTable(comparison.totals), '',
    ...SCORE_TABLE,
    ...comparison.rows.map((row) => scoreRow(row, shared)), '',
    ...movedSection(comparison.rows, shared),
    WAITS_NOTE, '',
    METRICS_NOTE, '',
    ...profileTable(comparison.profiles), '',
    ...renderRunReport(comparison),
    ...comparison.rows.flatMap((row) => failureSection(row, shared)),
  ].join('\n');
}
