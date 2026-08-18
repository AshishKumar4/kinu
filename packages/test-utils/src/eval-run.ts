/**
 * What one eval run WAS, recorded so a later run can be compared against it.
 *
 * The owner's requirement is "report numbers and stats which we can compare
 * against previous versions/runs". A pass rate does not survive that on its own:
 * two runs differing in model, in tool surface, or in whether evolution was even
 * wired on are not comparable, and nothing in a bare number says so. So a run
 * record carries the facts that make it comparable, and the comparator refuses
 * pairs whose arms differ in ways that would make a delta unattributable.
 *
 * THE CENTRAL RULE, and the reason this module exists rather than a JSON blob:
 * A RUN IS NOT ADMISSIBLE EVIDENCE UNTIL THE HARNESS HAS ASSERTED THE MECHANISM
 * SUBSTANTIVELY WORKED — not merely that it was configured on. That is not a
 * theory. CL-Bench's first live run reported mean_gain -0.2 over 5 tasks with
 * evolution firing 14 times in 14 turns, every outcome recorded as
 * "ungraded (no follow-up) | 0 tool calls | 1 steps", the workspace ending at
 * scaffoldVersion 0 / searchNodeCount 0 / craftedToolCount 0. The contrast was
 * inert and the number looked like a measurement. `admissibility` below is the
 * gate that makes that state fail loudly instead of reporting -20pp.
 *
 * The observation shape and the pairing key are pi's (external/pi/packages/evals
 * /src/vitest-evals/summary.ts) rather than invented here: an outcome union that
 * makes a score unreachable unless the observation was scored, and a pairing
 * identity of repetition + task id. pi owns that collector design; the
 * statistics stay ours (packages/core/src/bench).
 */
import { execFileSync } from 'node:child_process';
import * as v from 'valibot';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  BUILTIN_TOOLS, minimumPairsForSignificance, requiredPairs,
  type SqlExecutor,
} from '@proteus/core';
import { gitEnv } from './git';
import { BEHAVIOUR_SCORERS, type BehaviourScorer } from './agent-evals';
import { TASK_OUTCOME, isCovariateRow } from './eval-outcome';

/**
 * The two DeepSeek arms, verified against the account's own model list rather
 * than assumed. `proteus`'s default is the pro id; the flash id is NOT derivable
 * from it — the suffixes differ (`-0813` vs `-0731`) — so it is recorded here
 * having been read from the live catalogue:
 *
 *   curl -H "Authorization: Bearer $PROTEUS_TOKEN" \
 *     $PROTEUS_ORIGIN/api/user/ai/v1/models | jq -r '.data[].id'
 *
 * The split is the owner's: flash for high-volume runs that produce the stats,
 * pro for a small number of runs that establish the upper bound. Declared as a
 * property of a run so a record says which regime produced it, because a 40-pair
 * flash number and a 4-pair pro number invite completely different readings.
 */
export const EVAL_MODELS = {
  flash: '@cf/deepseek-ai/deepseek-v4-flash-0731',
  pro: '@cf/deepseek-ai/deepseek-v4-pro-0813',
} as const satisfies Record<string, string>;

export type EvalTier = keyof typeof EVAL_MODELS;

/**
 * Every optional mechanism's position, recorded because a measurement whose
 * mechanism was switched off is not a measurement of that mechanism.
 *
 * `evolution` is the one that has already cost a run: `LocalAgentSession` takes
 * `noAutoEvolve`, so an eval suite can silently produce a corpus with the
 * learning loop disabled and report the result as though it had been on.
 */
export interface EvalArmState {
  /** Auto-evolution wired on — the inverse of LocalAgentSession's noAutoEvolve. */
  readonly evolution: boolean;
  /** Fork settle policy in force, or 'none' when forks were never offered. */
  readonly settle: string;
  /** The tool surface actually offered, from BUILTIN_TOOLS. */
  readonly tools: readonly string[];
}

/** The full builtin tool surface, read through the registry so a tool added
 *  there widens recorded runs instead of leaving a stale list beside the single
 *  source (`BUILTIN_TOOLS` / `TOOL_REACH` in core/src/tools/registry.ts). */
export const FULL_TOOL_SURFACE: readonly string[] = [...BUILTIN_TOOLS];

