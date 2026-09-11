/**
 * The task-outcome contract: DID THE AGENT SOLVE THE CHALLENGE, on a continuous
 * scale, against ground truth nobody had to be persuaded of.
 *
 * WHY THIS EXISTS. Solved-or-not is a measurement the tier has to make for
 * itself: `EvalObservation`'s mechanism scorers, turn count and tool-call count
 * say only that a run HAPPENED. A headline built out of those is an
 * ADMISSIBILITY predicate wearing a pass-rate's clothes — every admissible
 * observation satisfies `turns > 0 && toolCalls > 0` by construction, which is
 * how such a headline read `pass@1` 1.000 → 1.000 across two full runs with a
 * measured dispersion of exactly 0.0000: a metric that cannot vary. Hard tasks
 * bolted onto that instrument would report 1.000 → 1.000 too, so the first
 * thing to fix is never the corpus.
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
import { OUTPUT_LIMIT_REACHED } from '@kinu.run/core';
import type { EvalBudget, ExecOutcome, VFS } from '@kinu.run/core';
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

/**
 * One machine-checked subgoal's verdict: what was checked, whether it held, and
 * the evidence. Named because the detail line a record carries is built from
 * these, and a subgoal whose meaning lives only in a boolean is one nobody can
 * read back. Shared by every family that grades a case as a count of these —
 * the trajectory arm and the first-run tier — so the retained verdicts under a
 * run's `transcripts` are one shape whichever family wrote them.
 */
export interface EvalSubgoal {
  readonly what: string;
  readonly reached: boolean;
  readonly detail: string;
}

/** The `subgoalOutcome` verdict over a list of subgoals, with the detail line
 *  every consumer reads: each subgoal named, `ok` or `MISSED`, and its evidence. */
