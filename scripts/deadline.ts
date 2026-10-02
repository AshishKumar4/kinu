// The one hang detector for every runner path: a process-tree SILENCE bound.
//
// No test carries a clock (`gate:test-clocks`; every bun row runs `--timeout=0`
// and every vitest config sets `testTimeout: 0`), so a test that hangs ends
// only when something outside it ends it. This module is that something for
// every path — the ladder's tiers (`.githooks/*` → `ladder.ts --tier`), the
// deploy's rows (`deploy.sh` → `ladder.ts --gate`), the package scripts a hand
// run reaches through `ladder.ts --run` (`bun run test:core`, `test:workerd`,
// …), `scripts/test.sh`, `scripts/test-cli.ts`, `scripts/setup-worktree.sh` —
// so a hung suite is killed and NAMED wherever it was started, never left
// holding `git push` open forever.
//
// A run is hung when it writes nothing, not when it is slow. Until 2026-09-29
// the bound was total wall time, and on integration/0965 fa8bd6c4ae it killed
// the CLI suite at 480 s after 484 tests had passed in 476 s (ci-0965z). That
// suite takes 139-173 s alone with its scratch in RAM and 276-345 s on the
// scratch NVMe beside the other lanes, and was killed there twice more with
// nothing running beside it: the box's disk, not a hang, set its length. So
// the bound is silence: a run is killed once it has written nothing to stdout
// or stderr for the row's bound. Measured the same day on the scratch NVMe at
// load 35-56, the CLI suite's longest wait between two test results was 74.5 s
// (`kinu export / import`); a gate that prints only its verdict (`secret-scan`,
// 149 s at load 43) is silent for its whole run, which is why the bound per row
// stays what the wall bound was, 480 s unless the row declares its own.
//
// The kill is SIGTERM to the child: `bun test` and vitest both end their
// workers on it, and a SIGKILL after `KILL_AFTER_SECONDS` covers a child that
// does not. Which bound applies is the ladder's knowledge (`scriptDeadline` in
// ladder.ts); this module only enforces one. A cancel of the runner itself (a
// terminal's Ctrl-C, a stop of its service) ends its runs the same way, SIGTERM
// then SIGKILL, so a run that records what it was doing when cancelled gets to.
//
// Before the kill, the run is told: at three quarters of its bound of silence a line is appended to the file named
// by `KINU_SILENCE_NOTICE`, so a run that can say what it is stuck on (the gallery harness's open waits) says it
// while the log is still read. A run that does not watch the file loses nothing.
//
// A run that exits is also asked what it left running: every process it starts
// inherits `KINU_RUN`, and one still carrying it after the exit fails the run
// and is ended. Measured 2026-09-24: `bun test` of unit-pc-agent-exec left
// nine 30 MB supervisors and a `sleep 20`, and the run reported success.

import { appendFileSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tolerate } from '@kinu.run/core/obs';
import { procFile, processStartTicks } from './process-owner';

/** Seconds between SIGTERM at the bound and SIGKILL, for a child that ignores the first. */
export const KILL_AFTER_SECONDS = 5;

/** The exit code a killed run reports: coreutils `timeout`'s own, so a
 *  reader sees one figure for "ended by the hang detector". */
export const DEADLINE_EXIT_CODE = 124;

/** Names the file a run is told through that its silence nears the bound; one line is appended per silent stretch. */
export const SILENCE_NOTICE_ENV = 'KINU_SILENCE_NOTICE';

/** How far into its bound of silence a run is told: late enough that a slow run is not, early enough to answer. */
const NOTICE_AT = 0.75;

/** The name every process a run starts inherits, so what outlives the run is found by it. */
export const RUN_MARK = 'KINU_RUN';

/** What the hang detector and the leftover check cannot see, printed on a green tier. */
export const DEADLINE_BLIND_SPOTS = [
  'HANG: a run that keeps writing and never ends is not killed; the bound is silence, not duration',
  'LEFTOVERS: a process that both rebuilt its environment without KINU_RUN (`env -i`, the device sandbox\'s allow-list) and started a session of its own is not found; one holding the output is cut off at the bound, not ended',
  'LEFTOVERS: outside Linux there is no /proc to read, so nothing is looked for',
] as const;

export interface DeadlineRun {
  /** The command, spawned with no shell. */
  readonly argv: readonly string[];
  /** The longest the run may write nothing to stdout or stderr, in seconds. */
  readonly seconds: number;
  /** What the bound is: the ladder row's label or the script's name, printed
   *  with the kill so the reader knows which bound ended the run. */
  readonly label: string;
  readonly cwd?: string;
  /** Where the child's output goes; the tier runner inherits, a test pipes. `tee` passes it on as it comes and keeps
   *  it too: a deploy's one-row phase stays live, and its report can still quote a red row's output. */
  readonly stdio?: 'inherit' | 'pipe' | 'tee';
  /** The child's WHOLE environment. Absent, the child inherits this
   *  process's; the ladder passes a derived gate exactly the names its cache
   *  key hashes (`gateEnvironment` in `ladder-cache.ts`). */
  readonly env?: Record<string, string>;
  /** Told the run's output as it arrives and the run's end: a deploy's live status (`deploy-live.ts`). */
  readonly status?: RunStatus;
}