/** pi's outcome union. A score is REACHABLE ONLY when the observation was
 *  scored, so an inert or errored trajectory cannot contribute a number — the
 *  property that makes `0` distinguishable from "never ran" in the type system
 *  rather than in a reviewer's memory. */
export type EvalOutcome = 'scored' | 'inert' | 'errored' | 'skipped';

/** One scorer's verdict, flattened for persistence. */
export interface EvalScoreRow {
  readonly name: string;
  readonly asserts: string;
  readonly eligible: number;
  readonly passed: number;
  readonly rate: number | null;
  readonly detail: string;
  /**
   * Raw measured quantities behind the score, when it came from a measurement
   * rather than a count — elapsed ms, an operation count, the reference baseline
   * a ratio was divided by.
   *
   * Structured rather than folded into `detail` because a ratio is only
   * reproducible if what it was divided by survives beside it. Written by
   * `outcomeRow` (eval-outcome.ts); the mechanism scorers do not set it.
   */
  readonly measured?: Readonly<Record<string, number>>;
}

/** One task attempted once. `repetition` plus `taskId` is the pairing identity;
 *  two runs are comparable exactly where both produced the same pair. */
export type EvalObservation =
  | {
    readonly taskId: string;
    readonly repetition: number;
    readonly outcome: 'scored';
    readonly scores: readonly EvalScoreRow[];
    /** Turns the ledger recorded closing. Zero is inert, never scored. */
    readonly turns: number;
    readonly toolCalls: number;
    /**
     * The tools this attempt actually called, in order.
     *
     * The harness has always computed this and the record dropped it, which is
     * why "did the agent ever enter codemode" had to be re-derived from source
     * twice instead of read off the artifact. It is the cheapest possible
     * covariate and it explains outcomes directly: a run whose tool list contains
     * no `execute_tools` cannot have crafted anything, and one that never touched
     * `file` produced no gradable edit signal however well it did the task.
     *
     * Optional for exactly one reason: `tests/eval/runs/flash-a.json` and
     * `flash-b.json` were written before it was recorded, and they are the only
     * baseline this tier has. Every record written from now on sets it. Read it
     * with `?? []` rather than assuming presence.
     */
    readonly toolNames?: readonly string[];
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly ms: number;
  }
  | {
    readonly taskId: string;
    readonly repetition: number;
    readonly outcome: Exclude<EvalOutcome, 'scored'>;
    readonly reason: string;
    readonly scores?: never;
  };

/** The pairing key, pi's identity: the task and which repetition of it. */
export function observationKey(o: Pick<EvalObservation, 'taskId' | 'repetition'>): string {
  return `${o.taskId}#${String(o.repetition)}`;
}

/**
 * Why a run is or is not admissible evidence.
 *
 * Each field is a fact about the trajectory corpus, not about configuration.
 * `outcomesScored` is the one that matters: a run that measured no task outcome
 * says nothing about whether the agent can do the work, whatever else it
 * recorded.
 *
 * `mechanismsExercised` USED TO BE that field, and its removal from the failure
 * list is deliberate. "A scorer had a non-zero denominator" is a fact about what
 * the corpus reached, and treating it as a precondition for evidence made
 * mechanism coverage an end in itself — which is how a delegation rate of 15%
 * came to be reported as a defect when the truth was that the mechanism
 * converted 4/4 wherever the work was genuinely divisible and 0/21 where it was
 * not. Both fields stay, in full, as TELEMETRY: they are how a moved outcome
 * gets explained after the fact. Neither gates anything.
 */
export interface EvalAdmissibility {
  readonly admissible: boolean;
  /** Observations that produced scores. */
  readonly scored: number;
  /** Observations that ran and recorded nothing gradable — CL-Bench's state. */
  readonly inert: number;
  /** Turns the ledger recorded across the whole run. A run with zero graded
   *  turns has measured nothing, whatever its pass rate says. */
  readonly gradedTurns: number;
  /** Tool calls across the run. Zero means no agent behaviour occurred. */
  readonly toolCalls: number;
  /** Observations carrying a `task_outcome` row — the count of attempts whose
   *  RESULT was actually checked against ground truth. */
  readonly outcomesScored: number;
  /** Scorers that had at least one eligible opportunity somewhere in the run.
   *  Covariate telemetry: reported, never gating. */
  readonly mechanismsExercised: readonly string[];
  /** Scorers no task in this corpus gave a single opportunity to. Covariate
   *  telemetry: reported, never gating. */
  readonly mechanismsAbsent: readonly string[];
  /** Why it is inadmissible, empty when it is. */
  readonly failures: readonly string[];
}

