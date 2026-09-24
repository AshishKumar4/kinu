/** Refusals matter most: a verifier bug must surface as a red run, not a plausible number. */
import { describe, test, expect } from 'bun:test';
import {
  OUTCOME_SCALE, OUTPUT_CAP, TASK_OUTCOME, isCovariateRow,
  outcomeRow, outputCapRow, ratioOutcome, subgoalOutcome,
} from '../src/eval-outcome';
import { OUTPUT_LIMIT_REACHED } from '@kinu.run/core';
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
    // Clamping would report 1.000 for a normalization bug.
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
   * Guards the headline: renaming a mechanism scorer to `task_outcome`, or adding the outcome
   * to the mechanism panel, goes red.
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
    turns: 3, toolCalls: 9, toolNames: ['shell', 'file'], tokensIn: 100, tokensOut: 10, ms: 1,
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
    // An outcome was measured, so the run is evidence even with no mechanism denominator.
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

describe('outputCapRow — a cut answer is the request bounding the attempt', () => {
  test('a last step the provider cut FAILS, and the detail says who cut it', () => {
    const row = outputCapRow(OUTPUT_LIMIT_REACHED);
    expect(row.name).toBe(OUTPUT_CAP);
    expect(row.eligible).toBe(1);
    expect(row.passed).toBe(0);
    expect(row.rate).toBe(0);
    // The reader this row exists for: a truncated reply must not send anyone
    // hunting a prompt regression.
    expect(row.detail).toContain('CUT AT THE OUTPUT LIMIT');
    expect(row.detail).toContain('never as the agent');
  });

  test("a model that ended its own answer passes, whatever word it ended on", () => {
    for (const reason of ['stop', 'tool-calls', 'unknown']) {
      const row = outputCapRow(reason);
      expect(row.eligible).toBe(1);
      expect(row.passed).toBe(1);
      expect(row.rate).toBe(1);
      expect(row.detail).toContain(reason);
    }
  });

  test('no closed step is UNMEASURED, not uncapped — eligible zero, rate null', () => {
    // A `1` would report a clean cap verdict for an episode with no finish reason.
    const row = outputCapRow(null);
    expect(row.eligible).toBe(0);
    expect(row.passed).toBe(0);
    expect(row.rate).toBeNull();
    expect(row.detail).toContain('UNMEASURED');
  });

  test('the cap verdict is a covariate — it explains an outcome, it is not one', () => {
    expect(isCovariateRow(OUTPUT_CAP)).toBe(true);
    expect(OUTPUT_CAP).not.toBe(TASK_OUTCOME);
  });
});
