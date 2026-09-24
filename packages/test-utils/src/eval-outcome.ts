/**
 * The task-outcome contract: did the agent solve the task, on a continuous scale, against checkable
 * ground truth. Expressed as an `EvalScoreRow` so it inherits the comparator's paired statistics.
 * Continuous so a search has partial reward to climb; no LLM judge, since verifiers get only a shell.
 */
import * as v from 'valibot';
import { OUTPUT_LIMIT_REACHED } from '@kinu.run/core';
import type { ExecOutcome, VFS } from '@kinu.run/core';
import type { EvalScoreRow } from './eval-run';

/** The one primary metric's row name. */
export const TASK_OUTCOME = 'task_outcome';

/**
 * Fixed-point denominator for ratio outcomes: the comparator recomputes rates from integer counts, and
 * 10,000 quantizes at 0.01pp, far below any resolvable effect.
 */
export const OUTCOME_SCALE = 10_000;

/** One task's ground-truth verdict; `reached / total` is the score. */
export interface TaskOutcome {
  /** Subgoals the final state satisfies, or `round(score × OUTCOME_SCALE)`. */
  readonly reached: number;
  /** Subgoals there were, or `OUTCOME_SCALE` for a ratio. Never zero. */
  readonly total: number;
  /** What was measured, naming its ground truth. */
  readonly detail: string;
  /** Raw measured quantities behind the score (ms, counts, baseline), kept so a ratio can be re-derived. */
  readonly measured?: Readonly<Record<string, number>>;
}

/** What a verifier is given: the final workspace and a shell over it. No model, network or event ledger. */
export interface VerifierContext {
  readonly vfs: VFS;
  readonly exec: (command: string) => Promise<ExecOutcome>;
}

/** A task's ground truth, as code. */
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
 * Validate a verdict and project it onto the outcome row. Throws rather than clamping: 7 of 5 subgoals
 * or a NaN ratio is a broken verifier, and must publish no number.
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

/** A verdict from a ratio normalized to [0,1]. Out-of-range input throws: it means the normalization is wrong. */
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

/** Is this row a covariate? Total: everything but `task_outcome` is, so new scorers need no registration. */
export function isCovariateRow(name: string): boolean {
  return name !== TASK_OUTCOME;
}

/** The `tool_outcomes` scorer's error rate, read off the scored row so there is one denominator. Null when unmeasured. */
export function measuredToolErrorRate(rows: readonly EvalScoreRow[]): number | null {
  // Scorer literal owned by `toolOutcomes.name` in agent-evals.ts; not imported, like the judge panel.
  const row = rows.find((candidate) => candidate.name === 'tool_outcomes');

  if (row === undefined || row.eligible === 0 || row.rate === null) return null;

  return 1 - row.rate;
}

/** The output-cap covariate's row name; truncation explains an outcome, it is never the outcome. */
export const OUTPUT_CAP = 'output_cap';

/**
 * Whether the provider ended this episode's last step at its output limit. Anthropic's cost guidance: a
 * 16,384-token cap ended 15% of one model's attempts and 43% of another's, so the share of capped attempts
 * is the number to report. A capped attempt counts as a failure but is a row, not a throw, to keep the
 * denominator. Only the last step counts (turn loops continue once after a cut); a null `reason` is
 * `eligible: 0`. Compares the normalized {@link OUTPUT_LIMIT_REACHED}, never provider strings.
 */
export function outputCapRow(reason: string | null): EvalScoreRow {
  const asserts = 'the provider did not end the episode at its output limit';

  if (reason === null) {
    return {
      name: OUTPUT_CAP,
      asserts,
      eligible: 0,
      passed: 0,
      rate: null,
      detail: 'UNMEASURED — the episode closed no step, so it has no last finish reason to read',
    };
  }

  const capped = reason === OUTPUT_LIMIT_REACHED;

  return {
    name: OUTPUT_CAP,
    asserts,
    eligible: 1,
    passed: capped ? 0 : 1,
    rate: capped ? 0 : 1,
    detail: capped
      ? `CUT AT THE OUTPUT LIMIT — the last step finished '${OUTPUT_LIMIT_REACHED}', so the `
        + 'answer this episode is graded on is the part the provider allowed rather than the '
        + 'part the model had. Read it as the request bounding the attempt, never as the agent '
        + 'choosing to stop'
      : `ok — the last step finished '${reason}', which is the model ending its own answer`,
  };
}