/** A complete run: what it ran, under what, and what it found. */
export interface EvalRunRecord {
  readonly schema: 1;
  readonly runId: string;
  readonly createdAt: string;
  /** The commit the code under test was at, and whether the tree was dirty.
   *  A dirty tree makes a run unreproducible and must be visible in the record,
   *  not discovered later. */
  readonly gitSha: string;
  readonly gitDirty: boolean;
  readonly tier: EvalTier;
  readonly modelId: string;
  readonly repeats: number;
  readonly seed: number;
  readonly arm: EvalArmState;
  /** Task ids the run DECLARED it would attempt. */
  readonly declaredTasks: readonly string[];
  /** Task ids it actually attempted. The set a run measures and the set it
   *  claims to govern must be the same set, and `admissibility` asserts it. */
  readonly executedTasks: readonly string[];
  readonly observations: readonly EvalObservation[];
  readonly admissibility: EvalAdmissibility;
  readonly spend: { readonly calls: number; readonly tokensIn: number; readonly tokensOut: number };
  /**
   * Directory holding the run's agent stores — the trajectories the scores were
   * computed from.
   *
   * Required, like every other provenance field here: an optional evidence
   * pointer is the field that will be missing exactly when someone needs it.
   * The tier used to write these under `/tmp` and delete them in teardown, so a
   * published tool-failure count named no call and could not be investigated at
   * all. `resolveArtifactRoot` (scripts/bench-retention.ts) is what refuses a
   * swept location, and there is no opt-out.
   */
  readonly transcripts: string;
}

/**
 * What this design can and cannot resolve, computed BEFORE anything is spent.
 *
 * CL-Bench reported a gain over 5 tasks of which only 2 differed between arms;
 * the smallest two-sided p that 2 differing pairs can produce is 0.5, so no
 * outcome on that split could have been significant at any effect size. Stating
 * that up front is the difference between a null result and a wasted bill.
 */
export interface EvalPreRegistration {
  readonly tasks: number;
  readonly repeats: number;
  readonly pairs: number;
  /** Fewest differing pairs at which significance is reachable at all. */
  readonly minimumPairs: number;
  /** ψ the required sizes below were computed from. */
  readonly dispersion: number;
  /** False when `dispersion` is the neutral 0.5 assumption rather than a number
   *  measured by running one arm twice. A required size quoted from an assumed
   *  dispersion is a guess with a decimal point, and the note says so. */
  readonly dispersionMeasured: boolean;
  /** Tasks needed to resolve a 10 / 20 percentage-point effect at 80% power. */
  readonly pairsFor10pp: number;
  readonly pairsFor20pp: number;
  readonly canReachSignificance: boolean;
  readonly note: string;
}

/**
 * @param measuredDispersion ψ measured by running ONE arm twice on this very
 *   corpus (`scripts/eval-dispersion.ts`). Omit it and the neutral 0.5 is used
 *   AND LABELLED as assumed — a required size computed from a guessed dispersion
 *   must not read like a measurement.
 */
export function preRegister(
  tasks: number, repeats: number, measuredDispersion?: number,
): EvalPreRegistration {
  const minimumPairs = minimumPairsForSignificance();
  // 0.5 is the neutral assumption before any data exists. A measured run
  // replaces it, and `dispersionMeasured` records which of the two this is.
  const dispersionMeasured = measuredDispersion !== undefined && measuredDispersion > 0;
  const dispersion = dispersionMeasured ? measuredDispersion : 0.5;
  const pairsFor10pp = requiredPairs(0.10, { dispersion });
  const pairsFor20pp = requiredPairs(0.20, { dispersion });
  const canReachSignificance = tasks >= minimumPairs;
  const basis = dispersionMeasured
    ? `psi ${dispersion.toFixed(6)} MEASURED on this corpus`
    : `psi ${dispersion.toFixed(2)} ASSUMED — no same-arm pair measured yet`;
  return {
    tasks, repeats, pairs: tasks, minimumPairs, dispersion, dispersionMeasured,
    pairsFor10pp, pairsFor20pp, canReachSignificance,
    note: canReachSignificance
      ? `${String(tasks)} pairs can reach significance; resolving 20pp at 80% power needs `
        + `${String(pairsFor20pp)} (${basis})`
      : `${String(tasks)} pairs CANNOT reach significance at any effect size — `
        + `${String(minimumPairs)} is the floor (${basis})`,
  };
}

