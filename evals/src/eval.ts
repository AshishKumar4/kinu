import { createJudge, describeEval } from 'vitest-evals';
import { evalCommit, evalMatrix } from './config';
import { createKinuHarness } from './harness';
import { ARMS, resolveEvalTarget } from './target';
import { taskVersion, type EvalRunInput, type EvalRunOutput, type EvalTask } from './task';

const FunctionalJudge = createJudge<EvalRunInput, EvalRunOutput>('functional result', ({ output }) => {
  const checks = output.turns.flatMap((turn) => turn.checks);
  const failed = checks.filter((check) => !check.pass).map((check) => check.id);

  return {
    score: output.success ? 1 : 0,
    metadata: {
      rationale: output.success ? 'every turn and check passed' : `failed: ${failed.join(', ') || 'a turn did not complete'}`,
      passedChecks: checks.length - failed.length,
      totalChecks: checks.length,
      failedChecks: failed,
    },
  };
});

/**
 * Register one task as model x arm x trial cases. Trials run concurrently, each on its own
 * workspace, so a task takes as long as its slowest trial. A run holds trials `firstTrial` onward,
 * so one task's trials can be split across jobs. A missing identity or a bad matrix fails here, at
 * collection, before any inference.
 */
export function defineTaskEval(task: EvalTask): void {
  const matrix = evalMatrix(process.env, ARMS.map((arm) => arm.id));
  const target = resolveEvalTarget(process.env);
  const harness = createKinuHarness(task, target, { taskVersion: taskVersion(task), evalCommit: evalCommit(process.env) });

  describeEval(task.id, { harness }, (it) => {
    for (const model of matrix.models) {
      for (const arm of matrix.arms) {
        for (let trial = matrix.firstTrial; trial < matrix.firstTrial + matrix.trials; trial += 1) {
          // Concurrent cases use the context's expect: the judge records its score on the current test.
          it.concurrent(`${model} | ${arm} | trial ${String(trial)}`, async ({ run, expect }) => {
            const result = await run({ model, arm, trial });
            await expect(result).toSatisfyJudge(FunctionalJudge, { threshold: 1 });
          });
        }
      }
    }
  });
}
