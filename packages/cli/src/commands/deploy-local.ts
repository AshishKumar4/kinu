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
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import {
  LOCAL_PORT, LocalConfigSchema, fetchReleaseArtifact, fetchReleaseManifest, localLayout, releaseDir,
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

/** How long the socket is given to accept before the address is reported as
 *  unproven. The instance keeps starting either way; this only decides whether
 *  the printed address is a measurement or a claim. */
const READY_MS = 10_000;

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
  const origin = opts.origin?.trim() || 'https://kinu.run';
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

  for (const file of manifest.files) {
    const target = join(dir, file.path);

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, await artifact.read(file.path));
  }

  // Replaced rather than updated in place: a symlink swap is the whole of an
  // update, and `rmSync` is what makes a second install of the same tree
  // idempotent.
  rmSync(layout.current, { force: true, recursive: false });
  symlinkSync(dir, layout.current, 'dir');

  writeFileSync(layout.capnp, renderWorkerdConfig({ manifest, version: manifest.version, port }));
  writeFileSync(layout.config, renderLocalConfig({ version: manifest.version, port, at: new Date() }));

  const without = unhostedBindings(manifest);

  console.log(`${OK('✓')} Kinu ${ACCENT(manifest.version)} laid down in ${DIM(layout.root)}`);

  if (without.length > 0) {
    console.log(`${DIM('Not available locally:')} ${DIM(without.join(', '))}`);
  }
}

/**
 * Start the instance, or answer null when one is already running.
 *
 * The address is returned only after the socket accepts a connection: "it is
 * serving" is the one thing a person needs from this command, and a printed
 * address that nothing answers on is worse than an error.
 */
async function startLocalInstance(): Promise<LocalInstance | null> {
  const layout = layoutOf();
  const config = localConfig();

  if (readLivePid(layout) !== null) return null;

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
    writeFileSync(layout.pid, `${String(child.pid)}\n`);

    if (!await accepts(config.port, READY_MS)) {
      throw new Error(`Local Kinu did not answer on ${config.address}. See ${layout.log}`);
    }

    return { pid: child.pid, address: config.address };
  } finally {
    closeSync(log);
  }
}

/** The pid that was stopped, or null when nothing was running. */
async function stopLocalInstance(): Promise<number | null> {
  const layout = layoutOf();
  const pid = readLivePid(layout);

  if (pid === null) return null;

  // A pid that vanished between the liveness probe and the signal is the one
  // tolerable outcome; EPERM means it is alive and not ours, and claiming we
  // stopped it would be a lie.
  tolerate(() => process.kill(pid, 'SIGTERM'), 'esrch');

  if (!await reaped(pid, STOP_GRACE_MS)) {
    tolerate(() => process.kill(pid, 'SIGKILL'), 'esrch');

    if (!await reaped(pid, STOP_FORCE_MS)) throw new Error(`Local Kinu (pid ${String(pid)}) did not exit.`);
  }

  tolerate(() => unlinkSync(layout.pid), 'enoent');

  return pid;
}

function report(): void {
  const layout = layoutOf();

  if (!existsSync(layout.config)) {
    console.log(`${WARN('!')} No local Kinu here yet: ${ACCENT('kinu deploy local')}`);

    return;
  }

  const config = localConfig();
  const pid = readLivePid(layout);

  console.log(pid === null
    ? `${DIM('Local Kinu')} ${ACCENT(config.version)} ${DIM('is installed and not running')} ${DIM(layout.root)}`
    : `${OK('✓')} Local Kinu ${ACCENT(config.version)} on ${ACCENT(config.address)} ${DIM(`pid ${String(pid)}`)}`);
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

/** The running instance's pid, clearing a pidfile whose process is gone. */
function readLivePid(layout: LocalLayout): number | null {
  const text = tolerate(() => readFileSync(layout.pid, 'utf8'), 'enoent');

  if (text === undefined) return null;
  const pid = Number.parseInt(text.trim(), 10);

  if (!Number.isInteger(pid) || pid <= 0) {
    tolerate(() => unlinkSync(layout.pid), 'enoent');

    return null;
  }

  // `kill(pid, 0)` throws EPERM for a process that is alive and not ours, so
  // only ESRCH may be read as absent.
  if (tolerate(() => process.kill(pid, 0), 'esrch') === undefined) {
    tolerate(() => unlinkSync(layout.pid), 'enoent');

    return null;
  }

  return pid;
}

async function reaped(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (tolerate(() => process.kill(pid, 0), 'esrch') === undefined) return true;

    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
}

/** Whether the instance's socket accepts a connection. A connect is the only
 *  readiness signal that does not depend on a route existing. */
async function accepts(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await connects(port)) return true;

    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
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