/**
 * Score every behavioural instrument against one trajectory's store.
 *
 * A scorer that throws is not silently dropped. Its event type failing the
 * canonical parse means the ledger is corrupt for that mechanism, and a corrupt
 * reward signal must not degrade into a missing row that reads as an absent
 * mechanism.
 */
export function scoreTrajectory(
  sql: SqlExecutor, scorers: readonly BehaviourScorer[] = BEHAVIOUR_SCORERS,
): EvalScoreRow[] {
  return scorers.map((scorer) => {
    const score = scorer.score(sql);
    return {
      name: scorer.name, asserts: scorer.asserts,
      eligible: score.eligible, passed: score.passed, rate: score.rate, detail: score.detail,
    };
  });
}

/**
 * Is this run evidence?
 *
 * Deliberately strict on the things that have already produced a
 * believed-but-meaningless number, and deliberately silent on how WELL the agent
 * did. A run where the agent solved nothing is perfectly admissible — that is a
 * finding, and the most useful kind. A run that never checked whether it solved
 * anything is not evidence about task performance at all.
 *
 * That last condition replaced "no mechanism was exercised". Mechanism coverage
 * is not a precondition for evidence; measuring the OUTCOME is.
 */
export function assessAdmissibility(
  declaredTasks: readonly string[],
  observations: readonly EvalObservation[],
): EvalAdmissibility {
  const scored = observations.filter((o) => o.outcome === 'scored');
  const inert = observations.filter((o) => o.outcome === 'inert').length;
  const gradedTurns = scored.reduce((n, o) => n + o.turns, 0);
  const toolCalls = scored.reduce((n, o) => n + o.toolCalls, 0);

  const outcomesScored = scored
    .filter((o) => o.scores.some((s) => s.name === TASK_OUTCOME)).length;

  // Covariates only. The outcome row is not a mechanism, and letting it into
  // this set would put the primary metric back inside the mechanism-coverage
  // framing this field was just demoted out of.
  const exercised = new Set<string>();
  for (const o of scored) {
    for (const s of o.scores) if (s.eligible > 0 && isCovariateRow(s.name)) exercised.add(s.name);
  }
  const allNames = BEHAVIOUR_SCORERS.map((s) => s.name);

  const executed = new Set(observations.map((o) => o.taskId));
  const missing = declaredTasks.filter((id) => !executed.has(id));

  const failures: string[] = [];
  if (scored.length === 0) failures.push('no observation was scored — nothing to measure');
  if (gradedTurns === 0) failures.push('zero graded turns — the ledger recorded no closed turn');
  if (toolCalls === 0) failures.push('zero tool calls — no agent behaviour occurred');
  if (outcomesScored === 0 && scored.length > 0) {
    failures.push('no observation carried a task_outcome row — this run measured activity, '
      + 'not whether any task was solved, so it is not evidence about task performance');
  }
  // The set a run measures must equal the set it declares.
  if (missing.length > 0) {
    failures.push(`declared ${String(declaredTasks.length)} tasks but never attempted ${missing.join(', ')}`);
  }

  return {
    admissible: failures.length === 0,
    scored: scored.length, inert, gradedTurns, toolCalls, outcomesScored,
    mechanismsExercised: [...exercised].sort(),
    mechanismsAbsent: allNames.filter((n) => !exercised.has(n)),
    failures,
  };
}

/** The commit the code under test was at, and whether the tree was dirty. */
export interface GitProvenance {
  readonly gitSha: string;
  readonly gitDirty: boolean;
}

/** Uses `gitEnv` so the caller's GIT_DIR/GIT_WORK_TREE cannot redirect this at
 *  the wrong repository — the pre-push hook exports GIT_DIR, and a fixture that
 *  ignored that wrote into the real checkout. */
export function gitProvenance(cwd: string): GitProvenance {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' }).trim();
  return { gitSha: git('rev-parse', 'HEAD'), gitDirty: git('status', '--porcelain') !== '' };
}

