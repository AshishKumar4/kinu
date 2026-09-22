/**
 * `kinu deploy local` — the same release, under `~/.kinu/local`, served by
 * workerd (docs/SELF-DEPLOY.md § The local door).
 *
 * WHAT THIS OWNS AND WHAT IT DOES NOT. The layout, the rendered workerd
 * configuration and the release comparison are core's
 * (`packages/core/src/deploy/local.ts` and `channel.ts`), shared with the
 * Cloudflare door; this file is the adapter: the filesystem, the child process
 * and what a person sees. Nothing here re-renders a config or re-reads a
 * channel.
 *
 * THE SUPERVISOR IS A PIDFILE AND A CHILD. workerd is a foreign process: it
 * neither writes nor unlinks the pidfile, so unlike the scheduler daemon
 * (`daemon.ts`, whose pidfile is its own and whose restart path may return as
 * soon as the file is released) there is exactly one release condition here —
 * the process is reaped. The instance is started detached with its output
 * appended to one log, so closing the terminal does not take the instance with
 * it.
 *
 * A PID IS NOT AN IDENTITY. `workerd.pid` outlives a reboot and a pid is
 * reused, so a number in that file is a hint and never a licence to signal:
 * every read of it confirms the process's own argv names `workerd` and THIS
 * layout's capnp file before the pid is treated as the instance, and `stop`
 * refuses a pid that fails that test instead of killing whatever inherited the
 * number. Nor is an open port an instance: another process holding the port
 * kills workerd on EADDRINUSE while a connect still succeeds, so starting is
 * proved by the child still living and by `/api/health` answering, not by the
 * socket accepting.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { connect } from 'node:net';
import { get } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import {
  HealthAnswerSchema, LOCAL_PORT, LocalConfigSchema, fetchReleaseArtifact, fetchReleaseManifest, localLayout, releaseDir,
  renderLocalConfig, renderWorkerdConfig, unhostedBindings, workerdDirectories,
  type LocalConfig, type LocalLayout,
} from '@kinu.run/core/deploy';
import { tolerate } from '@kinu.run/core/obs';
import * as v from 'valibot';
import { AGENT_HOME, ensureAgentHome } from '../config';
import { ACCENT, DIM, OK, WARN } from '../display';

/** SIGTERM grace before escalating. A workerd instance mid-request needs a
 *  moment; a Durable Object's SQLite is committed per write, so nothing is
 *  lost either way. */
const STOP_GRACE_MS = 5_000;

const STOP_FORCE_MS = 2_000;

/** How long the instance is given to answer `/api/health` before the address
 *  is reported as unproven. The instance keeps starting either way; this only
 *  decides whether the printed address is a measurement or a claim. */
const READY_MS = 10_000;

/** How long one health probe may take. Short because it is retried until
 *  `READY_MS`, and a listener that accepts and then says nothing is exactly
 *  the case this is here to survive. */
const HEALTH_MS = 2_000;


/** What `workerd.pid` names. `none` after a pidfile that named nothing alive
 *  has been cleared, `foreign` for a live process that is not this instance's
 *  workerd, `ours` for the one process this command may signal. */
type PidFile =
  | { readonly kind: 'none' }
  | { readonly kind: 'foreign'; readonly pid: number }
  | { readonly kind: 'ours'; readonly pid: number; readonly startedAt: string | null };

/** Whether the instance is serving, and when it is not, what happened
 *  instead. */
type Readiness = 'serving' | 'exited' | 'foreign' | 'silent';

interface LocalInstance {
  readonly pid: number;
  readonly address: string;
}

export async function localDoor(action: string | undefined, opts: { origin?: string; port?: string }): Promise<void> {
  if (action === 'stop') {
    const stopped = await stopLocalInstance();

    console.log(stopped === null
      ? DIM('No local Kinu is running')
      : `${OK('✓')} Local Kinu stopped ${DIM(`pid ${String(stopped)}`)}`);

    return;
  }

  if (action === 'status') {
    report();

    return;
  }

  if (action !== undefined && action !== 'start') {
    throw new Error('Usage: kinu deploy local [start|stop|status]');
  }

  if (action === undefined) await install(opts);

  const started = await startLocalInstance();

  console.log(started === null
    ? `${DIM('A local Kinu is already running')} ${DIM(localConfig().address)}`
    : `${OK('✓')} Local Kinu on ${ACCENT(started.address)} ${DIM(`pid ${String(started.pid)}`)}`);
}

