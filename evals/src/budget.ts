// How long one trial of a task may run before it fails over budget. Only a backstop: a workspace silent past the hang
// bound fails sooner (`workspace-completion.ts`), and a background job, which publishes nothing while it runs, is waited
// on until it settles. A job that never settles, or a run that never stops streaming, ends here, never holding the run.

/**
 * Each task's slowest passing trial on the default cohort (Muse Spark, Mercury, Ling), in seconds: its p99 wall by
 * nearest rank, as no task has 100. Measured 2026-10-01 over every stored trial on kinu.run and staging, 2026-09-26
 * to 10-01, from 1 to 360 at once (kinu-logs/evals-fast/budgets/measure.txt). A task absent has passed no trial yet.
 */
const SLOWEST_PASSING_S = new Map([
  ['budget-board', 1058], ['chess', 1322], ['freight-desk', 154], ['launch-prep', 588], ['memory-recall', 78], ['order-book', 835],
  ['request-logs', 859], ['site-preview', 595],
]);

/** The slowest passing trial at the suite's full load (budget-board, 360 at once): no task is held to less, so one
 *  measured on few trials, or only at lighter load, or never passed, is not cut short of what any task needed. */
const FULL_LOAD_SLOWEST_S = 1058;

/** A task's slowest passing trial ran up to 2.4 times slower at 360 at once than at 40 or fewer (order-book; request-logs
 *  2.2, budget-board 1.7): three times its slowest covers a task measured only at lighter load, with a margin. */
const MULTIPLE = 3;

/** The trial budget of `task`, in milliseconds. */
export function trialBudgetMs(task: string): number {
  return MULTIPLE * Math.max(SLOWEST_PASSING_S.get(task) ?? 0, FULL_LOAD_SLOWEST_S) * 1000;
}