export function writeRunRecord(path: string, record: EvalRunRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

/** The version marker every stored record must carry. Validated rather than
 *  trusted: a record is a persisted blob, and a schema bump has to fail loudly
 *  here instead of surfacing as an undefined field inside a comparison. */
const RecordEnvelopeSchema = v.looseObject({ schema: v.literal(1) });

export function readRunRecord(path: string): EvalRunRecord {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const envelope = v.safeParse(RecordEnvelopeSchema, raw);
  if (!envelope.success) {
    throw new Error(`${path}: not an eval run record of schema 1 — `
      + envelope.issues.map((issue) => issue.message).join('; '));
  }
  // SAFETY: the envelope parse above has confirmed this file carries `schema: 1`,
  // and a schema-1 file is only ever produced by `writeRunRecord` in this module
  // from an `EvalRunRecord`. Re-validating every nested field would restate the
  // whole type as a second declaration free to drift from the first.
  return raw as EvalRunRecord;
}

/**
 * A run record as a reader should see it: what it ran, whether it is evidence,
 * then THE OUTCOME, then the mechanism covariates under a heading that says so.
 *
 * The ordering and the heading are the point. A reader who meets eight mechanism
 * rates before any statement of whether the work got done will reason about
 * mechanisms, and that is how "delegation converted 15% of eligible turns" came
 * to be read as a finding about the agent rather than about the corpus.
 */
export function formatRunRecord(record: EvalRunRecord): string {
  const a = record.admissibility;
  const lines = [
    `run ${record.runId} — ${record.tier} (${record.modelId})`,
    `  commit ${record.gitSha.slice(0, 9)}${record.gitDirty ? ' [DIRTY — unreproducible]' : ''}`,
    `  arm: evolution ${record.arm.evolution ? 'ON' : 'OFF'}, settle ${record.arm.settle}, `
      + `${String(record.arm.tools.length)} tools`,
    `  tasks ${String(record.executedTasks.length)}/${String(record.declaredTasks.length)} `
      + `× ${String(record.repeats)} repeats, seed ${String(record.seed)}`,
    `  ADMISSIBLE: ${a.admissible ? 'yes' : 'NO'} — ${String(a.gradedTurns)} graded turns, `
      + `${String(a.toolCalls)} tool calls, ${String(a.scored)} scored / ${String(a.inert)} inert`,
  ];
  for (const failure of a.failures) lines.push(`    INADMISSIBLE: ${failure}`);
  if (a.mechanismsAbsent.length > 0) {
    lines.push(`  never exercised: ${a.mechanismsAbsent.join(', ')}`);
  }
  lines.push(`  spend: ${String(record.spend.calls)} calls, `
    + `${String(record.spend.tokensIn)} in / ${String(record.spend.tokensOut)} out tokens`);
  const scoredObs = record.observations
    .filter((o): o is Extract<EvalObservation, { outcome: 'scored' }> => o.outcome === 'scored');
  const totals = (name: string) => {
    const rows = scoredObs.flatMap((o) => o.scores.filter((s) => s.name === name));
    const eligible = rows.reduce((n, r) => n + r.eligible, 0);
    const passed = rows.reduce((n, r) => n + r.passed, 0);
    return { eligible, passed };
  };

  const outcome = totals(TASK_OUTCOME);
  lines.push(`  OUTCOME — did the agent solve the task:`);
  lines.push(`    ${TASK_OUTCOME.padEnd(20)} ${outcome.eligible === 0
    ? 'NOT MEASURED — no task declared ground truth'
    : `${String(outcome.passed)}/${String(outcome.eligible)} = `
      + `${(outcome.passed / outcome.eligible).toFixed(3)} over `
      + `${String(a.outcomesScored)} scored attempts`}`);

  // Covariates, named as such. Every row kept: this telemetry is how a moved
  // outcome gets explained. None of it is a score.
  lines.push('  covariates (mechanism telemetry — explanatory, never a score):');
  for (const name of BEHAVIOUR_SCORERS.map((s) => s.name)) {
    const { eligible, passed } = totals(name);
    lines.push(`    ${name.padEnd(20)} ${eligible === 0
      ? 'n/a — no eligible opportunity'
      : `${String(passed)}/${String(eligible)} = ${(passed / eligible).toFixed(3)}`}`);
  }
  return lines.join('\n');
}