/** What a run's watcher is told: each piece of its output as it arrives, with the stream it came on, and its end. The
 *  end is told before a cancel's exit waits on it, so what is still running then is what the cancel killed. */
export interface RunStatus {
  readonly output: (text: string, from: 'stdout' | 'stderr') => void;
  readonly ended: () => void;
}

export interface DeadlineOutcome {
  readonly exitCode: number;
  /** True when the hang detector, not the command, ended the run. */
  readonly killed: boolean;
  /** Processes of the run still running when it exited, each `<pid> <command>`; ended with SIGKILL. */
  readonly leftovers: readonly string[];
  readonly seconds: number;
  /** The longest the run wrote nothing, in seconds: what its bound is measured against. */
  readonly longestSilence: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The line printed when a run is ended by the hang detector. One shape, so the
 *  ladder's transcript and a hand run's terminal read the same. */
export function deadlineLine(run: Pick<DeadlineRun, 'label' | 'seconds'>, elapsed: number): string {
  return `KILLED  ${run.label}  after ${String(run.seconds)}s with no output, ${elapsed.toFixed(1)}s in — `
    + 'the run hung; the bound is silence, not a per-test clock, and the fix is the hang';
}

/** The line printed when a run exits with processes of its own still running. */
export function leftoverLine(run: Pick<DeadlineRun, 'label'>, leftovers: readonly string[]): string {
  return `LEFT    ${run.label}  exited with ${String(leftovers.length)} process(es) of its own still running, now ended: `
    + `${leftovers.join('; ')} — a run ends what it starts; the fix is in whatever started them`;
}

/**
 * How long a process caught inside its exec is given to finish it. The kernel installs the new image before it lays
 * out the image's arguments and environment, and in between both read empty: measured 2026-09-26 under 24 CPU
 * burners, the moment a shell that had backgrounded a child exited, 18 of 400 such children read an empty
 * environment, in which no run's mark can be found, and 6 an empty command line. Read too early, the child was no
 * leftover, and a run that piped its output then waited on it until it exited by itself.
 */
const EXEC_SETTLE_MS = 1_000;

/** `/proc/<pid>/<name>` once the process's exec has laid it out: read again while it reads empty, for at most
 *  {@link EXEC_SETTLE_MS}. Undefined once the process is gone, or, for `environ`, when the read is refused. */
async function laidOut(pid: number, name: 'environ' | 'cmdline'): Promise<string | undefined> {
  const until = performance.now() + EXEC_SETTLE_MS;

  for (;;) {
    // A process this user owns that holds a capability this one lacks refuses the environ read (the kernel's ptrace
    // check): the user manager, which holds CAP_WAKE_ALARM, and its children between fork and exec. It is no run's.
    const text = name === 'environ' ? tolerate(() => procFile(pid, name), 'eacces') : procFile(pid, name);

    if (text !== '' || performance.now() >= until) return text;
    await Bun.sleep(1);
  }
}

/** Kill `pid` and describe it as `<pid> <command>`: as it was when ended, which, between its fork and its exec, is
 *  the program it was forked from. */
async function end(pid: number): Promise<string> {
  const command = (await laidOut(pid, 'cmdline'))?.replaceAll('\0', ' ').trim() ?? '';
  const stat = command === '' ? procFile(pid, 'stat') : undefined;
  const description = command || (stat === undefined ? '[exited before cmdline was read]' : `[comm: ${stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'))}]`);

  tolerate(() => process.kill(pid, 'SIGKILL'), 'esrch');

  return `${String(pid)} ${description}`;
}

/** End every live process whose environment carries `mark` as `KINU_RUN`; each as `<pid> <command>`. */
export async function endLeftovers(mark: string): Promise<string[]> {
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
    const environ = await laidOut(pid, 'environ');

    if (environ !== undefined && `\0${environ}`.includes(entry)) left.push(await end(pid));
  }

  return left;
}

/**
 * End every live child of `parent`; each as `<pid> <command>`. The environment check above misses a child spawned
 * with an environment of its own (the pc-agent supervisors run under the sandbox's allow-list); while its parent
 * lives, the parent is what names it.
 */
export async function endChildren(parent: number): Promise<string[]> {
  return await endWhere((fields) => Number(fields[1]) === parent);
}

