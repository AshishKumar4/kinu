import { basename } from 'node:path';
import { renderThrownChain } from '@kinu.run/core/obs';
import { redact } from './redact';
import { parseResults, trials, type Assertion, type EvalFile, type HarnessRun } from './results';
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

/**
 * One task/model/arm cohort. `reason` is null exactly when both sides compare, and then `pValue` is the two-sided
 * Fisher exact test on the pass counts and `resetPValue` the same test on the reset counts.
 */
export type EvalComparisonRow = Identity & (
  | { reason: null; baseline: EvalStats; candidate: EvalStats; pValue: number; resetPValue: number }
  | { reason: string; baseline: EvalStats | null; candidate: EvalStats | null }
);

/**
 * `regressed` when any comparable task's pass rate fell significantly (p < 0.05), or its workspaces
 * reset for memory significantly more often, `improved` when some rose and none of that happened,
 * `unchanged` when none moved beyond noise, `inconclusive` when nothing could be compared.
 */
export type EvalVerdict = 'improved' | 'regressed' | 'unchanged' | 'inconclusive';

/** What one report measured: the deployed build, and the commit whose task definitions it ran. */
export type EvalSide = { productSha: string; evalCommit: string };

/** How the agent worked on one model across every task of one report: information, not a verdict. */
export type AgentProfile = {
  runs: number;
  meanModelTurns: number;
  meanInputTokens: number | null;
  meanOutputTokens: number;
  meanWallTimeMs: number;
  meanCostUsd: number | null;
  cacheHitRate: number | null;
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
};

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
  const cost = totalCostUsd(runs);

  return {
    runs: runs.length,
    meanModelTurns: mean(runs.map((run) => run.output.metrics.modelTurns)),
    meanInputTokens: inputs.length === runs.length ? mean(inputs) : null,
    meanOutputTokens: mean(runs.map((run) => run.usage.outputTokens)),
    meanWallTimeMs: mean(assertions.map((assertion) => assertion.duration)),
    meanCostUsd: cost === null ? null : cost / runs.length,
    cacheHitRate: cacheHitRate(assertions),
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

function infrastructureMessage(assertion: Assertion): string {
  const run = assertion.meta.harness.run;
  const turn = run.output.turns.find(({ outcome }) => outcome.status === 'error');

  return turn?.outcome.message ?? run.errors[0]?.message.split('\n')[0] ?? 'infrastructure failure';
}

function stats({ assertions }: Cohort): EvalStats {
  const runs = assertions.map((assertion) => assertion.meta.harness.run);
  const metrics = runs.map((run) => run.output.metrics);
  const cost = totalCostUsd(runs);

  // A turn the deployment refused or reset failed on the build, so it is listed with the checks, its answer as the evidence.
  const failedChecks = countBy(runs.flatMap((run) => run.output.turns.flatMap((turn, index) => [
    ...turn.outcome.status === 'refused' || turn.outcome.status === 'reset'
      ? [{ id: `deployment.${turn.outcome.status}`, evidence: turn.outcome.message }]
      : [],
    ...turn.checks.filter((check) => !check.pass),
  ].map((check) => ({
    check: `t${String(index + 1)} ${check.id}`,
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
  const files = parseResults('baseline', text);

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

function passRate(side: EvalStats): number {
  return side.passed / side.trials;
}

/** Whether a compared cohort's workspaces reset for memory significantly more often than the baseline's. */
function resetMore(row: ComparedRow): boolean {
  return row.resetPValue < SIGNIFICANCE && row.candidate.resets > row.baseline.resets;
}

function verdictOf(rows: readonly EvalComparisonRow[]): EvalVerdict {
  const compared = rows.flatMap((row) => row.reason === null ? [row] : []);

  if (compared.length === 0) return 'inconclusive';
  const moved = compared.filter((row) => row.pValue < SIGNIFICANCE);

  if (moved.some((row) => passRate(row.candidate) < passRate(row.baseline)) || compared.some(resetMore)) return 'regressed';

  return moved.length > 0 ? 'improved' : 'unchanged';
}

/** Compare two reports. With no baseline, every row is the candidate's alone and the verdict is inconclusive. */
export function compareEvalResults(baselineText: string | null, candidateText: string, questions: CommitQuestions = {}): EvalComparison {
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
    };
  }).sort((left, right) => left.taskId.localeCompare(right.taskId)
    || left.model.localeCompare(right.model) || left.arm.localeCompare(right.arm));

  return {
    baseline, candidate, verdict: verdictOf(rows),
    changedFiles: baseline === null ? [] : questions.changedFiles?.(baseline.productSha, candidate.productSha) ?? [],
    rows,
    totals: {
      baseline: baselineText === null ? null : suiteTotals(baselineFiles, baselineAssertions),
      candidate: suiteTotals(candidateFiles, candidateAssertions),
    },
    profiles: profiles(baselineAssertions, candidateAssertions),
  };
}

// ── The results comment ─────────────────────────────────────────────

/** A typographic minus for a fall, a plus for a rise, nothing for no change. */
function sign(value: number): string {
  if (value === 0) return '';

  return value > 0 ? '+' : '\u2212';
}

function signed(value: number, digits: number, unit = ''): string {
  return `${sign(value)}${Math.abs(value).toFixed(digits)}${unit}`;
}

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

function tokens(count: number): string {
  if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`;

  return count >= 1e3 ? `${(count / 1e3).toFixed(0)}k` : count.toFixed(0);
}

function minutes(ms: number): string {
  return `${(ms / 60_000).toFixed(0)} min`;
}

function usd(cost: number | null): string {
  return cost === null ? '—' : `$${cost.toFixed(4)}`;
}

function rate(hit: number | null): string {
  return hit === null ? '—' : `${(hit * 100).toFixed(1)}%`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
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

  const falls = moved.filter((row) => passRate(row.candidate) < passRate(row.baseline)).map(change);
  const rises = moved.filter((row) => passRate(row.candidate) > passRate(row.baseline)).map(change);

  const resets = comparison.rows.flatMap((row) => row.reason === null && resetMore(row)
    ? [`${rowName(row, shared)} ${String(row.baseline.resets)}/${String(row.baseline.trials)} \u2192 `
      + `${String(row.candidate.resets)}/${String(row.candidate.trials)} (p = ${row.resetPValue.toFixed(2)})`]
    : []);

  switch (comparison.verdict) {
    case 'inconclusive': return `No task can be compared: ${[...new Set(comparison.rows.flatMap((row) => row.reason ?? []))].join(', ')}.`;
    case 'unchanged': return `No task moved beyond what ${shared.trials === null ? 'these' : String(shared.trials)} runs can tell apart from noise.`;
    case 'improved': return `Rose: ${rises.join(', ')}.`;
    case 'regressed': return [
      ...falls.length > 0 ? [`Fell: ${falls.join(', ')}.`] : [],
      ...resets.length > 0 ? [`Reset for memory more often: ${resets.join(', ')}.`] : [],
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
  + 'cache hits are cache-read tokens / prompt tokens, excluding infrastructure trials. A dash means a count is missing, '
  + 'not zero or a rate over a subset._';

/** How the agent worked per model, the baseline in parentheses: information for a prompt or tool change. */
function profileTable(profiled: EvalComparison['profiles']): string[] {
  const lines = ['How the agent worked, per run over every task (information, not scored; the baseline in parentheses):', '',
    '| Model | Runs | Model steps | Input tokens | Output tokens | Cache hit | Mean wall | Mean cost (USD) | `eval` share of tool calls |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'];

  for (const { model, baseline: before, candidate: after } of profiled) {
    const cell = (value: (side: AgentProfile) => string) => `${value(after)}${before === null ? '' : ` (${value(before)})`}`;
    const share = (side: AgentProfile) => side.evalCallShare === null ? '\u2014' : `${(side.evalCallShare * 100).toFixed(0)}%`;

    lines.push(`| ${[model, String(after.runs), cell((side) => side.meanModelTurns.toFixed(1)),
      cell((side) => side.meanInputTokens === null ? '—' : tokens(side.meanInputTokens)), cell((side) => tokens(side.meanOutputTokens)),
      cell((side) => rate(side.cacheHitRate)), cell((side) => seconds(side.meanWallTimeMs)), cell((side) => usd(side.meanCostUsd)), cell(share)].join(' | ')} |`);
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
    WAITS_NOTE, '',
    METRICS_NOTE, '',
    ...profileTable(comparison.profiles), '',
    ...comparison.rows.flatMap((row) => failureSection(row, shared)),
  ].join('\n');
}
