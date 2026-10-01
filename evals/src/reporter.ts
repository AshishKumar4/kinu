// The eval run's reporter: vitest-evals' own, which prints each trial with its score and reason, plus the suites that
// failed. For a run of `.eval.ts` files alone, vitest-evals 0.16.1 replaces vitest's summary with its own and drops
// the "Failed Suites" part of it, so a task file that did not load, or a hook that threw before its trials, read as
// "failed" with every trial "skipped" and no reason anywhere: the 2026-10-01 staging pass lost 24 trials that way.
import EvalReporter from 'vitest-evals/reporter';
import type { RunnerTask, RunnerTestFile } from 'vitest';

/** Every suite under `tasks` whose own result carries errors: a file that did not load, a describe whose hook threw. */
function failedSuites(tasks: readonly RunnerTask[]): RunnerTask[] {
  return tasks.flatMap((task) => task.type === 'suite'
    ? [...(task.result?.errors?.length ?? 0) > 0 ? [task] : [], ...failedSuites(task.tasks)]
    : []);
}

export default class KinuEvalReporter extends EvalReporter {
  override reportSummary(files: RunnerTestFile[], errors: unknown[]): void {
    const failed = failedSuites(files);

    if (failed.length > 0) this.error(`\nFailed suites ${String(failed.length)}: their trials did not run`);

    for (const suite of failed) {
      const where = suite.file === undefined || suite.file === suite ? this.relative(suite.name) : `${this.relative(suite.file.filepath)} > ${suite.name}`;

      for (const error of suite.result?.errors ?? []) this.error(`  ${where}: ${error.message}`);
    }

    super.reportSummary(files, errors);
  }
}
