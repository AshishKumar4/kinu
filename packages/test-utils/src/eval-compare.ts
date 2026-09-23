/**
 * Compare two eval runs with interval, denominator and decidability beside every number. The exact
 * floor rests on differing pairs (p ≤ 0.05 needs k ≥ 6); inadmissible runs yield a numberless refusal;
 * ragged runs intersect on `observationKey` and name what dropped; repeats collapse to one value per task.
 * Pairing follows pi's `pairObservations`/`summarizeCorrectness`; all inference comes from bench/stats.ts.
 */
import {
  DEFAULT_ALPHA, binomialTwoSidedP, floorPValue, fmtPp, minimumDetectableEffect,
  minimumPairsForSignificance, pairedBinaryComparison, pairedBootstrapCI, requiredPairs,
  type BootstrapOptions, type Interval, type PairedBinaryStats, type PairedOutcome,
} from '@kinu.run/core';
import { observationKey, type EvalArmState, type EvalObservation, type EvalRunRecord } from './eval-run';
import { TASK_OUTCOME, isCovariateRow } from './eval-outcome';

type ScoredObservation = Extract<EvalObservation, { outcome: 'scored' }>;

/** `treatment`: the one arm field an A/B varies; the rest must match. */
export type ComparisonOptions = BootstrapOptions & { power?: number; treatment?: ArmTreatment };

/** Below this, pass^k is pass@1 again or too coarse to read. */
export const PASS_HAT_K_FLOOR = 3;

const ARM_FIELDS = {
  evolution: (arm) => (arm.evolution ? 'ON' : 'OFF'),
  settle: (arm) => arm.settle,
  tools: (arm) => [...arm.tools].sort().join(', '),
  prompt: (arm) => arm.prompt ?? 'as written',
  effort: (arm) => arm.effort ?? 'model default',
} satisfies Record<string, (arm: EvalArmState) => string>;

export type ArmTreatment = keyof typeof ARM_FIELDS;

const ARM_TREATMENTS = Object.keys(ARM_FIELDS).filter((key): key is ArmTreatment => Object.hasOwn(ARM_FIELDS, key));

/** Differing pairs below which no exact paired test reaches p ≤ alpha, taken from the primitive. */
const MINIMUM_DIFFERING_PAIRS = minimumPairsForSignificance();

/** What counts as solving a task for the binary headline: the reliability view of the verifier's verdict. */
export const SOLVED_PREDICATE = `${TASK_OUTCOME} rate === 1 — every subgoal reached`;

function fullySolved(o: ScoredObservation): boolean | null {
  const row = o.scores.find((s) => s.name === TASK_OUTCOME);

  if (!row || row.eligible === 0 || row.rate === null) return null;

  return row.passed === row.eligible;
}

export interface ComparisonRefusal {
  readonly field: string;
  readonly detail: string;
}

export type PairDropReason =
  | 'missing-in-baseline'
  | 'missing-in-candidate'
  | 'baseline-not-scored'
  | 'candidate-not-scored'
  | 'baseline-unverified'
  | 'candidate-unverified';

const DROP_REASONS = {
  'missing-in-baseline': 'the baseline run never produced this task/repetition',
  'missing-in-candidate': 'the candidate run never produced this task/repetition',
  'baseline-not-scored': 'the baseline observation produced no scores',
  'candidate-not-scored': 'the candidate observation produced no scores',
  // No verdict: dropped, since a missing verifier is not a fact about the agent.
  'baseline-unverified': 'the baseline attempt recorded no task_outcome — it was never checked',
  'candidate-unverified': 'the candidate attempt recorded no task_outcome — it was never checked',
} satisfies Record<PairDropReason, string>;

export interface PairDiagnostic {
  readonly key: string;
  readonly reason: PairDropReason;
  readonly detail: string;
}

/** A task excluded from the binary headline because its repeats are ragged. */
export interface RaggedTask {
  readonly taskId: string;
  readonly pairedRepetitions: number;
  readonly repeats: number;
}

/** Which side ever had an eligible opportunity. Anything but `both` is a coverage change, not behaviour. */
export type ScorerReach = 'both' | 'baseline-only' | 'candidate-only' | 'neither';