/**
 * Lay the release down and render the instance's configuration.
 *
 * A release directory is written once and then only read: an update is a new
 * directory and a `current` swap, so a running instance never reads a file
 * that is being rewritten underneath it.
 */
async function install(opts: { origin?: string; port?: string }): Promise<void> {
  const trimmedOrigin = opts.origin?.trim();
  const origin = trimmedOrigin === undefined || trimmedOrigin === '' ? 'https://kinu.run' : trimmedOrigin;
  const port = readPort(opts.port);
  const layout = layoutOf();

  ensureAgentHome();
  console.log('');
  console.log(`${DIM('Reading')} ${ACCENT(origin)}`);

  const manifest = await fetchReleaseManifest(origin);
  const artifact = await fetchReleaseArtifact(manifest, origin);
  const dir = releaseDir(layout, manifest.version);

  // Every directory the rendered config names, because workerd refuses to
  // start on a disk service whose directory is absent.
  for (const path of [layout.releases, layout.state, layout.bin, dir]) mkdirSync(path, { recursive: true });

  for (const relative of workerdDirectories(manifest)) {
    mkdirSync(join(layout.root, relative), { recursive: true });
  }

  // One walk, a member at a time, through the same reader the Cloudflare door
  // uses: that door installs from inside a Durable Object and cannot hold the
  // unpacked archive (docs/SELF-DEPLOY.md § What the artifact weighs). Here it
  // means a release lands on disk without ever being in memory whole.
  const wanted = new Set(manifest.files.map((file) => file.path));
  const laid = new Set<string>();

  for await (const member of artifact.members()) {
    if (!wanted.has(member.path)) continue;

    const target = join(dir, member.path);

    mkdirSync(dirname(target), { recursive: true });

    const handle = openSync(target, 'w');

    try {
      for await (const piece of member.chunks()) writeSync(handle, piece);
    } finally {
      closeSync(handle);
    }

    laid.add(member.path);
  }

  const absent = [...wanted].filter((path) => !laid.has(path));

  if (absent.length > 0) {
    throw new Error(`the release artifact carries no ${absent[0] ?? ''}`
      + (absent.length > 1 ? ` (and ${String(absent.length - 1)} more the manifest names)` : ''));
  }

  // Replaced rather than updated in place: a symlink swap is the whole of an
  // update, and `rmSync` is what makes a second install of the same tree
  // idempotent.
  rmSync(layout.current, { force: true, recursive: false });
  symlinkSync(dir, layout.current, 'dir');

  writeFileSync(layout.capnp, renderWorkerdConfig({ manifest, version: manifest.version, port }));
  writeFileSync(layout.config, renderLocalConfig({ version: manifest.version, port, at: new Date() }));

  const without = unhostedBindings(manifest);

  console.log(`${OK('✓')} Kinu ${ACCENT(manifest.version)} installed in ${DIM(layout.root)}`);

  if (without.length > 0) {
    console.log(`${DIM('Not available locally:')} ${DIM(without.join(', '))}`);
  }
}

/**
 * Start the instance, or answer null when one is already running.
 *
 * The address is returned only once the child is still alive AND `/api/health`
 * has answered on the port: "it is serving" is the one thing a person needs
 * from this command, and a printed address that belongs to another process is
 * worse than an error.
 */
async function startLocalInstance(): Promise<LocalInstance | null> {
  const layout = layoutOf();
  const config = localConfig();

  if (readPidFile(layout).kind === 'ours') return null;

  const binary = existsSync(layout.workerd) ? layout.workerd : 'workerd';
  const log = openSync(layout.log, 'a');

  try {
    const child = spawn(binary, ['serve', layout.capnp], {
      cwd: layout.root,
      detached: true,
      stdio: ['ignore', log, log],
      env: process.env,
    });

    child.unref();

    if (child.pid === undefined) throw new Error(`Could not start ${binary}. See ${layout.log}`);
    writeFileSync(layout.pid, renderPidFile(child.pid, new Date()));

    // The child's own exit, watched rather than polled: workerd that cannot
    // bind the port is gone in milliseconds, and waiting `READY_MS` for a
    // process that is already dead reports the wrong thing slowly.
    let ended: string | null = null;

    child.once('exit', (code, signal) => {
      ended = signal ?? `status ${String(code ?? 0)}`;
    });

    const answer = await ready(config.port, () => ended);

    if (answer !== 'serving') throw await unserved(answer, layout, config, () => ended);

    return { pid: child.pid, address: config.address };
  } finally {
    closeSync(log);
  }
}

