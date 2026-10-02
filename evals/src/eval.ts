import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJudge, describeEval } from 'vitest-evals';
import { resolveArtifactRoot } from '../../scripts/bench-retention';
import { evalCommit, evalMatrix } from './config';
import { createKinuHarness } from './harness';
import { trialAccounts, trialSlot } from './slot';
import { ARMS, resolveEvalTarget } from './target';
import { failureRationale, taskVersion, type EvalRunInput, type EvalRunOutput, type EvalTask } from './task';

const FunctionalJudge = createJudge<EvalRunInput, EvalRunOutput>('functional result', ({ output }) => {
  const checks = output.turns.flatMap((turn) => turn.checks);
  const failed = checks.filter((check) => !check.pass).map((check) => check.id);

  return {
    score: output.success ? 1 : 0,
    metadata: {
      rationale: output.success ? 'every turn and check passed' : failureRationale(output),
      passedChecks: checks.length - failed.length,
      totalChecks: checks.length,
      failedChecks: failed,
    },
  };
});

/**
 * Register one task as model x arm x trial cases. Trials run concurrently, each on its own
 * workspace and its own account (`slot.ts`), so a task takes as long as its slowest trial. A missing
 * identity, a bad matrix or one past the trial accounts a deployment has fails here, at collection,
 * before any inference. Every trial's evidence goes under one directory per run, retained
 * beside every other family's runs (`resolveArtifactRoot`), never under a swept root.
 */
export function defineTaskEval(task: EvalTask): void {
  const matrix = evalMatrix(process.env, ARMS.map((arm) => arm.id));
  const target = resolveEvalTarget(process.env);

  const evidence = join(
    resolveArtifactRoot({ flag: undefined, env: { BENCH_ARTIFACTS: process.env.BENCH_ARTIFACTS }, repoRoot: join(import.meta.dirname, '../..'), runRoot: tmpdir() }),
    `evals-${task.id}-${String(Date.now())}`,
  );

  const taskFiles = readdirSync(join(import.meta.dirname, '../tasks')).filter((name) => name.endsWith('.eval.ts'));

  trialAccounts(taskFiles, matrix);

  const harness = createKinuHarness(task, target, {
    taskVersion: taskVersion(task), evalCommit: evalCommit(process.env),
    slotOf: (input) => trialSlot({ taskFiles, task: task.id, matrix, ...input }),
  }, evidence);

  describeEval(task.id, { harness }, (it) => {
    for (const model of matrix.models) {
      for (const arm of matrix.arms) {
        for (let trial = 1; trial <= matrix.trials; trial += 1) {
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
