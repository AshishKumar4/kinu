/**
 * What changed between two eval runs — with the interval, the denominator and
 * the DECIDABILITY of the change stated beside every number.
 *
 * The owner's requirement is "report numbers and stats which we can compare
 * against previous versions/runs ... and thus be able to understand what works
 * and what doesnt". A bare rate delta cannot carry that, so this module is the
 * gate between "two runs exist" and "a claim about the difference".
 *
 * Four defects it exists to prevent, each of which has already produced a
 * believed number in this project:
 *
 * 1. THE FLOOR SITS ON THE DIFFERING PAIRS, NOT ON THE TASKS. `floorPValue(k)`
 *    is 2^(1−k) in the number of pairs that DIFFERED, and it first reaches
 *    ≤ 0.05 at k = 6. A live run reported a floor of 0.0625 from its 5 tasks
 *    while only 2 of them differed between arms — the true floor was 0.5, so no
 *    effect of any size was decidable there. Every scorer below reports its own
 *    differing-pair count, derives the floor from THAT count, and leads its
 *    verdict with UNDECIDABLE below six however large the observed effect.
 * 2. AN INADMISSIBLE RUN HAS MEASURED NOTHING. Two runs with zero graded turns
 *    would otherwise produce a neutral-looking delta over two empty sets, so the
 *    result is a union whose refusal branch carries NO numbers at all — the same
 *    trick `EvalObservation` uses to keep a score unreachable unless it exists.
 *    The refusal is decided UPSTREAM of every computation rather than alongside
 *    them, so there is no path on which an unattributable delta gets a number.
 * 3. REAL RUNS ARE RAGGED. `pairedBinaryComparison` throws unless every task
 *    shares one repeat count, and two independently produced runs will not.
 *    Observations are intersected on `observationKey`; everything unpairable is
 *    dropped BY NAME, never padded, never crashed on.
 * 4. REPEATS OF ONE TASK ARE NOT INDEPENDENT OBSERVATIONS. Every quantity here
 *    collapses a task's repetitions to one per-task value before any test sees
 *    it — `summarizeRepeats`'s pseudoreplication firewall, applied on this side
 *    of the boundary too, because a scorer rate would otherwise inflate
 *    significance multiplicatively in the repeat count.
 *
 * The pairing and the denominator discipline — `totalPairs` vs `eligiblePairs`,
 * and wins/losses/ties as McNemar's discordant cells — are pi's, from
 * external/pi/packages/evals/src/vitest-evals/summary.ts (`pairObservations`,
 * `summarizeCorrectness`). pi stops at a bare lift with neither an interval nor
 * a p-value; closing that gap is this module's whole job, and it adds no
 * statistics of its own: every inferential number is produced by an existing
 * primitive in packages/core/src/bench/stats.ts.
 */
import {
  DEFAULT_ALPHA, binomialTwoSidedP, floorPValue, fmtPp, minimumDetectableEffect,
  minimumPairsForSignificance, pairedBinaryComparison, pairedBootstrapCI, requiredPairs,
  type BootstrapOptions, type Interval, type PairedBinaryStats, type PairedOutcome,
} from '@kinu/core';
import { observationKey, type EvalObservation, type EvalRunRecord } from './eval-run';
import { TASK_OUTCOME, isCovariateRow } from './eval-outcome';

type ScoredObservation = Extract<EvalObservation, { outcome: 'scored' }>;

export type ComparisonOptions = BootstrapOptions & { power?: number };

/** Differing pairs below which NO exact paired test can reach p ≤ alpha. Six at
 *  alpha = 0.05, taken from the primitive rather than written down here. */
const MINIMUM_DIFFERING_PAIRS = minimumPairsForSignificance();

/**
 * What counts as having SOLVED a task for the binary headline.
 *
 * This replaced `turns > 0 && toolCalls > 0`, which was the ADMISSIBILITY
 * predicate serving as a pass rate. Every admissible observation satisfied it by
 * construction, so the headline read pass@1 1.000 → 1.000 over two full runs and
 * the dispersion measured on one arm run twice was exactly 0.0000: the metric
 * could not vary, and no corpus of any difficulty could have moved it. It is
 * retired rather than kept alongside, because two "success" numbers is how the
 * weaker one survives.
 *
 * The binary view is the RELIABILITY view of the same ground truth the
 * continuous `task_outcome` row reports — fully solved, not partially. Both are
 * functions of the verifier's verdict; neither is a fact about activity.
 */
export const SOLVED_PREDICATE = `${TASK_OUTCOME} rate === 1 — every subgoal reached`;

