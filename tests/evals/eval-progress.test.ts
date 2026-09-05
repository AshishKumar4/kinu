/**
 * What the EVAL TIER owes the durable progress store, as distinct from what the
 * store owes itself.
 *
 * The store's own contract — phases, adoption, the five-state census, resuming
 * a killed corpus — is proven in `packages/test-utils/tests/eval-progress.test.ts`,
 * beside the module. Two properties are not the store's and live here instead:
 * how an interrupted case reads in a published RECORD, and the runner
 * configuration that lets a case take as long as the episode takes.
 */
import { describe, expect, test } from 'bun:test';

import { assessAdmissibility, type EvalObservation } from '@kinu.run/test-utils';
import evalsConfig from '../../vitest.evals.config';

describe('an interrupted case is incomplete, never pass or fail', () => {
  test('the run record classification carries no score and is inadmissible partial evidence', () => {
    const observation: EvalObservation = {
      taskId: 'cancelled-case',
      repetition: 0,
      outcome: 'incomplete',
      reason: 'cancelled by operator',
    };
    const assessed = assessAdmissibility(['cancelled-case'], [observation]);

    expect(assessed.scored).toBe(0);
    expect(assessed.incomplete).toBe(1);
    expect(assessed.admissible).toBe(false);
    expect(assessed.failures.join('\n')).toContain('partial evidence, not a verdict');
    expect(observation).not.toHaveProperty('scores');
  });

  /**
   * The other half of the same rule, and the one that used to be missing.
   *
   * A case the run never REACHED is reported as `incomplete` too, so a corpus
   * whose repetitions were cut short cannot publish over the shorter
   * denominator. Only a task that ran at least once gets these rows: a task
   * with none is named by id in the declared-versus-executed check below, and a
   * row for it would put its id into `executedTasks` and lose the one place
   * that names it.
   */
  test('an unreached case is inadmissible whichever way it went unreached', () => {
    const scored: EvalObservation = {
      taskId: 'ran-once',
      repetition: 0,
      outcome: 'scored',
      scores: [{
        name: 'task_outcome', asserts: 'the task was solved',
        eligible: 1, passed: 1, rate: 1, detail: 'solved',
      }],
      turns: 2,
      toolCalls: 3,
      tokensIn: 10,
      tokensOut: 20,
      ms: 5,
    };
    const unreachedRepetition: EvalObservation = {
      taskId: 'ran-once',
      repetition: 1,
      outcome: 'incomplete',
      reason: 'never attempted — the run ended before this case was reached',
    };

    // A repetition the run never reached: invisible to the task-level check,
    // caught as incomplete.
    const partial = assessAdmissibility(['ran-once'], [scored, unreachedRepetition]);
    expect(partial.admissible).toBe(false);
    expect(partial.incomplete).toBe(1);
    expect(partial.failures.join('\n')).toContain('never settled');

    // A whole task the run never reached: caught by name, and never given a
    // row, so `executedTasks` keeps saying only what actually executed.
    const missing = assessAdmissibility(['ran-once', 'never-ran'], [scored]);
    expect(missing.admissible).toBe(false);
    expect(missing.failures.join('\n')).toContain('never attempted never-ran');
  });
});

describe('the eval runners do not terminate cases on elapsed wall time', () => {
  test('the Vitest eval config disables its case timeout', () => {
    expect(evalsConfig.test?.testTimeout).toBe(0);
  });

  /**
   * Bun's default is 5 seconds. Surviving past that with a per-case timeout of
   * zero is the runner-level proof that zero DISABLES termination rather than
   * meaning "terminate immediately". Credential-free, and it exercises the same
   * runner that owns evolution-proof and exploration.eval.test.ts.
   *
   * A REAL delay, deliberately, and the one place in this file with one: the
   * subject under test IS the runner's own wall clock. A fake timer would
   * advance the clock this test is trying to outlive, so it would prove that
   * the mock works and nothing about the runner.
   */
  test('Bun timeout zero survives past the default five-second wall', async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5_100);
    await promise;
  }, 0);
});
