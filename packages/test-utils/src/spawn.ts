import { attempt, KinuError, settle, settleSync, tolerate } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';

/**
 * Whether `pid` is still running. A zombie waiting for its reaper has stopped, though `kill(pid, 0)` still reaches it:
 * under load a killed descendant can wait seconds for pid 1 to reap it.
 */
export function isRunning(pid: number): boolean {
  if (process.platform !== 'linux') return tolerate(() => process.kill(pid, 0), 'esrch') === true;

  // A process reaped between the open and the read answers that read ESRCH: its entry was there and is gone.
  const status = tolerate(() => tolerate(() => readFileSync(`/proc/${String(pid)}/status`, 'utf8'), 'esrch'), 'enoent');

  return status !== undefined && !/^State:\s*Z/mu.test(status);
}

export interface Exited {
  /** Null when a signal ended it. */
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Else stdin is `/dev/null`. */
  readonly stdin?: string;
}

/** Bun otherwise inherits its launch snapshot, not the scratch environment the preload installed. */
export function spawnTest<
  In extends Bun.Spawn.Writable = Bun.Spawn.Writable,
  Out extends Bun.Spawn.Readable = Bun.Spawn.Readable,
  Err extends Bun.Spawn.Readable = Bun.Spawn.Readable,
>(cmd: readonly string[], options?: Bun.Spawn.SpawnOptions<In, Out, Err>): Bun.Subprocess<In, Out, Err>;
export function spawnTest<
  In extends Bun.Spawn.Writable = Bun.Spawn.Writable,
  Out extends Bun.Spawn.Readable = Bun.Spawn.Readable,
  Err extends Bun.Spawn.Readable = Bun.Spawn.Readable,
>(options: Bun.Spawn.SpawnOptions<In, Out, Err> & { cmd: string[] }): Bun.Subprocess<In, Out, Err>;
export function spawnTest<
  In extends Bun.Spawn.Writable,
  Out extends Bun.Spawn.Readable,
  Err extends Bun.Spawn.Readable,
>(command: readonly string[] | (Bun.Spawn.SpawnOptions<In, Out, Err> & { cmd: string[] }), options?: Bun.Spawn.SpawnOptions<In, Out, Err>): Bun.Subprocess<In, Out, Err> {
  if ('cmd' in command) return Bun.spawn({ ...command, env: command.env ?? process.env });

  return Bun.spawn([...command], { ...options, env: options?.env ?? process.env });
}

