/**
 * `kinu deploy local`: the release under `~/.kinu/local`, served by workerd (docs/SELF-DEPLOY.md § The local door).
 * Layout and config rendering are core's; this is the filesystem/process adapter. workerd never touches its pidfile,
 * so a pid is only a hint: its argv must name `workerd` and this layout's capnp file before it is signalled, and
 * startup is proved by `/api/health`, not by the port accepting.
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

/** A Durable Object's SQLite commits per write, so nothing is lost either way. */
const STOP_GRACE_MS = 5_000;

const STOP_FORCE_MS = 2_000;

/** Only decides whether the printed address is a measurement or a claim; the instance keeps starting. */
const READY_MS = 10_000;

/** Short and retried: a listener that accepts and then says nothing is the case to survive. */
const HEALTH_MS = 2_000;

type PidFile =
  | { readonly kind: 'none' }
  | { readonly kind: 'foreign'; readonly pid: number }
  | { readonly kind: 'ours'; readonly pid: number; readonly startedAt: string | null };

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

/** A release directory is written once; an update is a new directory plus a `current` swap. */
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

  // workerd refuses to start when a disk service's directory is absent.
  for (const path of [layout.releases, layout.state, layout.bin, dir]) mkdirSync(path, { recursive: true });

  for (const relative of workerdDirectories(manifest)) {
    mkdirSync(join(layout.root, relative), { recursive: true });
  }

  // Member by member, through the Cloudflare door's reader, so a release never sits in memory whole
  // (docs/SELF-DEPLOY.md § What the artifact weighs).
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

  // `rmSync` makes a repeat install of the same tree idempotent.
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

/** The address is returned only once the child lives and `/api/health` answered: another process's address
 * printed as ours is worse than an error. */
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

    // Watched, not polled: workerd that cannot bind the port exits at once.
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

/** A dead child's pidfile is cleared here: it names a process nobody may signal. */
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

/** A pidfile naming a process this command does not own is a refusal, not a kill. */
async function stopLocalInstance(): Promise<number | null> {
  const layout = layoutOf();
  const state = readPidFile(layout);

  if (state.kind === 'none') return null;

  if (state.kind === 'foreign') {
    throw new Error(`Not stopping pid ${String(state.pid)}: it is alive and it is not this Kinu's workerd. `
      + `The stale ${layout.pid} is cleared.`);
  }

  const { pid } = state;

  // ESRCH is the one tolerable outcome; EPERM means alive and not ours.
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

/** A missing config means the door has not been opened yet, not a read failure. */
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

  // Port 3000 is reserved for this repository's own dev server (AGENTS.md).
  if (port === 3000) throw new Error('Port 3000 is reserved. Pick another port.');

  return port;
}

/** Older installs left pid-only files, so the start time is a separate second line. */
function renderPidFile(pid: number, at: Date): string {
  return `${String(pid)}\n${at.toISOString()}\n`;
}

/** Clears the file unless argv names `workerd` and this layout's capnp path; a reused pid must never be signalled. */
function readPidFile(layout: LocalLayout): PidFile {
  const text = tolerate(() => readFileSync(layout.pid, 'utf8'), 'enoent');

  if (text === undefined) return { kind: 'none' };
  const lines = text.split('\n');
  const pid = Number.parseInt((lines[0] ?? '').trim(), 10);

  if (!Number.isInteger(pid) || pid <= 0) return cleared(layout, { kind: 'none' });

  // `/proc/<pid>` vanishes on reap, and `ps -p` refuses a pid nothing holds.
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

/** `/proc` on Linux (one read); `ps` elsewhere. */
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

/** A connect proves only that the port is open; ask `/api/health`, and let the child's exit end the wait early. */
async function ready(port: number, ended: () => string | null): Promise<Readiness> {
  const deadline = Date.now() + READY_MS;

  for (;;) {
    if (ended() !== null) return 'exited';

    if (await servesKinu(port)) return 'serving';

    if (Date.now() >= deadline) return await connects(port) ? 'foreign' : 'silent';
    await sleep(100);
  }
}

async function servesKinu(port: number): Promise<boolean> {
  const answered = await healthBody(port);

  if (answered === null) return false;
  const body: unknown = tolerate(() => JSON.parse(answered), 'malformed-input');

  // Any Kinu answer counts, stamped build or not.
  return v.safeParse(HealthAnswerSchema, body).success;
}

/** A refused or reset connection is ordinary while starting, so it is a value, not a failure. */
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