/**
 * True when the attempt solved the task outright, false when it did not, and
 * NULL when no verdict was recorded.
 *
 * The null is the load-bearing case. An observation with no `task_outcome` row
 * was never checked against ground truth, and scoring that as a failure would
 * charge the agent for a missing verifier — turning a gap in the corpus into a
 * fact about the model. The caller drops such a pair and names it.
 */
function fullySolved(o: ScoredObservation): boolean | null {
  const row = o.scores.find((s) => s.name === TASK_OUTCOME);
  if (!row || row.eligible === 0) return null;
  return row.passed === row.eligible;
}

/** A field whose difference makes the delta unattributable, and why. */
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
  // Not a failure. Nothing checked whether this attempt solved the task, so it
  // carries no outcome to compare — charging it as a loss would turn a missing
  // verifier into a fact about the agent.
  'baseline-unverified': 'the baseline attempt recorded no task_outcome — it was never checked',
  'candidate-unverified': 'the candidate attempt recorded no task_outcome — it was never checked',
} satisfies Record<PairDropReason, string>;

/** One pairing identity that could not contribute, named. */
export interface PairDiagnostic {
  /** `observationKey` — taskId#repetition. */
  readonly key: string;
  readonly reason: PairDropReason;
  readonly detail: string;
}

/** A task the binary headline could not accept: `pairedBinaryComparison` has no
 *  single pass^k across ragged repeats, so the task is excluded and named. */
export interface RaggedTask {
  readonly taskId: string;
  /** Repetitions both runs scored. */
  readonly pairedRepetitions: number;
  /** Repetitions the design declared. */
  readonly repeats: number;
}

/** Which side ever gave this scorer an eligible opportunity. Anything but `both`
 *  is a change in what the corpus REACHED, which is not a change in behaviour
 *  and must never be read as one. */
export type ScorerReach = 'both' | 'baseline-only' | 'candidate-only' | 'neither';

export interface ScorerComparison {
  readonly name: string;
  readonly reach: ScorerReach;
  /** Eligible opportunities across the paired observations, per side. */
  readonly baselineEligible: number;
  readonly candidateEligible: number;
  /** Tasks with a rate on BOTH sides — the pairs every number below rests on. */
  readonly pairedTasks: number;
  /** Mean per-task rate over those tasks; null when there are none. */
  readonly baselineRate: number | null;
  readonly candidateRate: number | null;
  /** candidate − baseline on the rate scale: `pairedBootstrapCI`'s mean of the
   *  per-task differences. Null when nothing was paired — never 0. */
  readonly effect: number | null;
  readonly ci: Interval | null;
  /** Exact two-sided p over the SIGNS of the per-task differences. */
  readonly pValue: number | null;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  /** psi: mean squared per-task rate difference — the dispersion `mde` was
   *  computed from, surfaced so a stated MDE arrives with the measurement it
   *  came from. Zero when no paired task differed, which means the arms were
   *  never separated here — NOT that the estimate is precise. */
  readonly dispersion: number;
  /** wins + losses. THE decidability denominator. */
  readonly differingPairs: number;
  /** Best two-sided p that many differing pairs could ever produce. */
  readonly floorPValue: number;
  readonly canReachSignificance: boolean;
  readonly significant: boolean;
  /** Smallest effect this design resolves at the requested power. */
  readonly mde: number;
  readonly resolvable: boolean;
  /** Paired tasks that would settle the observed effect. */
  readonly pairsNeeded: number;
  readonly verdict: string;
}

/** A paired continuous delta — cost or latency — with its interval. */
export interface PairedDelta {
  /** Tasks contributing one difference each; repetitions averaged first. */
  readonly tasks: number;
  readonly baselineMean: number;
  readonly candidateMean: number;
  /** candidate − baseline. */
  readonly delta: number;
  readonly ci: Interval;
}

export interface EvalCostComparison {
  readonly tokensIn: PairedDelta;
  readonly tokensOut: PairedDelta;
  /** Reasoning-token delta — the deliberation cost a prompt edit claims to cut. */
  readonly reasoning: PairedDelta;
  readonly ms: PairedDelta;
}

/** Two runs the harness refused to compare. Carries reasons and no numbers. */
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
  /** Every pairing identity either run produced — pi's `groups.length`. */
  readonly totalPairs: number;
  /** Those where BOTH sides scored — the only ones that contribute. */
  readonly eligiblePairs: number;
  readonly diagnostics: readonly PairDiagnostic[];
  readonly scorers: readonly ScorerComparison[];
  /** Did the agent SOLVE the task outright, per {@link SOLVED_PREDICATE} — the
   *  reliability view. The continuous partial-credit view of the same verdict is
   *  the `task_outcome` entry in `scorers`. */
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
  /** Repetitions both runs scored, ascending. */
  readonly pairs: readonly ObservationPair[];
}