/** Why the address cannot be printed, as the error the command fails with. A
 *  dead child's pidfile is cleared here: it names a process nobody may
 *  signal. */
async function unserved(
  answer: Exclude<Readiness, 'serving'>,
  layout: LocalLayout,
  config: LocalConfig,
  ended: () => string | null,
): Promise<Error> {
  if (answer === 'exited') {
    clearPidFile(layout);
    const taken = await connects(config.port);

    return new Error(taken
      ? `Local Kinu exited while starting (${ended() ?? 'reason unknown'}) and ${config.address} `
        + `is answered by another process. Free that port, or pick one with --port. See ${layout.log}`
      : `Local Kinu exited while starting (${ended() ?? 'reason unknown'}). See ${layout.log}`);
  }

  if (answer === 'foreign') {
    return new Error(`${config.address} is answered by something that is not Kinu. `
      + `Stop it, or pick another port with --port. See ${layout.log}`);
  }

  return new Error(`Local Kinu did not answer on ${config.address}. `
    + `It may still be starting: \`kinu deploy local status\`, or stop it with \`kinu deploy local stop\`. `
    + `See ${layout.log}`);
}

/** The pid that was stopped, or null when nothing was running. A pidfile that
 *  names a process this command does not own is a refusal, not a kill. */
async function stopLocalInstance(): Promise<number | null> {
  const layout = layoutOf();
  const state = readPidFile(layout);

  if (state.kind === 'none') return null;

  if (state.kind === 'foreign') {
    throw new Error(`Not stopping pid ${String(state.pid)}: it is alive and it is not this Kinu's workerd. `
      + `The stale ${layout.pid} is cleared.`);
  }

  const { pid } = state;

  // A pid that vanished between the identity check and the signal is the one
  // tolerable outcome; EPERM means it is alive and not ours, and claiming we
  // stopped it would be a lie.
  tolerate(() => process.kill(pid, 'SIGTERM'), 'esrch');

  if (!await reaped(pid, STOP_GRACE_MS)) {
    tolerate(() => process.kill(pid, 'SIGKILL'), 'esrch');

    if (!await reaped(pid, STOP_FORCE_MS)) throw new Error(`Local Kinu (pid ${String(pid)}) did not exit.`);
  }

  clearPidFile(layout);

  return pid;
}

function report(): void {
  const layout = layoutOf();

  if (!existsSync(layout.config)) {
    console.log(`${WARN('!')} No local Kinu here yet: ${ACCENT('kinu deploy local')}`);

    return;
  }

  const config = localConfig();
  const state = readPidFile(layout);

  if (state.kind !== 'ours') {
    console.log(`${DIM('Local Kinu')} ${ACCENT(config.version)} ${DIM('is installed and not running')} ${DIM(layout.root)}`);

    return;
  }

  const since = state.startedAt === null ? '' : ` ${DIM(`since ${state.startedAt}`)}`;

  console.log(`${OK('✓')} Local Kinu ${ACCENT(config.version)} on ${ACCENT(config.address)} `
    + `${DIM(`pid ${String(state.pid)}`)}${since}`);
}

function layoutOf(): LocalLayout {
  return localLayout(AGENT_HOME);
}

/** What the last install settled. A missing config is not a failure to read:
 *  it is a machine where the door has not been opened yet. */
function localConfig(): LocalConfig {
  const layout = layoutOf();

  if (!existsSync(layout.config)) {
    throw new Error(`No local Kinu is installed. Run \`kinu deploy local\` first (${layout.root}).`);
  }

  return v.parse(LocalConfigSchema, JSON.parse(readFileSync(layout.config, 'utf8')));
}

