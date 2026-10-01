// The eval run's reporter: vitest-evals' own, which prints each trial with its score and reason, plus the suites that
// failed. For a run of `.eval.ts` files alone, vitest-evals 0.16.1 replaces vitest's summary with its own and drops
// the "Failed Suites" part of it, so a task file that did not load, or a hook that threw before its trials, read as
// "failed" with every trial "skipped" and no reason anywhere: the 2026-10-01 staging pass lost 24 trials that way.
//
// It also owns the run's cancel. vitest exits a millisecond after SIGTERM or SIGINT, writing no report; here the run
// goes on until each open trial has recorded what held its workspace (`cancel.ts`), then exits 143 or 130 naming them.
import { readdirSync, readFileSync } from 'node:fs';
import * as v from 'valibot';
import EvalReporter from 'vitest-evals/reporter';
import type { RunnerTask, RunnerTestFile } from 'vitest';
import type { Vitest } from 'vitest/node';
import { CANCEL_SIGNALS, type CancelSignal } from './cancel';

/** How a cancelled run exits: as a process the signal ended would. */
const CANCEL_EXIT: Readonly<Record<CancelSignal, number>> = { SIGINT: 130, SIGTERM: 143 };

/** The part of a trial's record that says the run's cancel ended it, and what held its workspace then. */
const CancelledTrialSchema = v.looseObject({
  harness: v.looseObject({
    run: v.looseObject({
      output: v.looseObject({ turns: v.array(v.looseObject({ outcome: v.looseObject({ status: v.string(), message: v.optional(v.string()) }) })) }),
    }),
  }),
});

/** `read`'s answer, or `none` when what it reads went away first: a process that exited, or no `/proc` at all. Not
 *  `tolerate` from core: vitest loads a reporter without the suite's zod interop, and core's observability reaches zod. */
function unlessGone<T>(read: () => T, none: T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH')) return none;
    throw error;
  }
}

/** This process's vitest fork workers, which a signal sent to this process alone does not reach. */
function workers(): number[] {
  return unlessGone(() => readdirSync('/proc'), []).filter((name) => /^\d+$/u.test(name)).flatMap((name) => {
    const stat = unlessGone(() => readFileSync(`/proc/${name}/stat`, 'utf8'), '');
    const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    const command = parent === process.pid ? unlessGone(() => readFileSync(`/proc/${name}/cmdline`, 'utf8'), '') : '';

    return command.includes('/vitest/dist/workers/') ? [Number(name)] : [];
  });
}

/** Every suite under `tasks` whose own result carries errors: a file that did not load, a describe whose hook threw. */
function failedSuites(tasks: readonly RunnerTask[]): RunnerTask[] {
  return tasks.flatMap((task) => task.type === 'suite'
    ? [...(task.result?.errors?.length ?? 0) > 0 ? [task] : [], ...failedSuites(task.tasks)]
    : []);
}

export default class KinuEvalReporter extends EvalReporter {
  private cancelledBy: CancelSignal | null = null;

  /** The run's cancel is this reporter's alone: the listeners already here end the run unrecorded, vitest's logger
   *  exiting a millisecond after the signal (`addCleanupListeners`) and signal-exit raising it again once it is alone. */
  override onInit(ctx: Vitest): void {
    super.onInit(ctx);

    for (const signal of CANCEL_SIGNALS) {
      for (const exits of process.listeners(signal)) process.off(signal, exits);
      process.on(signal, () => { this.cancel(signal); });
    }
  }

  override onTestRunEnd(...end: Parameters<EvalReporter['onTestRunEnd']>): void {
    super.onTestRunEnd(...end);

    if (this.cancelledBy === null) return;

    const open = end[0].flatMap((module) => [...module.children.allTests()]).flatMap((test) => {
      const record = v.safeParse(CancelledTrialSchema, test.meta());
      const turn = record.success ? record.output.harness.run.output.turns.find(({ outcome }) => outcome.status === 'cancelled') : undefined;

      return turn === undefined ? [] : [`  ${test.fullName}: ${turn.outcome.message ?? 'cancelled'}`];
    });

    this.error(open.length === 0 ? `[evals] cancelled by ${this.cancelledBy}; no trial was open`
      : `[evals] cancelled by ${this.cancelledBy}, the trials open and what held each:\n${open.join('\n')}`);
    process.exitCode = CANCEL_EXIT[this.cancelledBy];
  }

  /** The first SIGTERM or SIGINT, from the run's process group or this process alone: a repeat is the same cancel. */
  private cancel(signal: CancelSignal): void {
    if (this.cancelledBy !== null) return;
    this.cancelledBy = signal;
    this.error(`[evals] cancelled by ${signal}: each open trial records what holds its workspace, then the run ends`);

    for (const pid of workers()) unlessGone(() => process.kill(pid, signal), false);
  }

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
