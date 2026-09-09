/**
 * The outcome contract's own tests.
 *
 * Every case here is one of three shapes, the same three the scorer suite uses:
 * a verdict that scores, a verdict that is REFUSED, and the degenerate verdict a
 * lenient row would silently accept — a zero denominator, a ratio above 1, a
 * NaN. The refusals matter most — this row is the primary metric, so a verifier
 * bug has to surface as a red run rather than as a plausible number nobody can
 * re-derive.
 */
import { describe, test, expect } from 'bun:test';
import {
  BUDGET_ADHERENCE, OUTCOME_SCALE, TASK_OUTCOME, budgetRow, isCovariateRow, measuredToolErrorRate,
  outcomeRow, ratioOutcome, subgoalOutcome,
} from '../src/eval-outcome';
import { BEHAVIOUR_SCORERS } from '../src/agent-evals';
import { assessAdmissibility, type EvalObservation } from '../src/eval-run';

describe('subgoalOutcome — partial credit from a count', () => {
  test('three of five checks is a rate of 0.6, with the counts preserved', () => {
    const row = outcomeRow(subgoalOutcome(3, 5, 'median/mean/empty passed; sort, stability failed'));
    expect(row.name).toBe(TASK_OUTCOME);
    expect(row.eligible).toBe(5);
    expect(row.passed).toBe(3);
    expect(row.rate).toBeCloseTo(0.6, 10);
    expect(row.detail).toContain('median');
  });

  test('a fully solved task is 1.0 and a fully failed one is 0.0 — the metric can reach both ends', () => {
    expect(outcomeRow(subgoalOutcome(4, 4, 'all checks passed')).rate).toBe(1);
    expect(outcomeRow(subgoalOutcome(0, 4, 'no check passed')).rate).toBe(0);
  });

  test('measured quantities survive onto the row, so a ratio can be re-derived', () => {
    const row = outcomeRow(subgoalOutcome(1, 2, 'one of two', { comparisons: 812, reference: 604 }));
    expect(row.measured).toEqual({ comparisons: 812, reference: 604 });
  });
});

describe('ratioOutcome — a measured ratio as fixed point', () => {
  test('a ratio survives the integer round trip at OUTCOME_SCALE resolution', () => {
    const row = outcomeRow(ratioOutcome(0.734, '604 comparisons against a 823 reference'));
    expect(row.eligible).toBe(OUTCOME_SCALE);
    expect(row.passed).toBe(Math.round(0.734 * OUTCOME_SCALE));
    expect(row.rate).toBeCloseTo(0.734, 6);
  });

  test('REFUSED: a ratio above 1 throws instead of clamping to a perfect score', () => {
    // Clamping here would report 1.000 for a normalization bug — the defect
    // hiding behind the very number it corrupted.
    expect(() => ratioOutcome(1.4, 'mis-normalized speedup')).toThrow(/normalized to \[0,1\]/);
  });

  test('REFUSED: a non-finite ratio throws rather than becoming NaN in the record', () => {
    expect(() => ratioOutcome(Number.NaN, 'divide by zero baseline')).toThrow(/normalized/);
    expect(() => ratioOutcome(Number.POSITIVE_INFINITY, 'zero-cost claim')).toThrow(/normalized/);
  });
});

describe('outcomeRow — refusals, because ground truth is not quietly repaired', () => {
  test('REFUSED: more subgoals reached than existed', () => {
    expect(() => outcomeRow(subgoalOutcome(7, 5, 'impossible'))).toThrow(/above 1\.0 is not a score/);
  });

  test('REFUSED: a zero denominator — a task with nothing checkable is not in this tier', () => {
    expect(() => outcomeRow(subgoalOutcome(0, 0, 'nothing to check'))).toThrow(/invalid task_outcome/);
  });

  test('REFUSED: a fractional subgoal count, which means the denominator is not a count', () => {
    expect(() => outcomeRow(subgoalOutcome(1.5, 3, 'half a check'))).toThrow(/integer count/);
  });

  test('REFUSED: an empty detail — a stored number must say what it measured', () => {
    expect(() => outcomeRow(subgoalOutcome(1, 2, ''))).toThrow(/invalid task_outcome/);
  });
});

describe('the bar against promotion is mechanical', () => {
  /**
   * Main's requirement: a future contributor must not be able to put a covariate
   * in the headline. This is the assertion that stops it — if anyone renames a
   * mechanism scorer to `task_outcome`, or adds the outcome to the mechanism
   * panel, the primary metric silently becomes a mechanism rate and this goes
   * red.
   */
  test('no mechanism scorer is the primary metric, and none can become it by rename', () => {
    for (const scorer of BEHAVIOUR_SCORERS) {
      expect(isCovariateRow(scorer.name)).toBe(true);
      expect(scorer.name).not.toBe(TASK_OUTCOME);
    }
  });

  test('the classification is total — anything that is not the outcome is a covariate', () => {
    expect(isCovariateRow(TASK_OUTCOME)).toBe(false);
    expect(isCovariateRow('a_scorer_invented_tomorrow')).toBe(true);
  });
});