function readPort(given: string | undefined): number {
  if (given === undefined) return LOCAL_PORT;
  const port = Number.parseInt(given, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${given} is not a port.`);

  // Port 3000 is reserved for this repository's own dev server (AGENTS.md), and
  // a local instance that took it would collide with it on this machine.
  if (port === 3000) throw new Error('Port 3000 is reserved. Pick another port.');

  return port;
}

/** The pid on the first line, the time this command started that process on
 *  the second. Two lines rather than one field because the start time is for a
 *  person reading `status`, and a pidfile an older install left behind carries
 *  only the pid. */
function renderPidFile(pid: number, at: Date): string {
  return `${String(pid)}\n${at.toISOString()}\n`;
}

/**
 * What `workerd.pid` names now, clearing the file unless it names this
 * instance's own live workerd.
 *
 * The identity test is the process's argv: it must name `workerd` and this
 * layout's capnp path. Without it a reused pid makes `stop` signal a
 * stranger's process and `start` report an instance that is not there.
 */
function readPidFile(layout: LocalLayout): PidFile {
  const text = tolerate(() => readFileSync(layout.pid, 'utf8'), 'enoent');

  if (text === undefined) return { kind: 'none' };
  const lines = text.split('\n');
  const pid = Number.parseInt((lines[0] ?? '').trim(), 10);

  if (!Number.isInteger(pid) || pid <= 0) return cleared(layout, { kind: 'none' });

  // Absent argv is an absent process: `/proc/<pid>` is gone the moment it is
  // reaped, and `ps -p` refuses a pid nothing holds.
  const args = processArgs(pid);

  if (args === null) return cleared(layout, { kind: 'none' });

  if (!(args.includes('workerd') && args.includes(layout.capnp))) return cleared(layout, { kind: 'foreign', pid });
  const startedAt = (lines[1] ?? '').trim();

  return { kind: 'ours', pid, startedAt: startedAt === '' ? null : startedAt };
}

function cleared<Answer extends PidFile>(layout: LocalLayout, answer: Answer): Answer {
  clearPidFile(layout);

  return answer;
}

function clearPidFile(layout: LocalLayout): void {
  tolerate(() => unlinkSync(layout.pid), 'enoent');
}

/** A process's own argv, or null when nothing holds the pid. `/proc` on Linux
 *  because it costs one read; `ps` everywhere else. */
function processArgs(pid: number): string | null {
  if (process.platform === 'linux') {
    const cmdline = tolerate(() => readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8'), 'enoent');

    return cmdline === undefined ? null : cmdline.replaceAll('\0', ' ');
  }

  const listed = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });

  return listed.status === 0 ? listed.stdout : null;
}

async function reaped(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (tolerate(() => process.kill(pid, 0), 'esrch') === undefined) return true;

    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
}

/**
 * Whether the instance came up, and when it did not, what is on the port.
 *
 * A connect proves only that the port is open, and the process that opened it
 * may be the reason workerd died, so the question asked here is `/api/health`
 * — the one route every Kinu build serves — and the child's exit ends the wait
 * early.
 */
async function ready(port: number, ended: () => string | null): Promise<Readiness> {
  const deadline = Date.now() + READY_MS;

  for (;;) {
    if (ended() !== null) return 'exited';

    if (await servesKinu(port)) return 'serving';

    if (Date.now() >= deadline) return await connects(port) ? 'foreign' : 'silent';
    await sleep(100);
  }
}

/** Whether `/api/health` on this port answers as a Kinu. */
async function servesKinu(port: number): Promise<boolean> {
  const answered = await healthBody(port);

  if (answered === null) return false;
  const body: unknown = tolerate(() => JSON.parse(answered), 'malformed-input');

  // The question is whether a Kinu is on the port, not which one: a stamped
  // build or a stated absence of one are both Kinu's own answer.
  return v.safeParse(HealthAnswerSchema, body).success;
}

/** `/api/health`'s body, or null when the port did not answer it with a 200.
 *  A refused or reset connection is the ordinary case while an instance is
 *  starting, which is why it is a value here and not a failure — the same
 *  reading `connects` takes of a socket error. */
function healthBody(port: number): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();

  const request = get({ host: '127.0.0.1', port, path: '/api/health', timeout: HEALTH_MS }, (response) => {
    const chunks: Buffer[] = [];

    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => resolve(response.statusCode === 200 ? Buffer.concat(chunks).toString('utf8') : null));
  });

  request.once('error', () => resolve(null));
  request.once('timeout', () => {
    request.destroy();
    resolve(null);
  });

  return promise;
}

function connects(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = connect({ host: '127.0.0.1', port });

  socket.once('connect', () => {
    socket.destroy();
    resolve(true);
  });
  socket.once('error', () => {
    socket.destroy();
    resolve(false);
  });

  return promise;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();

  setTimeout(resolve, ms);

  return promise;
}
