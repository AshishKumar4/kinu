/** Refusals matter most: a verifier bug must surface as a red run, not a plausible number. */
import { describe, test, expect } from 'bun:test';
import {
  TASK_OUTCOME, isCovariateRow, outcomeRow, subgoalOutcome,
} from '../src/eval-outcome';
import { BEHAVIOUR_SCORERS } from '../src/agent-evals';
import { assessAdmissibility, projectRunEventProvenance, type EvalObservation } from '../src/eval-run';

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

  test('measured quantities survive onto the row', () => {
    const row = outcomeRow(subgoalOutcome(1, 2, 'one of two', { comparisons: 812, reference: 604 }));
    expect(row.measured).toEqual({ comparisons: 812, reference: 604 });
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
    turns: 3, toolCalls: 9, toolNames: ['shell', 'file'], tokensIn: 100, tokensOut: 10, reasoningOut: 0, ms: 1,
    provenance: projectRunEventProvenance([]),
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