describe('admissibility rests on the outcome, not on mechanism coverage', () => {
  const behaved = {
    turns: 3, toolCalls: 9, toolNames: ['run', 'file'], tokensIn: 100, tokensOut: 10, ms: 1,
  };
  const row = (name: string, eligible: number, passed: number) =>
    ({ name, asserts: `${name} fixture`, eligible, passed, rate: eligible === 0 ? null : passed / eligible, detail: 'fixture' });

  test('a run that measured activity but no outcome is NOT evidence', () => {
    const obs: EvalObservation[] = [{
      taskId: 't', repetition: 0, outcome: 'scored',
      scores: [row('tool_outcomes', 9, 9), row('edit_landing', 2, 2)], ...behaved,
    }];
    const verdict = assessAdmissibility(['t'], obs);
    expect(verdict.admissible).toBe(false);
    expect(verdict.outcomesScored).toBe(0);
    expect(verdict.failures.join(' ')).toContain('measured activity');
  });

  test('a run where the agent SOLVED NOTHING is admissible — that is a finding', () => {
    const obs: EvalObservation[] = [{
      taskId: 't', repetition: 0, outcome: 'scored',
      scores: [row(TASK_OUTCOME, 4, 0)], ...behaved,
    }];
    const verdict = assessAdmissibility(['t'], obs);
    expect(verdict.admissible).toBe(true);
    expect(verdict.outcomesScored).toBe(1);
  });

  test('a measured outcome with every mechanism absent is still admissible', () => {
    // An outcome was measured, so the run is evidence about task performance
    // even though not one mechanism had a denominator.
    const obs: EvalObservation[] = [{
      taskId: 't', repetition: 0, outcome: 'scored',
      scores: [row(TASK_OUTCOME, 2, 1), ...BEHAVIOUR_SCORERS.map((s) => row(s.name, 0, 0))],
      ...behaved,
    }];
    const verdict = assessAdmissibility(['t'], obs);
    expect(verdict.admissible).toBe(true);
    expect(verdict.mechanismsExercised).toEqual([]);
    expect(verdict.mechanismsAbsent.length).toBe(BEHAVIOUR_SCORERS.length);
    expect(verdict.failures).toEqual([]);
  });
});

describe('budgetRow — cost beside the outcome, never instead of it', () => {
  const budget = { steps: 30, tokens: 150_000, toolErrorRate: 0.6, wallMs: 600_000 };

  test('an episode inside every ceiling scores 1.0 with its quantities preserved', () => {
    const row = budgetRow(budget, { steps: 8, tokens: 40_000, toolErrorRate: 0.25, wallMs: 120_000 });
    expect(row.name).toBe(BUDGET_ADHERENCE);
    expect(row.eligible).toBe(4);
    expect(row.passed).toBe(4);
    expect(row.rate).toBe(1);
    expect(row.measured).toEqual({ steps: 8, tokens: 40_000, toolErrorRate: 0.25, wallMs: 120_000 });
    expect(isCovariateRow(row.name)).toBe(true);
  });

  test('an over-budget episode is MEASURED, not refused — over is a finding', () => {
    const row = budgetRow(budget, { steps: 41, tokens: 40_000, toolErrorRate: 0.25, wallMs: 120_000 });
    expect(row.eligible).toBe(4);
    expect(row.passed).toBe(3);
    expect(row.rate).toBeCloseTo(0.75, 10);
    expect(row.detail).toContain('OVER');
  });

  test('an unmeasured error rate is absent, not zero — no perfect score unearned', () => {
    const row = budgetRow(budget, { steps: 8, tokens: 40_000, toolErrorRate: null, wallMs: 120_000 });
    expect(row.eligible).toBe(3);
    expect(row.passed).toBe(3);
    expect(row.rate).toBe(1);
    expect(row.detail).toContain('UNMEASURED');
    expect(row.measured).toEqual({ steps: 8, tokens: 40_000, wallMs: 120_000 });
  });

  test('a budget that declares nothing holds nothing — eligible zero, rate null', () => {
    const row = budgetRow({}, { steps: 8, tokens: 40_000, toolErrorRate: null, wallMs: 120_000 });
    expect(row.eligible).toBe(0);
    expect(row.passed).toBe(0);
    expect(row.rate).toBeNull();
  });

  test('measuredToolErrorRate reads the scorer row, never recomputes it', () => {
    const row = (name: string, eligible: number, passed: number, rate: number | null) =>
      ({ name, asserts: `${name} fixture`, eligible, passed, rate, detail: 'fixture' });
    expect(measuredToolErrorRate([row('tool_outcomes', 9, 6, 2 / 3)])).toBeCloseTo(1 / 3, 10);
    expect(measuredToolErrorRate([row('edit_landing', 2, 2, 1)])).toBeNull();
    expect(measuredToolErrorRate([row('tool_outcomes', 0, 0, null)])).toBeNull();
    expect(measuredToolErrorRate([row('tool_outcomes', 9, 9, null)])).toBeNull();
  });
});