export interface ScorerComparison {
  readonly name: string;
  readonly reach: ScorerReach;
  readonly baselineEligible: number;
  readonly candidateEligible: number;
  /** Tasks with a rate on both sides: the pairs every number below rests on. */
  readonly pairedTasks: number;
  /** Tasks whose observed opportunities lack a measured rate on either side. */
  readonly unmeasuredTasks: number;
  readonly baselineRate: number | null;
  readonly candidateRate: number | null;
  /** Mean per-task difference, candidate − baseline. Null when nothing was paired, never 0. */
  readonly effect: number | null;
  readonly ci: Interval | null;
  readonly pValue: number | null;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  /** Mean squared per-task rate difference, the dispersion `mde` came from. Zero means no pair differed,
   *  not a precise estimate. */
  readonly dispersion: number;
  /** wins + losses: the decidability denominator. */
  readonly differingPairs: number;
  readonly floorPValue: number;
  readonly canReachSignificance: boolean;
  readonly significant: boolean;
  readonly mde: number;
  readonly resolvable: boolean;
  readonly pairsNeeded: number;
  readonly verdict: string;
}

export interface PairedDelta {
  readonly tasks: number;
  readonly baselineMean: number;
  readonly candidateMean: number;
  readonly delta: number;
  readonly ci: Interval;
}

export interface EvalCostComparison {
  readonly tokensIn: PairedDelta;
  readonly tokensOut: PairedDelta;
  readonly reasoning: PairedDelta;
  readonly ms: PairedDelta;
}

export interface RefusedComparison {
  readonly comparable: false;
  readonly baselineRunId: string;
  readonly candidateRunId: string;
  readonly refusals: readonly ComparisonRefusal[];
}

export interface AttributableComparison {
  readonly comparable: true;
  readonly baselineRunId: string;
  readonly candidateRunId: string;
  readonly modelId: string;
  readonly repeats: number;
  readonly treatment: { readonly field: ArmTreatment; readonly baseline: string; readonly candidate: string } | null;
  readonly totalPairs: number;
  readonly eligiblePairs: number;
  readonly diagnostics: readonly PairDiagnostic[];
  readonly scorers: readonly ScorerComparison[];
  /** Did the agent solve the task outright, per {@link SOLVED_PREDICATE}. */
  readonly headline: PairedBinaryStats;
  readonly raggedTasks: readonly RaggedTask[];
  readonly cost: EvalCostComparison;
}

export type EvalComparison = RefusedComparison | AttributableComparison;

interface ObservationPair {
  readonly repetition: number;
  readonly baseline: ScoredObservation;
  readonly candidate: ScoredObservation;
}

interface TaskPairs {
  readonly taskId: string;
  readonly pairs: readonly ObservationPair[];
}

/** Facts whose difference makes a delta unattributable. Returned, not thrown, so it is not mistaken for a harness bug. */
function refusalsFor(
  baseline: EvalRunRecord, candidate: EvalRunRecord, treatment: ArmTreatment | undefined,
): ComparisonRefusal[] {
  const refusals: ComparisonRefusal[] = [];

  if (baseline.modelId !== candidate.modelId) {
    refusals.push({
      field: 'modelId',
      detail: `baseline ran ${baseline.modelId}, candidate ran ${candidate.modelId} — `
        + 'a model change and a code change cannot be separated in one delta',
    });
  }

  if (baseline.repeats !== candidate.repeats) {
    refusals.push({
      field: 'repeats',
      detail: `baseline ran ${String(baseline.repeats)} repeats, candidate ran `
        + `${String(candidate.repeats)} — the two rates average away different amounts of noise`,
    });
  }

  for (const field of ARM_TREATMENTS) {
    const before = ARM_FIELDS[field](baseline.arm);
    const after = ARM_FIELDS[field](candidate.arm);

    if (field === treatment) {
      if (before === after) {
        refusals.push({
          field: `arm.${field}`,
          detail: `declared as the treatment, but both runs have ${before}: there is no treatment to attribute`,
        });
      }

      continue;
    }

    if (before !== after) refusals.push({ field: `arm.${field}`, detail: armDifference(field, baseline, candidate) });
  }

  for (const [side, record] of [['baseline', baseline], ['candidate', candidate]] as const) {
    if (!record.admissibility.admissible) {
      refusals.push({
        field: `${side}.admissibility`,
        detail: `${record.runId} is not admissible evidence, so it has measured nothing to `
          + `compare: ${record.admissibility.failures.join('; ')}`,
      });
    }
  }

  return refusals;
}

