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
//
// A run that exits is also asked what it left running: every process it starts
// inherits `KINU_RUN`, and one still carrying it after the exit fails the run
// and is ended. Measured 2026-09-24: `bun test` of unit-pc-agent-exec left
// nine 30 MB supervisors and a `sleep 20`, and the run reported success.

import { readdirSync, statSync } from 'node:fs';
import { tolerate } from '@kinu.run/core/obs';
import { procFile, processStartTicks } from './process-owner';

/** Seconds between SIGTERM at the deadline and SIGKILL, for a child that
 *  ignores the first — the same grace `deploy.sh` gives (`--kill-after=5s`). */
export const KILL_AFTER_SECONDS = 5;

/** The exit code a killed run reports: coreutils `timeout`'s own, so a
 *  reader of either path sees one figure for "ended at its deadline". */
export const DEADLINE_EXIT_CODE = 124;

/** The name every process a run starts inherits, so what outlives the run is found by it. */
export const RUN_MARK = 'KINU_RUN';

/** What the leftover check cannot see, printed on a green tier. */
export const LEFTOVER_BLIND_SPOTS = [
  'LEFTOVERS: a process that rebuilt its environment without KINU_RUN (`env -i`, the device sandbox\'s allow-list) is not found',
  'LEFTOVERS: outside Linux there is no /proc to read, so nothing is looked for; `scripts/deploy.sh` wraps its rows in coreutils `timeout`, not this runner',
] as const;

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
  /** The child's WHOLE environment. Absent, the child inherits this
   *  process's; the ladder passes a derived gate exactly the names its cache
   *  key hashes (`gateEnvironment` in `ladder-cache.ts`). */
  readonly env?: Record<string, string>;
}

export interface DeadlineOutcome {
  readonly exitCode: number;
  /** True when the deadline, not the command, ended the run. */
  readonly killed: boolean;
  /** Processes of the run still running when it exited, each `<pid> <command>`; ended with SIGKILL. */
  readonly leftovers: readonly string[];
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

/** The line printed when a run exits with processes of its own still running. */
export function leftoverLine(run: Pick<DeadlineRun, 'label'>, leftovers: readonly string[]): string {
  return `LEFT    ${run.label}  exited with ${String(leftovers.length)} process(es) of its own still running, now ended: `
    + `${leftovers.join('; ')} — a run ends what it starts; the fix is in whatever started them`;
}

/** Kill `pid` and describe it as `<pid> <command>`. */
function end(pid: number): string {
  const command = procFile(pid, 'cmdline') ?? '';

  tolerate(() => process.kill(pid, 'SIGKILL'), 'esrch');

  return `${String(pid)} ${command.replaceAll('\0', ' ').trim()}`;
}

/** End every live process whose environment carries `mark` as `KINU_RUN`; each as `<pid> <command>`. */
export function endLeftovers(mark: string): string[] {
  // Off Linux there is no /proc: nothing can be read, so nothing is found.
  const since = processStartTicks(process.pid);

  if (since === undefined) return [];
  const uid = process.getuid?.();
  const entry = `\0${RUN_MARK}=${mark}\0`;
  const left: string[] = [];

  for (const name of readdirSync('/proc')) {
    const pid = Number(name);

    // A run's process started after this runner and holds an environment this user owns: one that
    // raised its privileges has it owned by root, and the user's own systemd refuses the read.
    if (!Number.isSafeInteger(pid) || (processStartTicks(pid) ?? 0) < since) continue;

    if (statSync(`/proc/${name}/environ`, { throwIfNoEntry: false })?.uid !== uid) continue;
    // A process this user owns that holds a capability this one lacks refuses the read (the kernel's ptrace check):
    // the user manager, which holds CAP_WAKE_ALARM, and its children between fork and exec. It is no run's.
    const environ = tolerate(() => procFile(pid, 'environ'), 'eacces');

    if (environ !== undefined && `\0${environ}`.includes(entry)) left.push(end(pid));
  }

  return left;
}

/**
 * End every live child of `parent`; each as `<pid> <command>`. The environment check above misses a child spawned
 * with an environment of its own (the pc-agent supervisors run under the sandbox's allow-list); while its parent
 * lives, the parent is what names it.
 */
export function endChildren(parent: number): string[] {
  const left: string[] = [];

  for (const name of tolerate(() => readdirSync('/proc'), 'enoent') ?? []) {
    const stat = /^\d+$/u.test(name) ? procFile(name, 'stat') : undefined;
    const [state, ppid] = stat?.slice(stat.lastIndexOf(')') + 2).split(' ') ?? [];

    if (Number(ppid) === parent && state !== 'Z') left.push(end(Number(name)));
  }

  return left;
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
  const mark = crypto.randomUUID();

  const child = Bun.spawn([...run.argv], {
    cwd: run.cwd,
    stdout: stdio,
    stderr: stdio,
    env: { ...(run.env ?? process.env), [RUN_MARK]: mark },
  });

  let killed = false;

  const deadline = setTimeout(() => {
    killed = true;
    child.kill('SIGTERM');
    setTimeout(() => { child.kill('SIGKILL'); }, KILL_AFTER_SECONDS * 1000).unref();
  }, run.seconds * 1000);

  const exitCode = await child.exited;
  clearTimeout(deadline);
  // Before the pipes are read: a leftover holding one would keep it open forever.
  const leftovers = endLeftovers(mark);
  const seconds = (performance.now() - started) / 1000;
  const stdout = await pipedText(child.stdout);
  const stderr = await pipedText(child.stderr);

  if (killed) {
    const line = deadlineLine(run, seconds);

    if (stdio === 'inherit') console.error(`\n${line}`);

    return { exitCode: DEADLINE_EXIT_CODE, killed, leftovers, seconds, stdout, stderr: stdio === 'pipe' ? `${stderr}\n${line}` : stderr };
  }

  if (leftovers.length > 0) {
    const line = leftoverLine(run, leftovers);

    if (stdio === 'inherit') console.error(`\n${line}`);

    return { exitCode: exitCode === 0 ? 1 : exitCode, killed, leftovers, seconds, stdout, stderr: stdio === 'pipe' ? `${stderr}\n${line}` : stderr };
  }

  return { exitCode, killed, leftovers, seconds, stdout, stderr };
}
