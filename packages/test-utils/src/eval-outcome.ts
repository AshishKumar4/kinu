/**
 * The task-outcome contract: did the agent do the task, as a count of machine-checked subgoals
 * against ground truth. Expressed as an `EvalScoreRow` so a run record carries it beside the
 * behavioural covariates; no LLM judge.
 */
import * as v from 'valibot';
import type { EvalScoreRow } from './eval-run';

/** The one primary metric's row name. */
export const TASK_OUTCOME = 'task_outcome';

/** One task's ground-truth verdict; `reached / total` is the score. */
export interface TaskOutcome {
  /** Subgoals the final state satisfies. */
  readonly reached: number;
  /** Subgoals there were. Never zero. */
  readonly total: number;
  /** What was measured, naming its ground truth. */
  readonly detail: string;
  /** Raw measured quantities behind the score (ms, counts, baseline). */
  readonly measured?: Readonly<Record<string, number>>;
}

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
 * Validate a verdict and project it onto the outcome row. Throws rather than clamping: 7 of 5 subgoals
 * or an empty detail is a broken verifier, and must publish no number.
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

/** One machine-checked subgoal's verdict and evidence, shared by every count-graded family. */
export interface EvalSubgoal {
  readonly what: string;
  readonly reached: boolean;
  readonly detail: string;
}

/** The `subgoalOutcome` verdict over subgoals, with a detail line naming each `ok`/`MISSED` and its evidence. */
export function subgoalsOutcome(
  subgoals: readonly EvalSubgoal[], measured?: Readonly<Record<string, number>>,
): TaskOutcome {
  const reached = subgoals.filter((subgoal) => subgoal.reached).length;

  const detail = subgoals
    .map((subgoal) => `${subgoal.what}: ${subgoal.reached ? 'ok' : 'MISSED'} — ${subgoal.detail}`)
    .join('; ');

  return subgoalOutcome(reached, subgoals.length, detail, measured);
}

/** A verdict from a count of independently checkable subgoals. */
export function subgoalOutcome(
  reached: number, total: number, detail: string,
  measured?: Readonly<Record<string, number>>,
): TaskOutcome {
  return measured === undefined
    ? { reached, total, detail }
    : { reached, total, detail, measured };
}

/** Is this row a covariate? Total: everything but `task_outcome` is, so new scorers need no registration. */
export function isCovariateRow(name: string): boolean {
  return name !== TASK_OUTCOME;
}