/**
 * Facts whose difference makes a delta unattributable to the code under test.
 *
 * Not thrown: a refusal is a result the caller reports, and throwing would make
 * it indistinguishable from a harness bug.
 */
function refusalsFor(baseline: EvalRunRecord, candidate: EvalRunRecord): ComparisonRefusal[] {
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
  if (baseline.arm.evolution !== candidate.arm.evolution) {
    refusals.push({
      field: 'arm.evolution',
      detail: `evolution was ${baseline.arm.evolution ? 'ON' : 'OFF'} in the baseline and `
        + `${candidate.arm.evolution ? 'ON' : 'OFF'} in the candidate — such a delta measures `
        + 'the mechanism, not the change under test',
    });
  }
  if (baseline.arm.settle !== candidate.arm.settle) {
    refusals.push({
      field: 'arm.settle',
      detail: `settle policy ${baseline.arm.settle} in the baseline vs ${candidate.arm.settle} `
        + 'in the candidate',
    });
  }
  const baselineOnly = baseline.arm.tools.filter((t) => !candidate.arm.tools.includes(t));
  const candidateOnly = candidate.arm.tools.filter((t) => !baseline.arm.tools.includes(t));
  if (baselineOnly.length > 0 || candidateOnly.length > 0) {
    refusals.push({
      field: 'arm.tools',
      detail: `tool surfaces differ — only in baseline: [${baselineOnly.join(', ')}], `
        + `only in candidate: [${candidateOnly.join(', ')}]`,
    });
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

function scorerNames(record: EvalRunRecord): string[] {
  const names: string[] = [];
  for (const o of record.observations) {
    if (o.outcome !== 'scored') continue;
    for (const s of o.scores) if (!names.includes(s.name)) names.push(s.name);
  }
  return names;
}

/** pi's `summarizeMetric` with the interval it lacks: per-task differences of a
 *  continuous quantity, mean and CI from `pairedBootstrapCI`. */
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

/**
 * One scorer over the paired tasks.
 *
 * A task's repetitions are summed into one eligible/passed pair per side FIRST —
 * one vote per task — and only tasks with a non-zero denominator on both sides
 * enter the test, because a rate against zero opportunities is not a zero rate.
 */
function compareScorer(
  name: string, tasks: readonly TaskPairs[], opts: ComparisonOptions, alpha: number,
): ScorerComparison {
  const diffs: number[] = [];
  let baselineEligible = 0;
  let candidateEligible = 0;
  let rateSumBaseline = 0;
  let rateSumCandidate = 0;
  for (const task of tasks) {
    let eligibleA = 0;
    let passedA = 0;
    let eligibleB = 0;
    let passedB = 0;
    for (const pair of task.pairs) {
      for (const s of pair.baseline.scores) {
        if (s.name !== name) continue;
        eligibleA += s.eligible;
        passedA += s.passed;
      }
      for (const s of pair.candidate.scores) {
        if (s.name !== name) continue;
        eligibleB += s.eligible;
        passedB += s.passed;
      }
    }
    baselineEligible += eligibleA;
    candidateEligible += eligibleB;
    if (eligibleA === 0 || eligibleB === 0) continue;
    const rateA = passedA / eligibleA;
    const rateB = passedB / eligibleB;
    rateSumBaseline += rateA;
    rateSumCandidate += rateB;
    diffs.push(rateB - rateA);
  }

  const pairedTasks = diffs.length;
  const wins = diffs.filter((d) => d > 0).length;
  const losses = diffs.filter((d) => d < 0).length;
  const differingPairs = wins + losses;
  const boot = pairedTasks === 0 ? null : pairedBootstrapCI(diffs, opts);
  const dispersion = pairedTasks === 0 ? 0 : diffs.reduce((s, d) => s + d * d, 0) / pairedTasks;
  const mde = minimumDetectableEffect({ pairs: pairedTasks, dispersion, alpha, power: opts.power });
  const pValue = binomialTwoSidedP(wins, differingPairs);
  const floor = floorPValue(differingPairs);
  const canReachSignificance = differingPairs > 0 && floor <= alpha;
  const significant = pairedTasks > 0 && pValue < alpha;
  const effect = boot === null ? null : boot.mean;
  const resolvable = effect !== null && Number.isFinite(mde) && mde > 0 && Math.abs(effect) >= mde;
  const pairsNeeded = effect === null
    ? Number.POSITIVE_INFINITY
    : requiredPairs(effect, { dispersion, alpha, power: opts.power });
  const reach: ScorerReach = baselineEligible > 0 && candidateEligible > 0
    ? 'both'
    : baselineEligible > 0
      ? 'baseline-only'
      : candidateEligible > 0 ? 'candidate-only' : 'neither';

  // No effect is ever stated without its interval and its differing-pair count.
  const evidence = boot === null
    ? ''
    : ` [CI ${fmtPp(boot.ci.lo)}..${fmtPp(boot.ci.hi)}, ${String(differingPairs)} of `
      + `${String(pairedTasks)} paired tasks differed]`;
  let verdict: string;
  if (reach === 'neither') {
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
    name, reach, baselineEligible, candidateEligible, pairedTasks,
    baselineRate: pairedTasks === 0 ? null : rateSumBaseline / pairedTasks,
    candidateRate: pairedTasks === 0 ? null : rateSumCandidate / pairedTasks,
    effect, ci: boot === null ? null : boot.ci,
    pValue: pairedTasks === 0 ? null : pValue,
    wins, losses, ties: pairedTasks - differingPairs, dispersion,
    differingPairs, floorPValue: floor, canReachSignificance, significant,
    mde, resolvable, pairsNeeded, verdict,
  };
}

/**
 * Compare a candidate run against a baseline run.
 *
 * Refuses first, pairs second, computes only then — so no path exists on which a
 * delta that was never attributable acquires a number.
 */
export function compareRuns(
  baseline: EvalRunRecord, candidate: EvalRunRecord, opts: ComparisonOptions = {},
): EvalComparison {
  const refusals = refusalsFor(baseline, candidate);
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

  // Every task either run touched, so a task that produced no pair at all stays
  // visible as an exclusion instead of vanishing from the report.
  const taskIds = [...new Set([
    ...baseline.observations.map((o) => o.taskId),
    ...candidate.observations.map((o) => o.taskId),
  ])].sort();
  const tasks: TaskPairs[] = taskIds.map((taskId) => ({
    taskId,
    pairs: (pairsByTask.get(taskId) ?? []).sort((x, y) => x.repetition - y.repetition),
  }));
  const eligiblePairs = tasks.reduce((n, t) => n + t.pairs.length, 0);

  // pass^k has no meaning across ragged repeats, and `pairedBinaryComparison`
  // throws rather than pretend otherwise. Excluded tasks are named, not padded.
  const outcomes: PairedOutcome[] = [];
  const raggedTasks: RaggedTask[] = [];
  for (const task of tasks) {
    if (task.pairs.length !== baseline.repeats) {
      raggedTasks.push({
        taskId: task.taskId, pairedRepetitions: task.pairs.length, repeats: baseline.repeats,
      });
      continue;
    }
    // Non-null by construction: an attempt with no verdict was dropped above, so
    // every surviving pair carries one on both sides.
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

/** The comparison as a reader should see it: refusals first — there is nothing
 *  else to read when they exist — then the headline with its interval, then the
 *  per-scorer verdicts, then what it cost. */
export function formatComparison(comparison: EvalComparison): string {
  const head = `comparison: ${comparison.baselineRunId} → ${comparison.candidateRunId}`;
  if (!comparison.comparable) {
    const lines = [head, '  REFUSED — this delta would be unattributable:'];
    for (const r of comparison.refusals) lines.push(`    ${r.field}: ${r.detail}`);
    return lines.join('\n');
  }

  const h = comparison.headline;
  const lines = [
    head,
    `  ${comparison.modelId}, ${String(comparison.repeats)} repeats`,
    `  pairs: ${String(comparison.eligiblePairs)} eligible of ${String(comparison.totalPairs)} `
      + '— both sides scored',
  ];
  for (const d of comparison.diagnostics) lines.push(`    dropped ${d.key}: ${d.detail}`);
  lines.push(`  OUTCOME, solved outright — success = ${SOLVED_PREDICATE}:`);
  lines.push(`    pass@1 ${h.passAtOneA.toFixed(3)} → ${h.passAtOneB.toFixed(3)}, `
    + `effect ${fmtPp(h.effect)} [CI ${fmtPp(h.ci.lo)}..${fmtPp(h.ci.hi)}, `
    + `${String(h.discordant)} of ${String(h.pairs)} tasks differed]`);
  lines.push(`    ${h.verdict}`);
  for (const t of comparison.raggedTasks) {
    lines.push(`    excluded from the headline: ${t.taskId} paired `
      + `${String(t.pairedRepetitions)} of ${String(t.repeats)} repetitions`);
  }

  // The continuous view of the same ground truth, and the one a search can
  // climb. Printed as its own section rather than among the covariates, because
  // it is the metric and they are not.
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

  // Explanatory only. A reader who meets these before any statement of whether
  // the work got done will reason about mechanisms, which is how a delegation
  // rate of 15% came to be read as a fact about the agent rather than about the
  // corpus.
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
