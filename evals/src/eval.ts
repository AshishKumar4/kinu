import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll } from 'vitest';
import { createJudge, describeEval } from 'vitest-evals';
import { resolveArtifactRoot } from '../../scripts/bench-retention';
import { evalCommit, evalMatrix } from './config';
import { createKinuHarness } from './harness';
import { deleteWorkspace, listWorkspaces } from './session';
import { heldWorkspaces, sweepEvalWorkspaces } from './sweep';
import { ARMS, resolveEvalTarget, type EvalTarget } from './target';
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

/** Before a task's first trial: its account keeps no eval workspace a dead run left behind (`sweep.ts`). */
async function sweep(target: EvalTarget): Promise<void> {
  const swept = await sweepEvalWorkspaces({
    list: () => listWorkspaces(target.origin, target.identity),
    remove: (name) => deleteWorkspace(target.origin, target.identity, name),
    held: heldWorkspaces(target.origin),
    now: Date.now(),
  });

  console.warn(`[evals] ${target.origin}: deleted ${String(swept.deleted.length)} eval workspace(s) no run still marks live`
    + `${swept.deleted.length === 0 ? '' : ` (${swept.deleted.join(', ')})`}; ${String(swept.live.length)} marked live`
    + `${swept.held.map(({ name, reason }) => `; ${name} held: ${reason}`).join('')}`);
}

/**
 * Register one task as model x arm x trial cases. Trials run concurrently, each on its own
 * workspace, so a task takes as long as its slowest trial. A run holds trials `firstTrial` onward,
 * so one task's trials can be split across jobs. A missing identity or a bad matrix fails here, at
 * collection, before any inference. Every trial's evidence goes under one directory per run, retained
 * beside every other family's runs (`resolveArtifactRoot`), never under a swept root.
 */
export function defineTaskEval(task: EvalTask): void {
  const matrix = evalMatrix(process.env, ARMS.map((arm) => arm.id));
  const target = resolveEvalTarget(process.env);

  const evidence = join(
    resolveArtifactRoot({ flag: undefined, env: { BENCH_ARTIFACTS: process.env.BENCH_ARTIFACTS }, repoRoot: join(import.meta.dirname, '../..'), runRoot: tmpdir() }),
    `evals-${task.id}-${String(Date.now())}`,
  );

  const harness = createKinuHarness(task, target, { taskVersion: taskVersion(task), evalCommit: evalCommit(process.env) }, evidence);

  describeEval(task.id, { harness }, (it) => {
    beforeAll(() => sweep(target));

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