function armDifference(field: ArmTreatment, baseline: EvalRunRecord, candidate: EvalRunRecord): string {
  if (field === 'tools') {
    const baselineOnly = baseline.arm.tools.filter((t) => !candidate.arm.tools.includes(t));
    const candidateOnly = candidate.arm.tools.filter((t) => !baseline.arm.tools.includes(t));

    return `tool surfaces differ — only in baseline: [${baselineOnly.join(', ')}], `
      + `only in candidate: [${candidateOnly.join(', ')}]`;
  }

  return `${field} ${ARM_FIELDS[field](baseline.arm)} in the baseline vs ${ARM_FIELDS[field](candidate.arm)} `
    + 'in the candidate — undeclared, so the delta would measure it rather than the change under test';
}

function scorerNames(record: EvalRunRecord): string[] {
  const names: string[] = [];

  for (const o of record.observations) {
    if (o.outcome !== 'scored') continue;

    for (const s of o.scores) if (!names.includes(s.name)) names.push(s.name);
  }

  return names;
}

/** Per-task differences of a continuous quantity, with a `pairedBootstrapCI` interval. */
function pairedMetric(
  tasks: readonly TaskPairs[],
  select: (o: ScoredObservation) => number,
  opts: ComparisonOptions,
): PairedDelta {
  const diffs: number[] = [];
  let sumBaseline = 0;
  let sumCandidate = 0;

  for (const task of tasks) {
    if (task.pairs.length === 0) continue;
    let baseline = 0;
    let candidate = 0;

    for (const pair of task.pairs) {
      baseline += select(pair.baseline);
      candidate += select(pair.candidate);
    }

    baseline /= task.pairs.length;
    candidate /= task.pairs.length;
    sumBaseline += baseline;
    sumCandidate += candidate;
    diffs.push(candidate - baseline);
  }

  const { mean, ci } = pairedBootstrapCI(diffs, opts);
  const n = diffs.length;

  return {
    tasks: n,
    baselineMean: n === 0 ? 0 : sumBaseline / n,
    candidateMean: n === 0 ? 0 : sumCandidate / n,
    delta: mean,
    ci,
  };
}

/** Collapse repetitions into one rate per task, keeping every observed opportunity and missing-attribution flags. */
function collectScorerSamples(name: string, tasks: readonly TaskPairs[]) {
  const diffs: number[] = [];
  let baselineEligible = 0;
  let candidateEligible = 0;
  let rateSumBaseline = 0;
  let rateSumCandidate = 0;
  let unmeasuredTasks = 0;

  for (const task of tasks) {
    let eligibleA = 0;
    let passedA = 0;
    let eligibleB = 0;
    let passedB = 0;
    let measured = true;

    for (const pair of task.pairs) {
      for (const s of pair.baseline.scores) {
        if (s.name !== name) continue;
        eligibleA += s.eligible;
        passedA += s.passed;

        if (s.eligible > 0 && s.rate === null) measured = false;
      }

      for (const s of pair.candidate.scores) {
        if (s.name !== name) continue;
        eligibleB += s.eligible;
        passedB += s.passed;

        if (s.eligible > 0 && s.rate === null) measured = false;
      }
    }

    baselineEligible += eligibleA;
    candidateEligible += eligibleB;

    if (!measured) { unmeasuredTasks++; continue; }

    if (eligibleA === 0 || eligibleB === 0) continue;
    const rateA = passedA / eligibleA;
    const rateB = passedB / eligibleB;
    rateSumBaseline += rateA;
    rateSumCandidate += rateB;
    diffs.push(rateB - rateA);
  }

  return { diffs, baselineEligible, candidateEligible, rateSumBaseline, rateSumCandidate, unmeasuredTasks };
}

function scorerReach(baselineEligible: number, candidateEligible: number): ScorerReach {
  if (baselineEligible > 0 && candidateEligible > 0) return 'both';

  if (baselineEligible > 0) return 'baseline-only';

  return candidateEligible > 0 ? 'candidate-only' : 'neither';
}