export function subgoalsOutcome(
  subgoals: readonly EvalSubgoal[], measured?: Readonly<Record<string, number>>,
): TaskOutcome {
  const reached = subgoals.filter((subgoal) => subgoal.reached).length;

  const detail = subgoals
    .map((subgoal) => `${subgoal.what}: ${subgoal.reached ? 'ok' : 'MISSED'} — ${subgoal.detail}`)
    .join('; ');

  return subgoalOutcome(reached, subgoals.length, detail, measured);
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

/**
 * The budget covariate's row name. A covariate by construction, because
 * {@link isCovariateRow} is total and only `task_outcome` is the metric — which
 * is the right classification: an episode that solved the task over budget
 * solved the task, and one that stayed under budget without solving it solved
 * nothing. Cost explains an outcome; it is never the outcome.
 */
export const BUDGET_ADHERENCE = 'budget_adherence';

/**
 * What one episode actually cost, in the four dimensions a budget can name.
 *
 * `toolErrorRate` is NULLABLE and the others are not, and the asymmetry is the
 * point: steps, tokens and wall time are counted off the ledger and off the
 * clock, so they always exist, whereas an error rate needs producer-attributed
 * tool outcomes and an episode whose calls carry none has no rate — as opposed
 * to a rate of zero. Handing this a `0` for "unmeasured" would report a perfect
 * error rate for an episode nobody measured, which is the one failure the
 * eligible/passed convention exists to prevent.
 */
export interface BudgetMeasurement {
  readonly steps: number;
  readonly tokens: number;
  /** Failed tool calls over attributed tool calls, or null when attribution is
   *  absent or the episode made no tool call at all. */
  readonly toolErrorRate: number | null;
  readonly wallMs: number;
}

/** One dimension's verdict, rendered into the row's detail line. */
function budgetLine(name: string, limit: number, actual: number, unit: string): string {
  const verdict = actual <= limit ? 'ok' : 'OVER';

  return `${name} ${verdict} ${String(actual)}${unit}/${String(limit)}${unit}`;
}

/**
 * Score one episode's cost against the ceilings its case declared.
 *
 * ELIGIBLE IS THE DECLARED-AND-MEASURABLE COUNT, not four. A case that names
 * two ceilings is scored out of two, and a case that names an error-rate
 * ceiling for an episode with no attributed tool outcomes is scored out of the
 * other ones — the same "absent, not zero" rule every mechanism scorer here
 * follows. A budget with nothing declared therefore yields `eligible: 0` and a
 * `null` rate, which reads in the record as "cost measured, held to nothing"
 * rather than as a perfect score.
 *
 * IT DOES NOT THROW on an over-budget episode, unlike {@link outcomeRow} on a
 * malformed verdict. Over budget is a MEASUREMENT — the finding this row exists
 * to make — whereas a verdict of 7-out-of-5 is a broken verifier. Only the
 * second is a defect in the instrument.
 */
export function budgetRow(budget: EvalBudget, measured: BudgetMeasurement): EvalScoreRow {
  const lines: string[] = [];
  let eligible = 0;
  let passed = 0;

  const hold = (within: boolean, line: string): void => {
    eligible += 1;

    if (within) passed += 1;
    lines.push(line);
  };

  if (budget.steps !== undefined) {
    hold(measured.steps <= budget.steps, budgetLine('steps', budget.steps, measured.steps, ''));
  }

  if (budget.tokens !== undefined) {
    hold(measured.tokens <= budget.tokens, budgetLine('tokens', budget.tokens, measured.tokens, ''));
  }

  if (budget.toolErrorRate !== undefined) {
    if (measured.toolErrorRate === null) {
      lines.push('toolErrorRate UNMEASURED — no attributed tool outcome to take a rate over');
    } else {
      const rate = measured.toolErrorRate;
      hold(rate <= budget.toolErrorRate,
        `toolErrorRate ${rate <= budget.toolErrorRate ? 'ok' : 'OVER'} `
        + `${rate.toFixed(3)}/${budget.toolErrorRate.toFixed(3)}`);
    }
  }

  if (budget.wallMs !== undefined) {
    hold(measured.wallMs <= budget.wallMs, budgetLine('wall', budget.wallMs, measured.wallMs, 'ms'));
  }

  const quantities = {
    steps: measured.steps,
    tokens: measured.tokens,
    wallMs: measured.wallMs,
  };

  const row: EvalScoreRow = {
    name: BUDGET_ADHERENCE,
    asserts: 'the episode stayed inside the ceilings its case declared for steps, tokens, '
      + 'tool error rate and wall time',
    eligible,
    passed,
    rate: eligible === 0 ? null : passed / eligible,
    detail: lines.length === 0 ? 'no ceiling declared — cost measured, held to nothing' : lines.join('; '),
    measured: quantities,
  };

  if (measured.toolErrorRate === null) return row;

  return { ...row, measured: { ...quantities, toolErrorRate: measured.toolErrorRate } };
}

/**
 * The error rate the `tool_outcomes` scorer already measured, for a budget's
 * tool-error-rate ceiling.
 *
 * Read OFF THE SCORED ROW rather than recomputed from the ledger, because the
 * row is the canonical rate: it knows which calls carry producer attribution
 * and which are historical unmeasured rows, and a second computation here is
 * how two denominators start disagreeing. Null when the row is missing,
 * unmeasured or eligible-zero — the same "absent, not zero" the budget row
 * renders as UNMEASURED rather than as a perfect zero.
 */
export function measuredToolErrorRate(rows: readonly EvalScoreRow[]): number | null {
  // The literal is owned by the scorer in agent-evals.ts (`toolOutcomes.name`);
  // the suite's judge panel already selects scorers by these literals, so this
  // follows that convention rather than importing the scorer module here.
  const row = rows.find((candidate) => candidate.name === 'tool_outcomes');

  if (row === undefined || row.eligible === 0 || row.rate === null) return null;

  return 1 - row.rate;
}

/**
 * The output-cap covariate's row name.
 *
 * A covariate, like {@link BUDGET_ADHERENCE}, because {@link isCovariateRow} is
 * total and only `task_outcome` is the metric. That is the right classification
 * on its own terms too: whether the provider cut the answer EXPLAINS an
 * outcome, it is never the outcome. An episode cut at the limit that still
 * satisfied the ground truth satisfied it.
 */
export const OUTPUT_CAP = 'output_cap';

/**
 * Whether the PROVIDER ended this episode's last step at its output limit.
 *
 * WHY THIS ROW EXISTS. Anthropic's cost guidance treats the output cap as a
 * first-order lever and reports it in exactly this shape: a 16,384-token cap
 * ended 15% of one model's attempts and 43% of another's, and since a capped
 * attempt spends its tokens and buys no solve, cost per SOLVED task did not
 * improve. The number that decides whether a cap is costing anything is
 * therefore the SHARE OF ATTEMPTS IT ENDED — and this tier could not report it,
 * because no eval arm read a finish reason at all. A capped attempt was graded
 * against ground truth over a truncated answer and read as an ordinary
 * behavioural miss.
 *
 * SO IT IS NAMED, AND IT IS A FAILURE. Named, because a truncated answer is a
 * fact about the REQUEST rather than about the agent, and a reader sent hunting
 * a prompt regression by one is sent to the wrong place — the distinction
 * `INFRA_FAILURE_MARKER` draws between the environment and the episode, one
 * step further in. A failure, because the guidance's rule for this state is to
 * treat it as one: the model had more to say and was not allowed to say it, so
 * whatever the reply holds is not the answer the episode set out to measure.
 *
 * A ROW RATHER THAN A THROW, and the argument is {@link budgetRow}'s. The
 * statistic is a RATE over attempts, so one capped attempt has to leave the
 * denominator standing; a throw would take the arm down and destroy the count
 * that says whether the cap matters at all. Over budget is a measurement and so
 * is this. Only a malformed verdict is a defect in the instrument, which is
 * what {@link outcomeRow} throws on.
 *
 * `reason` is the SDK-mapped finish reason off the episode's LAST `step_finish`
 * row (`StepBoundEvidence.lastStepReason`), never a provider payload string:
 * the adapter normalizes `max_tokens`, `MAX_TOKENS` and `length` onto core's
 * one {@link OUTPUT_LIMIT_REACHED} word, so this compares against that constant
 * rather than matching on an endpoint's own prose. It is the LAST step's on
 * purpose — both turn loops answer a cut answer with exactly one continuation,
 * so an earlier `length` is ordinary and only a final one is an attempt that
 * ended truncated.
 *
 * A null `reason` is `eligible: 0` and a null rate. An episode that closed no
 * step has no last reason to read, which is absent rather than uncapped — the
 * rule the tool-error-rate ceiling follows, for the same reason: a `1` here
 * would report a clean cap verdict for an episode nobody measured.
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