/**
 * End every live process of the session `leader` started; each as `<pid> <command>`. The run's own session holds
 * what the environment check cannot see once its parent has gone: a child that dropped the mark (`env -i`).
 */
async function endSession(leader: number): Promise<string[]> {
  return await endWhere((fields) => Number(fields[3]) === leader);
}

/** End every live process whose `/proc/<pid>/stat` fields after the command name (state, ppid, pgrp, session, …)
 *  satisfy `matches`; each as `<pid> <command>`. */
async function endWhere(matches: (fields: readonly string[]) => boolean): Promise<string[]> {
  const left: string[] = [];

  for (const name of tolerate(() => readdirSync('/proc'), 'enoent') ?? []) {
    const stat = /^\d+$/u.test(name) ? procFile(name, 'stat') : undefined;
    const fields = stat?.slice(stat.lastIndexOf(')') + 2).split(' ') ?? [];

    if (fields[0] !== undefined && fields[0] !== 'Z' && matches(fields)) left.push(await end(Number(name)));
  }

  return left;
}

/** How often the watchdog asks how long the run has been silent. */
const WATCH_MS = 250;

/** Signals whose default ends this process, and the code it exits with on one: a run leads a session of its own, so
 *  neither a terminal's Ctrl-C nor a stop of this process reaches it, and each is passed on. */
const PASSED_ON = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

type PassedOn = keyof typeof PASSED_ON;

/** A run of this process still running: how to signal its process group, and when its runner is done with it. */
interface LiveRun {
  readonly signal: (signal: NodeJS.Signals) => void;
  readonly done: Promise<void>;
}

/** Every run of this process still running. */
const live = new Set<LiveRun>();

/** The signal that cancelled this process's runs, once one has: no run starts after it, and none returns. */
let cancelledBy: PassedOn | null = null;

/**
 * End every run as the hang detector ends one, SIGTERM then SIGKILL {@link KILL_AFTER_SECONDS} later, then this
 * process. Until 2026-10-01 a cancel was SIGKILL at once, and only of the first run: the eval pass's trials were lost
 * unrecorded, and every other run of a deploy wave kept running with nothing left to end it.
 */
function cancel(signal: PassedOn): void {
  if (cancelledBy !== null) return;
  cancelledBy = signal;
  const running = [...live];
  const grace = Promise.withResolvers<void>();

  for (const run of running) run.signal('SIGTERM');
  setTimeout(grace.resolve, KILL_AFTER_SECONDS * 1000);

  const exit = (): void => {
    for (const run of live) run.signal('SIGKILL');
    process.exit(PASSED_ON[signal]);
  };

  Promise.race([Promise.all(running.map(async (run) => { await run.done; })), grace.promise]).then(exit, exit);
}

const onSignal: Readonly<Record<PassedOn, () => void>> = {
  SIGINT: () => { cancel('SIGINT'); },
  SIGTERM: () => { cancel('SIGTERM'); },
  SIGHUP: () => { cancel('SIGHUP'); },
};

/** Watch the signals while a run is running, and only then: with none, each ends this process as it would alone. */
function enlist(run: LiveRun): () => void {
  if (live.size === 0) for (const [signal, listener] of Object.entries(onSignal)) process.on(signal, listener);
  live.add(run);

  return () => {
    live.delete(run);

    if (live.size === 0 && cancelledBy === null) for (const [signal, listener] of Object.entries(onSignal)) process.off(signal, listener);
  };
}

/** What a run of a cancelled runner gives its caller: nothing, as the process ends from {@link cancel}. A caller's next
 *  step, the next row of a wave or a red recorded for a row it cancelled, is no step of a cancelled runner. */
function unended(): Promise<never> {
  return new Promise<never>(() => undefined);
}

