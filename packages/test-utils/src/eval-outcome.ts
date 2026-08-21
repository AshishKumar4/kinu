/**
 * The task-outcome contract: DID THE AGENT SOLVE THE CHALLENGE, on a continuous
 * scale, against ground truth nobody had to be persuaded of.
 *
 * WHY THIS EXISTS. The tier used to have no way to say a task was solved.
 * `EvalObservation` carried the eight mechanism scorers, the turn count and the
 * tool-call count and nothing else, and the headline "success" predicate was
 * `turns > 0 && toolCalls > 0` — the ADMISSIBILITY predicate wearing a
 * pass-rate's clothes. Every admissible observation satisfies it by
 * construction, so `pass@1` read 1.000 → 1.000 across two full runs and the
 * measured dispersion was exactly 0.0000: the metric could not vary. Hard tasks
 * bolted onto that instrument would have reported 1.000 → 1.000 too. So the
 * first thing to fix was never the corpus.
 *
 * WHY IT IS ONE ROW AND NOT A NEW PIPELINE. `EvalScoreRow` already flows through
 * persistence, the paired comparator, admissibility and the tier's judges. The
 * comparator's per-metric path is ALREADY a continuous paired comparison over
 * `passed / eligible` per task (eval-compare.ts), with an exact sign test, a
 * cluster bootstrap interval, a dispersion and an MDE. An outcome expressed as
 * that row inherits all of it and adds no second statistics path. The primary
 * metric is therefore a row NAME, not a parallel mechanism — which is also what
 * makes {@link isCovariateRow} a total rule rather than a list to maintain.
 *
 * WHY CONTINUOUS. A pass/fail bit gives a search nothing to climb: on binary
 * tasks MCTS degenerates toward best-of-n because there is no partial reward to
 * steer on. A subgoal count or a measured ratio does give it a gradient. Both
 * shapes reduce to the same two integers here.
 *
 * WHAT IS DELIBERATELY ABSENT. There is no LLM judge and no place to put one: a
 * verifier is handed a filesystem and a shell, never a model. A judged outcome
 * is an outcome someone can argue with, and the whole point of this row is that
 * it is checkable.
 */
import * as v from 'valibot';
import type { ExecOutcome, VFS } from '@kinu.run/core';
import type { EvalScoreRow } from './eval-run';

/**
 * The one primary metric's row name.
 *
 * Exported as a constant so no caller types the string. A metric selected by a
 * literal in three files is a metric that gets renamed in two of them.
 */
export const TASK_OUTCOME = 'task_outcome';

/**
 * Fixed-point denominator for outcomes that are a measured RATIO rather than a
 * count of subgoals.
 *
 * The comparator recomputes each task's rate from the integer counts and ignores
 * any rate stored beside them, so a continuous score has to survive as a pair of
 * integers. 10,000 puts the quantization at 0.01pp — two orders of magnitude
 * finer than the smallest effect any design here can resolve, so the encoding
 * cannot be mistaken for the signal.
 */
export const OUTCOME_SCALE = 10_000;

/**
 * One task's ground-truth verdict.
 *
 * `reached / total` IS the score. Both are integers because the comparator's
 * denominator is an integer count, and because a subgoal tally is the honest
 * shape for partial credit: three of five checks passing is a fact, whereas
 * "0.6 solved" is an interpretation.
 */
export interface TaskOutcome {
  /** Subgoals the final state satisfies, or `round(score × OUTCOME_SCALE)`. */
  readonly reached: number;
  /** Subgoals there were, or `OUTCOME_SCALE` for a ratio. Never zero: a task
   *  with nothing checkable cannot be in this tier at all. */
  readonly total: number;
  /**
   * What was measured, naming the ground truth it was measured against.
   *
   * Required, not optional. A stored number that does not say what it measured
   * is a number whose meaning lives in its author's memory, and this is the row
   * every later comparison is built on.
   */
  readonly detail: string;
  /**
   * Raw measured quantities behind the score — elapsed ms, operation counts, a
   * reference baseline, an error norm.
   *
   * Kept structured rather than folded into `detail` because a speedup ratio is
   * only reproducible if the baseline it was divided by survives with it. A
   * ratio scored against a constant is a ratio nobody can re-derive.
   */
  readonly measured?: Readonly<Record<string, number>>;
}

