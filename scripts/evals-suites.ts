/**
 * The daily gated release's two suites (owner, 2026-10-21, "Fast daily, Minecraft weekly"): the fast tasks run on the
 * build production serves once a day; the computer suite, Minecraft played by hand on the agent's own desktop, runs
 * weekly and on any build that changes the computer or the desktop, and a regression in either holds promotion. A deploy's
 * soak runs the fast tasks alone: the computer suite was 78% of a full run's tokens (2026-10-21, 318M of 407M).
 */

export const EVAL_SUITES = ['fast', 'computer'] as const;

export type EvalSuite = (typeof EVAL_SUITES)[number];

/** The computer suite's tasks. */
const COMPUTER_TASKS: readonly string[] = ['evals/tasks/minecraft.eval.ts'];

/** `all`'s tasks that `suite` runs, in their order. */
export function suiteTasks(suite: EvalSuite, all: readonly string[]): string[] {
  return all.filter((file) => COMPUTER_TASKS.includes(file) === (suite === 'computer'));
}

/**
 * The code the computer suite measures, as git pathspecs: the box and its desktop, the stream the owner watches, the
 * desktop actions and their declarations, and the task's own files. A build with a change here since the computer
 * verdict's build is not promoted until the suite has run on it.
 */
export const COMPUTER_PATHS: readonly string[] = [
  'packages/devbox/', 'packages/cf-backend/public/kasmvnc/', 'packages/cf-backend/src/kinu-devbox.ts',
  'packages/cf-backend/src/devbox-golden.ts', 'packages/cf-backend/src/sandbox-lifecycle.ts',
  'packages/cf-backend/src/sandbox-exec-lane.ts', 'packages/cf-backend/src/computer-size.ts',
  'packages/cf-backend/src/components/surfaces/DesktopScreen.tsx', 'packages/cf-backend/src/components/surfaces/EnvironmentSurface.tsx',
  // The desktop's stream route, and the box's desktop as the Worker's runtime registers it.
  'packages/cf-backend/src/terminal-route.ts', 'packages/cf-backend/src/runtime.ts', 'packages/core/src/execution/desktop.ts',
  'packages/core/src/execution/sandbox.ts', 'packages/core/src/http/desktop-client.ts', 'packages/core/src/operations/executors.ts',
  'evals/tasks/minecraft.ts', 'evals/tasks/minecraft.eval.ts',
];

/** How old the computer verdict may be: a week, and a day for its run's own length and the timer's slack. */
export const COMPUTER_VERDICT_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