function compareScorer(
  name: string, tasks: readonly TaskPairs[], opts: ComparisonOptions, alpha: number,
): ScorerComparison {
  const { diffs, baselineEligible, candidateEligible, rateSumBaseline, rateSumCandidate, unmeasuredTasks } = collectScorerSamples(name, tasks);

  const pairedTasks = diffs.length;
  const hasMeasuredPairs = pairedTasks > 0 && unmeasuredTasks === 0;
  const wins = diffs.filter((d) => d > 0).length;
  const losses = diffs.filter((d) => d < 0).length;
  const differingPairs = wins + losses;
  const boot = hasMeasuredPairs ? pairedBootstrapCI(diffs, opts) : null;
  const dispersion = pairedTasks === 0 ? 0 : diffs.reduce((s, d) => s + d * d, 0) / pairedTasks;

  const mde = unmeasuredTasks > 0 ? Number.POSITIVE_INFINITY
    : minimumDetectableEffect({ pairs: pairedTasks, dispersion, alpha, power: opts.power });

  const pValue = binomialTwoSidedP(wins, differingPairs);
  const floor = floorPValue(differingPairs);
  const canReachSignificance = hasMeasuredPairs && differingPairs > 0 && floor <= alpha;
  const significant = hasMeasuredPairs && pValue < alpha;
  const effect = boot === null ? null : boot.mean;
  const resolvable = effect !== null && Number.isFinite(mde) && mde > 0 && Math.abs(effect) >= mde;

  const pairsNeeded = effect === null
    ? Number.POSITIVE_INFINITY
    : requiredPairs(effect, { dispersion, alpha, power: opts.power });

  const reach = scorerReach(baselineEligible, candidateEligible);

  const evidence = boot === null
    ? ''
    : ` [CI ${fmtPp(boot.ci.lo)}..${fmtPp(boot.ci.hi)}, ${String(differingPairs)} of `
      + `${String(pairedTasks)} paired tasks differed]`;

  let verdict: string;

  if (unmeasuredTasks > 0) {
    verdict = `UNMEASURED: ${String(unmeasuredTasks)} task(s) lack outcome attribution; `
      + 'observed opportunities remain counted, but this metric has no rate or effect to compare';
  } else if (reach === 'neither') {
    verdict = `never exercised — no paired observation in either run gave ${name} a single `
      + 'eligible opportunity, so there is no rate here to compare';
  } else if (reach === 'baseline-only') {
    verdict = `corpus reach changed — ${String(baselineEligible)} eligible opportunities in the `
      + 'baseline and none in the candidate; that is a change in what the corpus reached, not in '
      + 'behaviour';
  } else if (reach === 'candidate-only') {
    verdict = `corpus reach changed — ${String(candidateEligible)} eligible opportunities in the `
      + 'candidate and none in the baseline; that is a change in what the corpus reached, not in '
      + 'behaviour';
  } else if (boot === null) {
    verdict = 'exercised in both runs but never on the same task — no pair to compare';
  } else if (differingPairs < MINIMUM_DIFFERING_PAIRS) {
    verdict = `UNDECIDABLE: effect ${fmtPp(boot.mean)}, but only ${String(differingPairs)} paired `
      + 'tasks differed and the best two-sided p that many differing pairs can ever produce is '
      + `${floor.toFixed(4)} — ${String(MINIMUM_DIFFERING_PAIRS)} are needed to reach `
      + `p ≤ ${String(alpha)}${evidence}`;
  } else if (significant && resolvable) {
    verdict = `effect ${fmtPp(boot.mean)} is significant (p=${pValue.toFixed(4)}) and above the `
      + `design's resolution of ${fmtPp(mde)}${evidence}`;
  } else if (significant) {
    verdict = `effect ${fmtPp(boot.mean)} is significant (p=${pValue.toFixed(4)}) but below the `
      + `design's resolution of ${fmtPp(mde)} — suggestive, not established; `
      + `${String(pairsNeeded)} paired tasks would settle it${evidence}`;
  } else {
    verdict = `no detectable change: effect ${fmtPp(boot.mean)} (p=${pValue.toFixed(4)}); this `
      + `design resolves ${fmtPp(mde)}, so anything smaller is invisible to it${evidence}`;
  }

  return {
    name, reach, baselineEligible, candidateEligible, pairedTasks, unmeasuredTasks,
    baselineRate: hasMeasuredPairs ? rateSumBaseline / pairedTasks : null,
    candidateRate: hasMeasuredPairs ? rateSumCandidate / pairedTasks : null,
    effect, ci: boot === null ? null : boot.ci,
    pValue: hasMeasuredPairs ? pValue : null,
    wins, losses, ties: pairedTasks - differingPairs, dispersion,
    differingPairs, floorPValue: floor, canReachSignificance, significant,
    mde, resolvable, pairsNeeded, verdict,
  };
}

