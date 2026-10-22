import { attempt, KinuError, settle, settleSync, tolerate } from '@kinu.run/core/obs';
import { hostGenerationReader } from '../../cli-backend/src/process-generation';
import { Effect } from 'effect';
import { readFileSync } from 'node:fs';
import { reportingEnv } from './ambient-env';

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
  // A child `bun test` reports every test whoever runs this one (`AGENT_MODE_ENV`).
  if ('cmd' in command) return Bun.spawn({ ...command, env: reportingEnv(command.env ?? process.env) });

  return Bun.spawn([...command], { ...options, env: reportingEnv(options?.env ?? process.env) });
}

/** Runs `cmd` to its exit and hands back what it said. */
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

function ranOk(cmd: readonly string[], options?: RunOptions): Effect.Effect<string, KinuError> {
  return Effect.gen(function* () {
    const exited = yield* ran(cmd, options);

    if (exited.exitCode !== 0) {
      return yield* Effect.fail(new KinuError('io', `${cmd.join(' ')} exited ${String(exited.exitCode ?? exited.signalCode)}: ${exited.stderr}`));
    }

    return exited.stdout;
  });
}

/** `execFileSync`'s shape without the synchronous wait: stdout, or a failure naming the exit and stderr. */
export async function runOk(cmd: readonly string[], options?: RunOptions): Promise<string> {
  return settle(ranOk(cmd, options));
}

/** The exit of `pidwait`, `pwait`, `ps -p` and `pgrep`. */
const NONE_LEFT = 1;

/** As a group, 0 is ours and 1 is everyone. */
const FIRST_OWN_PID = 2;

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

/**
 * A process a fixture started, by its pid and the run of that pid it was when recorded (cli-backend's process-generation.ts): a
 * pid an unrelated process holds now reads as another generation, and is never killed.
 */
export interface Recorded {
  readonly pid: number;
  readonly generation: string;
}

const GENERATIONS = hostGenerationReader();

/** The run `pid` names now; null when no process holds it. */
function generationOf(pid: number): Effect.Effect<string | null, KinuError> {
  if (GENERATIONS === null) return Effect.fail(new KinuError('io', `this host (${process.platform}) reads no process generation`));
  const probe = GENERATIONS.read(pid);

  if (probe.state === 'unreadable') return Effect.fail(new KinuError('io', `pid ${String(pid)}'s generation could not be read`));

  return Effect.succeed(probe.state === 'read' ? probe.identity : null);
}

/** Whether the process holding `pid` names `fixture` in its command line or environment, as a fixture's own process
 *  names its home or root. */
function namesFixture(pid: number, fixture: string): boolean {
  if (process.platform === 'darwin') {
    const ps = Bun.spawnSync({ cmd: ['/bin/ps', '-E', '-ww', '-o', 'command=', '-p', String(pid)], env: { LC_ALL: 'C', LANG: 'C' }, stdout: 'pipe', stderr: 'ignore' });

    return ps.stdout.toString().includes(fixture);
  }

  // A process gone since the probe answers ESRCH or ENOENT; one not ours, EACCES: none is the fixture's.
  const read = (name: string): string => tolerate(() => tolerate(() => tolerate(() => readFileSync(`/proc/${String(pid)}/${name}`, 'utf8'), 'esrch'), 'enoent'), 'eacces') ?? '';

  return read('cmdline').includes(fixture) || read('environ').includes(fixture);
}

/**
 * The process `file` records, when the process holding that pid names `fixture`, the home or root its run was given;
 * null when none does. A pidfile outlives its writer and its pid may be a stranger's by now, so a pid is judged by who
 * holds it, never by when: the generation is read before and after the check, so both are about one run.
 */
export function recordedIn(file: string, fixture: string, pattern = /^\s*(\d+)/u): Recorded | null {
  return settleSync(Effect.gen(function* () {
    const text = tolerate(() => readFileSync(file, 'utf8'), 'enoent');

    if (text === undefined) return null;
    const pid = Number(pattern.exec(text)?.[1]);

    if (!Number.isSafeInteger(pid) || pid < FIRST_OWN_PID) return yield* Effect.fail(new KinuError('io', `${file} records no pid: ${JSON.stringify(text)}`));
    const generation = yield* generationOf(pid);

    if (generation === null || !namesFixture(pid, fixture) || (yield* generationOf(pid)) !== generation) return null;

    return { pid, generation };
  }));
}

/** Every process naming `fixture` in its command line now, as recorded: one no pidfile names yet included, such as the
 *  successor a handover had started when a test's timeout cut it short. */
export async function namingFixture(fixture: string): Promise<readonly Recorded[]> {
  return settle(Effect.gen(function* () {
    const found = yield* ran(['pgrep', '-f', '--', fixture.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)]);

    if (found.exitCode !== 0 && found.exitCode !== NONE_LEFT) {
      return yield* Effect.fail(new KinuError('io', `pgrep -f ${fixture} failed (${String(found.exitCode)}): ${found.stderr}`));
    }

    const named: Recorded[] = [];

    for (const pid of found.stdout.split('\n').filter((line) => line !== '').map(Number)) {
      const generation = yield* generationOf(pid);

      if (generation !== null && pid !== process.pid && namesFixture(pid, fixture)) named.push({ pid, generation });
    }

    return named;
  }));
}

export async function killAndAwaitExit(recorded: Recorded, options: { readonly group?: boolean } = {}): Promise<void> {
  return settle(Effect.gen(function* () {
    // Ended, or another process holds the pid now.
    if ((yield* generationOf(recorded.pid)) !== recorded.generation) return;

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

    if ((yield* generationOf(recorded.pid)) === recorded.generation && isRunning(recorded.pid)) {
      return yield* Effect.fail(new KinuError('io', `pid ${String(recorded.pid)} leads no process group`));
    }
  }));
}
