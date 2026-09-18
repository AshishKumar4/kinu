// The one hang detector for every runner path: a process-tree deadline.
//
// No test carries a clock (`gate:test-clocks`; every bun row runs `--timeout=0`
// and every vitest config sets `testTimeout: 0`), so a test that hangs ends
// only when something outside it ends it. `scripts/deploy.sh` wraps each
// planned row in `timeout` at the row's own deadline; this module is that
// same wrapper for every other path — the ladder's commit and push tiers
// (`.githooks/*` → `ladder.ts --tier`), the package scripts a hand run
// reaches through `ladder.ts --run` (`bun run test:core`, `test:workerd`, …),
// `scripts/test.sh`, `scripts/test-cli.ts`, `scripts/setup-worktree.sh` — so
// a hung suite is killed and NAMED at the same deadline wherever it was
// started, never left holding `git push` open forever.
//
// The kill is SIGTERM to the child: `bun test` and vitest both end their
// workers on it, and a SIGKILL after `KILL_AFTER_SECONDS` covers a child that
// does not. Which deadline applies is the ladder's knowledge
// (`scriptDeadline` in ladder.ts); this module only enforces one.

/** Seconds between SIGTERM at the deadline and SIGKILL, for a child that
 *  ignores the first — the same grace `deploy.sh` gives (`--kill-after=5s`). */
export const KILL_AFTER_SECONDS = 5;

/** The exit code a killed run reports: coreutils `timeout`'s own, so a
 *  reader of either path sees one figure for "ended at its deadline". */
export const DEADLINE_EXIT_CODE = 124;

export interface DeadlineRun {
  /** The command, spawned with no shell. */
  readonly argv: readonly string[];
  /** The bound, in seconds. */
  readonly seconds: number;
  /** What the bound is: the ladder row's label or the script's name, printed
   *  with the kill so the reader knows which deadline ended the run. */
  readonly label: string;
  readonly cwd?: string;
  /** Where the child's output goes; the tier runner inherits, a test pipes. */
  readonly stdio?: 'inherit' | 'pipe';
  readonly env?: Record<string, string | undefined>;
}

export interface DeadlineOutcome {
  readonly exitCode: number;
  /** True when the deadline, not the command, ended the run. */
  readonly killed: boolean;
  readonly seconds: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The line printed when a run is ended at its deadline. One shape, so the
 *  ladder's transcript and a hand run's terminal read the same. */
export function deadlineLine(run: Pick<DeadlineRun, 'label' | 'seconds'>, elapsed: number): string {
  return `KILLED  ${run.label}  at its ${String(run.seconds)}s deadline after ${elapsed.toFixed(1)}s — `
    + 'the run hung; the deadline is the hang detector, not a per-test clock, and the fix is the hang';
}

/** The text of a piped stream; an inherited one is a number (the fd) and
 *  has no text here. */
async function pipedText(stream: ReadableStream | number | undefined): Promise<string> {
  return stream instanceof ReadableStream ? await new Response(stream).text() : '';
}

/**
 * Run `argv` under a process-tree deadline and report how it ended.
 *
 * Asynchronous so the deadline is a timer beside a running child rather than
 * a busy wait, and so the SIGKILL grace can run after the SIGTERM.
 */
export async function runUnderDeadline(run: DeadlineRun): Promise<DeadlineOutcome> {
  const started = performance.now();
  const stdio = run.stdio ?? 'inherit';

  const child = Bun.spawn([...run.argv], {
    cwd: run.cwd,
    stdout: stdio,
    stderr: stdio,
    env: run.env === undefined ? process.env : { ...process.env, ...run.env },
  });

  let killed = false;

  const deadline = setTimeout(() => {
    killed = true;
    child.kill('SIGTERM');
    setTimeout(() => { child.kill('SIGKILL'); }, KILL_AFTER_SECONDS * 1000).unref();
  }, run.seconds * 1000);

  const exitCode = await child.exited;
  clearTimeout(deadline);
  const seconds = (performance.now() - started) / 1000;
  const stdout = await pipedText(child.stdout);
  const stderr = await pipedText(child.stderr);

  if (killed) {
    const line = deadlineLine(run, seconds);

    if (stdio === 'inherit') console.error(`\n${line}`);

    return { exitCode: DEADLINE_EXIT_CODE, killed, seconds, stdout, stderr: stdio === 'pipe' ? `${stderr}\n${line}` : stderr };
  }

  return { exitCode, killed, seconds, stdout, stderr };
}