export function compareRuns(
  baseline: EvalRunRecord, candidate: EvalRunRecord, opts: ComparisonOptions = {},
): EvalComparison {
  const refusals = refusalsFor(baseline, candidate, opts.treatment);

  if (refusals.length > 0) {
    return {
      comparable: false,
      baselineRunId: baseline.runId, candidateRunId: candidate.runId, refusals,
    };
  }

  const alpha = opts.alpha ?? DEFAULT_ALPHA;

  const baselineByKey = new Map(baseline.observations.map((o) => [observationKey(o), o]));
  const candidateByKey = new Map(candidate.observations.map((o) => [observationKey(o), o]));
  const keys = [...new Set([...baselineByKey.keys(), ...candidateByKey.keys()])].sort();

  const diagnostics: PairDiagnostic[] = [];
  const pairsByTask = new Map<string, ObservationPair[]>();

  const drop = (key: string, reason: PairDropReason, extra = '') => {
    diagnostics.push({ key, reason, detail: `${DROP_REASONS[reason]}${extra}` });
  };

  for (const key of keys) {
    const a = baselineByKey.get(key);
    const b = candidateByKey.get(key);

    if (a === undefined) { drop(key, 'missing-in-baseline'); continue; }

    if (b === undefined) { drop(key, 'missing-in-candidate'); continue; }

    if (a.outcome !== 'scored') {
      drop(key, 'baseline-not-scored', ` (${a.outcome}: ${a.reason})`);
      continue;
    }

    if (b.outcome !== 'scored') {
      drop(key, 'candidate-not-scored', ` (${b.outcome}: ${b.reason})`);
      continue;
    }

    if (fullySolved(a) === null) {
      drop(key, 'baseline-unverified');
      continue;
    }

    if (fullySolved(b) === null) {
      drop(key, 'candidate-unverified');
      continue;
    }

    const pair: ObservationPair = { repetition: a.repetition, baseline: a, candidate: b };
    const existing = pairsByTask.get(a.taskId);

    if (existing === undefined) pairsByTask.set(a.taskId, [pair]);
    else existing.push(pair);
  }

  // Every task either run touched, so a task with no pair stays visible as an exclusion.
  const taskIds = [...new Set([
    ...baseline.observations.map((o) => o.taskId),
    ...candidate.observations.map((o) => o.taskId),
  ])].sort();

  const tasks: TaskPairs[] = taskIds.map((taskId) => ({
    taskId,
    pairs: (pairsByTask.get(taskId) ?? []).sort((x, y) => x.repetition - y.repetition),
  }));

  const eligiblePairs = tasks.reduce((n, t) => n + t.pairs.length, 0);

  // `pairedBinaryComparison` throws on ragged repeats; such tasks are excluded and named.
  const outcomes: PairedOutcome[] = [];
  const raggedTasks: RaggedTask[] = [];

  for (const task of tasks) {
    if (task.pairs.length !== baseline.repeats) {
      raggedTasks.push({
        taskId: task.taskId, pairedRepetitions: task.pairs.length, repeats: baseline.repeats,
      });
      continue;
    }

    outcomes.push({
      taskId: task.taskId,
      a: task.pairs.map((p) => fullySolved(p.baseline) === true),
      b: task.pairs.map((p) => fullySolved(p.candidate) === true),
    });
  }

  const names = [...new Set([...scorerNames(baseline), ...scorerNames(candidate)])].sort();

  return {
    comparable: true,
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    modelId: baseline.modelId,
    repeats: baseline.repeats,
    treatment: opts.treatment === undefined ? null : {
      field: opts.treatment,
      baseline: ARM_FIELDS[opts.treatment](baseline.arm),
      candidate: ARM_FIELDS[opts.treatment](candidate.arm),
    },
    totalPairs: keys.length,
    eligiblePairs,
    diagnostics,
    scorers: names.map((name) => compareScorer(name, tasks, opts, alpha)),
    headline: pairedBinaryComparison(outcomes, opts),
    raggedTasks,
    cost: {
      tokensIn: pairedMetric(tasks, (o) => o.tokensIn, opts),
      tokensOut: pairedMetric(tasks, (o) => o.tokensOut, opts),
      reasoning: pairedMetric(tasks, (o) => o.reasoningOut ?? 0, opts),
      ms: pairedMetric(tasks, (o) => o.ms, opts),
    },
  };
}