/** A record is not drained at the reader's EOF: process.exit can discard pending stream writes. */
export function writeFully(onward: NodeJS.WriteStream, value: string | Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    onward.write(value, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Run `argv` under the process-tree hang detector and report how it ended.
 *
 * The child's output is always piped, because output is how progress is seen: every chunk it writes restarts the
 * silence, and an inherited run has each chunk passed on to this process's own stream as it arrives. The child leads
 * a session of its own, and the run is that session: a kill reaches its whole process group, and whatever of it is
 * still alive after the child exits is a leftover, marked or not. The bound holds until the output pipes close, so a
 * process that holds one open is ended by it too. Asynchronous so the watchdog is a timer beside a running child
 * rather than a busy wait, and so the SIGKILL grace can run after the SIGTERM.
 */
export async function runUnderDeadline(run: DeadlineRun): Promise<DeadlineOutcome> {
  if (cancelledBy !== null) return await unended();
  const outcome = await watched(run);

  if (cancelledBy !== null) return await unended();

  return outcome;
}

async function watched(run: DeadlineRun): Promise<DeadlineOutcome> {
  const started = performance.now();
  const stdio = run.stdio ?? 'inherit';
  const mark = crypto.randomUUID();

  const noticeDir = mkdtempSync(join(tmpdir(), 'kinu-silence-'));
  const notice = join(noticeDir, 'notice');

  writeFileSync(notice, '');

  const child = Bun.spawn([...run.argv], {
    cwd: run.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
    env: { ...(run.env ?? process.env), [RUN_MARK]: mark, [SILENCE_NOTICE_ENV]: notice },
  });

  const signalGroup = (signal: NodeJS.Signals): void => {
    tolerate(() => process.kill(-child.pid, signal), 'esrch');
  };

  const done = Promise.withResolvers<void>();
  const release = enlist({ signal: signalGroup, done: done.promise });

  let lastOutput = started;
  let longestSilence = 0;

  const heard = (): void => {
    const now = performance.now();
    longestSilence = Math.max(longestSilence, now - lastOutput);
    lastOutput = now;
  };

  const readers = [child.stdout.getReader(), child.stderr.getReader()] as const;

  const decoding = stdio !== 'inherit' || run.status !== undefined;

  const pump = async (reader: ReadableStreamDefaultReader<Uint8Array>, onward: NodeJS.WriteStream, from: 'stdout' | 'stderr'): Promise<string> => {
    const decoder = new TextDecoder();
    let text = '';

    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      heard();
      const piece = decoding ? decoder.decode(read.value, { stream: true }) : '';

      if (stdio !== 'inherit') text += piece;
      run.status?.output(piece, from);

      // A cancelled run's piped output is passed on too: what it says while it ends is what it was doing.
      if (stdio !== 'pipe' || cancelledBy !== null) await writeFully(onward, read.value);
    }

    return text + decoder.decode();
  };

  const output = Promise.all([pump(readers[0], process.stdout, 'stdout'), pump(readers[1], process.stderr, 'stderr')]);
  let killed = false;
  // The leftover search waits out a process caught inside its exec, which is this runner's time, not the run's:
  // the bound is not judged while it runs, and after it counts from its end.
  let searching = false;
  let searchedAt = 0;
  // Resolved once the kill's grace has passed: a holder outside the group is then not waited for.
  const graceOver = Promise.withResolvers<void>();

  // Until the pipes close, not only until the child exits: a process holding one keeps the run open.
  let noticed = -1;

  const watchdog = setInterval(() => {
    const silentFrom = Math.max(lastOutput, searchedAt);
    const silent = performance.now() - silentFrom;

    if (!killed && !searching && noticed !== silentFrom && silent >= run.seconds * 1000 * NOTICE_AT) {
      noticed = silentFrom;
      appendFileSync(notice, `silent ${(silent / 1000).toFixed(1)}s of ${String(run.seconds)}s\n`);
    }

    if (killed || searching || silent < run.seconds * 1000) return;
    killed = true;
    signalGroup('SIGTERM');
    setTimeout(() => {
      signalGroup('SIGKILL');
      graceOver.resolve();
    }, KILL_AFTER_SECONDS * 1000).unref();
  }, WATCH_MS);

  const exitCode = await child.exited;
  // Before the pipes are drained: a leftover holding one would keep it open forever. The session first: its
  // members are known without reading an environment, and one that dropped the mark reads an empty one.
  searching = true;
  const found = [...await endSession(child.pid), ...await endLeftovers(mark)];
  searching = false;
  searchedAt = performance.now();
  const leftovers = [...new Map(found.map((line) => [line.split(' ')[0], line])).values()];
  const drained = await Promise.race([output.then(() => true), graceOver.promise.then(() => false)]);

  if (!drained) await Promise.all(readers.map(async (reader) => { await reader.cancel(); }));
  const [stdout, stderr] = await output;
  clearInterval(watchdog);
  rmSync(noticeDir, { recursive: true, force: true });
  release();
  run.status?.ended();
  done.resolve();
  longestSilence = Math.max(longestSilence, performance.now() - lastOutput);
  const seconds = (performance.now() - started) / 1000;
  const measured = { leftovers, seconds, longestSilence: longestSilence / 1000, stdout };

  if (killed) {
    const line = deadlineLine(run, seconds);

    if (stdio !== 'pipe') console.error(`\n${line}`);

    return { ...measured, exitCode: DEADLINE_EXIT_CODE, killed, stderr: stdio === 'inherit' ? stderr : `${stderr}\n${line}` };
  }

  if (leftovers.length > 0) {
    const line = leftoverLine(run, leftovers);

    if (stdio !== 'pipe') console.error(`\n${line}`);

    return { ...measured, exitCode: exitCode === 0 ? 1 : exitCode, killed, stderr: stdio === 'inherit' ? stderr : `${stderr}\n${line}` };
  }

  return { ...measured, exitCode, killed, stderr };
}