/** What a verifier is given: the workspace the agent left behind, and the shell
 *  over it. No model, no network, no run-event ledger — an outcome must be a
 *  property of the FINAL STATE, reproducible without the trajectory that
 *  produced it. */
export interface VerifierContext {
  readonly vfs: VFS;
  readonly exec: (command: string) => Promise<ExecOutcome>;
}

/** A task's ground truth, as code. Async because checking usually means running
 *  something. */
export type TaskVerifier = (ctx: VerifierContext) => Promise<TaskOutcome>;

const OutcomeSchema = v.pipe(
  v.object({
    reached: v.pipe(v.number(), v.finite(), v.minValue(0)),
    total: v.pipe(v.number(), v.finite(), v.integer(), v.minValue(1)),
    detail: v.pipe(v.string(), v.minLength(1)),
    measured: v.optional(v.record(v.string(), v.pipe(v.number(), v.finite()))),
  }),
  v.check((o) => o.reached <= o.total, 'reached exceeds total — a score above 1.0 is not a score'),
  v.check((o) => Number.isInteger(o.reached), 'reached must be an integer count'),
);

/**
 * Validate a verdict and project it onto the row every consumer already reads.
 *
 * THROWS rather than clamping. A verifier that returns 7 of 5 subgoals, or a
 * NaN ratio, has a bug in the ground truth itself, and ground truth that is
 * quietly repaired is ground truth nobody can trust. This sits upstream of every
 * write path — the run record, the comparator, the tier — so a broken verifier
 * produces a red run and publishes no number, rather than a plausible one.
 */
export function outcomeRow(outcome: TaskOutcome): EvalScoreRow {
  const parsed = v.safeParse(OutcomeSchema, outcome);
  if (!parsed.success) {
    throw new Error(
      `invalid ${TASK_OUTCOME} verdict: ${parsed.issues.map((i) => i.message).join('; ')} `
      + `(received reached=${String(outcome.reached)}, total=${String(outcome.total)})`,
    );
  }
  const { reached, total, detail, measured } = parsed.output;
  const row: EvalScoreRow = {
    name: TASK_OUTCOME,
    asserts: 'the agent solved the task, measured against the task\'s own ground truth',
    eligible: total,
    passed: reached,
    rate: reached / total,
    detail,
  };
  return measured === undefined ? row : { ...row, measured };
}

/** A verdict from a count of independently checkable subgoals. The natural shape
 *  for partial credit, and the one a search can climb. */
export function subgoalOutcome(
  reached: number, total: number, detail: string,
  measured?: Readonly<Record<string, number>>,
): TaskOutcome {
  return measured === undefined
    ? { reached, total, detail }
    : { reached, total, detail, measured };
}

/**
 * A verdict from a measured ratio already normalized to [0,1].
 *
 * Out-of-range input THROWS rather than clamping, for the same reason
 * {@link outcomeRow} does: a speedup that normalized to 1.4 means the
 * normalization is wrong, and silently recording 1.0 would hide it behind a
 * perfect score. Clamping is only correct for a quantity that is genuinely
 * saturating, and a task score is not.
 */
export function ratioOutcome(
  score: number, detail: string, measured?: Readonly<Record<string, number>>,
): TaskOutcome {
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error(
      `ratioOutcome expects a score already normalized to [0,1], received ${String(score)}. `
      + 'Normalize against the reference measurement before scoring, and keep both raw '
      + 'quantities in `measured` so the ratio can be re-derived.',
    );
  }
  return subgoalOutcome(Math.round(score * OUTCOME_SCALE), OUTCOME_SCALE, detail, measured);
}

/**
 * Is this row a covariate rather than the metric?
 *
 * Total by construction: `task_outcome` is the only primary metric, so
 * everything else is a covariate, and a mechanism scorer added tomorrow is
 * classified correctly without touching this function. The alternative — a list
 * of known mechanism names — would silently promote the next scorer somebody
 * adds, which is the exact failure this rule exists to prevent.
 *
 * Mechanism telemetry is KEPT, in full, and this is not a demotion of the data.
 * Delegation converting 4/4 where the work was divisible and 0/21 where it was
 * not is only legible because the per-turn rows exist; the defect was pooling
 * them into a rate and calling it a score. So: every row recorded, one row
 * scored.
 */
export function isCovariateRow(name: string): boolean {
  return name !== TASK_OUTCOME;
}