export function formatComparison(comparison: EvalComparison): string {
  const head = `comparison: ${comparison.baselineRunId} → ${comparison.candidateRunId}`;

  if (!comparison.comparable) {
    const lines = [head, '  REFUSED — this delta would be unattributable:'];

    for (const r of comparison.refusals) lines.push(`    ${r.field}: ${r.detail}`);

    return lines.join('\n');
  }

  const h = comparison.headline;

  const treated = comparison.treatment;

  const lines = [
    head,
    `  ${comparison.modelId}, ${String(comparison.repeats)} repeats`,
    treated === null
      ? '  treatment: none declared — every arm field matches'
      : `  treatment: arm.${treated.field} ${treated.baseline} → ${treated.candidate}`,
    `  pairs: ${String(comparison.eligiblePairs)} eligible of ${String(comparison.totalPairs)} `
      + '— both sides scored',
  ];

  for (const d of comparison.diagnostics) lines.push(`    dropped ${d.key}: ${d.detail}`);
  lines.push(`  OUTCOME, solved outright — success = ${SOLVED_PREDICATE}:`);
  lines.push(`    pass@1 ${h.passAtOneA.toFixed(3)} → ${h.passAtOneB.toFixed(3)}, `
    + `effect ${fmtPp(h.effect)} [CI ${fmtPp(h.ci.lo)}..${fmtPp(h.ci.hi)}, `
    + `${String(h.discordant)} of ${String(h.pairs)} tasks differed]`);
  lines.push(comparison.repeats >= PASS_HAT_K_FLOOR
    ? `    pass^${String(comparison.repeats)} ${h.passAllA.toFixed(3)} → ${h.passAllB.toFixed(3)} `
      + `(solved in all ${String(comparison.repeats)} attempts)`
    : `    pass^k not reported: ${String(comparison.repeats)} repeat(s) is below the floor of `
      + `${String(PASS_HAT_K_FLOOR)}`);
  lines.push(`    ${h.verdict}`);

  for (const t of comparison.raggedTasks) {
    lines.push(`    excluded from the headline: ${t.taskId} paired `
      + `${String(t.pairedRepetitions)} of ${String(t.repeats)} repetitions`);
  }

  // The continuous view of the same ground truth, printed as the metric rather than a covariate.
  const outcome = comparison.scorers.find((s) => !isCovariateRow(s.name));

  if (outcome) {
    lines.push('  OUTCOME, partial credit — mean per-task score:');

    const rates = outcome.baselineRate === null || outcome.candidateRate === null
      ? 'n/a — no task was verified on both sides'
      : `${outcome.baselineRate.toFixed(3)} → ${outcome.candidateRate.toFixed(3)}`;

    lines.push(`    ${rates}`);
    lines.push(`      ${outcome.verdict}`);
    lines.push(`      psi ${outcome.dispersion.toFixed(6)} measured over `
      + `${String(outcome.pairedTasks)} paired tasks; resolves ${fmtPp(outcome.mde)}`);
  }

  // Explanatory only, printed after the outcome so mechanism rates are not read as the result.
  lines.push('  covariates (mechanism telemetry — explanatory, never a score):');

  for (const s of comparison.scorers) {
    if (!isCovariateRow(s.name)) continue;

    const rates = s.baselineRate === null || s.candidateRate === null
      ? 'n/a'
      : `${s.baselineRate.toFixed(3)} → ${s.candidateRate.toFixed(3)}`;

    lines.push(`    ${s.name.padEnd(22)} ${rates}`);
    lines.push(`      ${s.verdict}`);
  }

  lines.push('  cost, paired per task:');

  const metrics = [
    ['tokens in ', comparison.cost.tokensIn],
    ['tokens out', comparison.cost.tokensOut],
    ['reasoning tokens', comparison.cost.reasoning],
    ['latency ms', comparison.cost.ms],
  ] as const;

  for (const [label, d] of metrics) {
    lines.push(`    ${label} ${d.baselineMean.toFixed(1)} → ${d.candidateMean.toFixed(1)} = `
      + `${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(1)} `
      + `[CI ${d.ci.lo.toFixed(1)}..${d.ci.hi.toFixed(1)} over ${String(d.tasks)} tasks]`);
  }

  return lines.join('\n');
}