/** Never `spawnSync`: bun 1.4.0-1.4.2 can spin a later one forever (oven-sh/bun#34069). */
export async function runToExit(cmd: readonly string[], options: RunOptions = {}): Promise<Exited> {
  const child = spawnTest(cmd, {
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exitCode: child.exitCode, signalCode: child.signalCode, stdout, stderr };
}

function ran(cmd: readonly string[], options?: RunOptions): Effect.Effect<Exited, KinuError> {
  return attempt({ doing: `running ${cmd[0] ?? 'a command'}`, otherwise: 'io' }, () => runToExit(cmd, options));
}

/** The exit of `pidwait`, `pwait`, `ps -p` and `pgrep`. */
const NONE_LEFT = 1;

/** As a group, 0 is ours and 1 is everyone. */
const FIRST_OWN_PID = 2;

/** `ps` counts whole seconds; file clocks are coarse. */
const CLOCK_SLACK_S = 2;

function waitForExit(pid: number): Effect.Effect<void, KinuError> {
  return Effect.gen(function* () {
    const waiter = process.platform === 'darwin'
      ? yield* ran(['pwait', String(pid)])
      : yield* ran(['pidwait', '-F', '/dev/stdin'], { stdin: String(pid) });

    if (waiter.exitCode !== 0 && waiter.exitCode !== NONE_LEFT) {
      return yield* Effect.fail(new KinuError('io', `waiting for pid ${String(pid)} to exit failed (${String(waiter.exitCode)}): ${waiter.stderr}`));
    }
  });
}

/** Never a poll. */
export async function awaitExit(pid: number): Promise<void> {
  return settle(waitForExit(pid));
}

export interface Recorded {
  readonly pid: number;
  /** mtime, epoch ms. */
  readonly writtenAt: number;
}

/** One descriptor, so a replaced record cannot mix pid and mtime. */
export function recordedIn(file: string, pattern = /^\s*(\d+)/u): Recorded | null {
  const descriptor = tolerate(() => openSync(file, 'r'), 'enoent');

  if (descriptor === undefined) return null;
  let writtenAt: number;
  let text: string;

  try {
    writtenAt = fstatSync(descriptor).mtimeMs;
    text = readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }

  const pid = Number(pattern.exec(text)?.[1]);

  return settleSync(Number.isSafeInteger(pid) && pid >= FIRST_OWN_PID
    ? Effect.succeed({ pid, writtenAt })
    : Effect.fail(new KinuError('io', `${file} records no pid: ${JSON.stringify(text)}`)));
}

/** `ps` stat and etime, Linux and macOS. */
const STATE_AND_ELAPSED = /^\s*(\S+)\s+(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s*$/u;

interface Holder {
  /** Exited, unreaped. */
  readonly zombie: boolean;
  readonly earliestStart: number;
}

function holderOf(pid: number): Effect.Effect<Holder | null, KinuError> {
  return Effect.gen(function* () {
    const asked = Date.now();
    const ps = yield* ran(['ps', '-o', 'stat=,etime=', '-p', String(pid)]);

    if (ps.exitCode === NONE_LEFT && ps.stdout.trim() === '') return null;

    if (ps.exitCode !== 0) return yield* Effect.fail(new KinuError('io', `ps -p ${String(pid)} failed (${String(ps.exitCode)}): ${ps.stderr}`));
    const [, state, days = '0', hours = '0', minutes, seconds] = STATE_AND_ELAPSED.exec(ps.stdout) ?? [];

    if (state === undefined || minutes === undefined || seconds === undefined) {
      return yield* Effect.fail(new KinuError('io', `ps gave pid ${String(pid)} no state and elapsed time: ${ps.stdout}`));
    }

    const elapsed = ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);

    return { zombie: state.startsWith('Z'), earliestStart: asked - (elapsed + CLOCK_SLACK_S) * 1000 };
  });
}

function runs(recorded: Recorded, holder: Holder | null): boolean {
  return holder !== null && !holder.zombie && holder.earliestStart <= recorded.writtenAt;
}

export async function killAndAwaitExit(recorded: Recorded, options: { readonly group?: boolean } = {}): Promise<void> {
  return settle(Effect.gen(function* () {
    const holder = yield* holderOf(recorded.pid);
    const heldByStranger = holder !== null && holder.earliestStart > recorded.writtenAt;

    if (heldByStranger) return;

    if (options.group !== true) {
      tolerate(() => process.kill(recorded.pid, 'SIGKILL'), 'esrch');

      return yield* waitForExit(recorded.pid);
    }

    // A group outlives its leader; its id is held while any member runs.
    tolerate(() => process.kill(-recorded.pid, 'SIGKILL'), 'esrch');
    const members = yield* ran(['pgrep', '-g', String(recorded.pid)]);

    if (members.exitCode !== 0 && members.exitCode !== NONE_LEFT) {
      return yield* Effect.fail(new KinuError('io', `pgrep -g ${String(recorded.pid)} failed (${String(members.exitCode)}): ${members.stderr}`));
    }

    for (const member of members.stdout.split('\n').filter((line) => line !== '')) yield* waitForExit(Number(member));

    if (runs(recorded, yield* holderOf(recorded.pid))) {
      return yield* Effect.fail(new KinuError('io', `pid ${String(recorded.pid)} leads no process group`));
    }
  }));
}
