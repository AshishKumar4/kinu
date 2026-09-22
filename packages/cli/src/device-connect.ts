/**
 * The one device-connect implementation behind every "link this PC" surface. The daemon ships inside the release, so connect
 * fetches no code. One daemon owns a machine via `~/.kinu/pc-agent.pid`, which the daemon also claims itself.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { classify, classifyErrorCode, diagnostics, KinuError, renderThrownChain, tolerate, toKinuError } from '@kinu.run/core/obs';
import { describeGpuNodes, effectiveDeviceMode, sandboxReasonFix } from '@kinu.run/core';
import { enforceOwnerOnly, ensureSecretDir } from '@kinu.run/cli-backend';
import { AGENT_HOME, ensureAgentHome, loadConfigFile, requireAuthConfig, resolveCloudSession, updateConfigFile } from './config';
import { listCloudDevices, registerCloudDevice, type CloudDevice, type CloudDeviceSandbox } from './cloud-api';
import { readDaemonLogTail, rotateDaemonLogIfNeeded } from './daemon-log';
import { waitForAnswer, type StoppableWaitOptions } from '@kinu.run/core';
import PC_AGENT_DAEMON_SOURCE from '../../pc-agent/src/index.js' with { type: 'text' };
import PC_AGENT_SANDBOX_SOURCE from '../../pc-agent/src/sandbox.js' with { type: 'text' };
import PC_AGENT_PTY_SOURCE from '../../pc-agent/src/pty.js' with { type: 'text' };
import PC_AGENT_UPDATE_SOURCE from '../../pc-agent/src/update.js' with { type: 'text' };
import { VERSION } from './display';

const PID_PATH = join(AGENT_HOME, 'pc-agent.pid');

const SCRIPT_PATH = join(AGENT_HOME, 'pc-agent.js');

/** The installed daemon's build; reported in HELLO so the hub can push updates. The daemon's updater rewrites it. */
const VERSION_STAMP_PATH = join(AGENT_HOME, 'pc-agent.version');

/** Written by the daemon while its successor starts; with a stale pidfile, the successor died and `.prev` last ran. */
const UPDATE_PENDING_PATH = join(AGENT_HOME, 'pc-agent.update-pending');

/** Every sibling the daemon `require`s; install refuses a daemon whose require lines this table does not cover. */
const DAEMON_SIBLINGS: readonly { readonly name: string; readonly source: string }[] = [
  { name: 'sandbox.js', source: PC_AGENT_SANDBOX_SOURCE },
  { name: 'pty.js', source: PC_AGENT_PTY_SOURCE },
  { name: 'update.js', source: PC_AGENT_UPDATE_SOURCE },
];

function daemonSiblingNames(daemonSource: string): readonly string[] {
  return [...daemonSource.matchAll(/require\('\.\/([^']+)'\)/g)].map((m) => m[1] ?? '').filter((n) => n !== '');
}

export const DAEMON_LOG_PATH = join(AGENT_HOME, 'pc-agent.log');

export const DEVICE_CONFIG_PATH = join(AGENT_HOME, 'device.json');

/** The daemon reports this root in HELLO and the hub composes `<root>/<workspace>/home`; the daemon owns everything under it. */
const AGENT_ROOT = join(AGENT_HOME, 'agents');

const CONNECT_POLL_MS = 1_000;

export function defaultDeviceName(): string {
  return hostname().trim();
}

/** Owner-only, with a verified chmod so an existing group-readable root is tightened. */
function ensureAgentRoot(): void {
  ensureSecretDir(AGENT_ROOT);
}

/** Lives in `@kinu.run/core` because the web connect panel renders the same lines. */
export { DEVICE_CONNECT_DISCLOSURE } from '@kinu.run/core';

export interface DeviceAuth {
  origin: string;
  token: string;
}

export interface ConnectDeviceOptions {
  label?: string;
  session?: boolean;
  onWaiting?: () => void;
  /** The daemon keeps running and trying to connect. */
  signal?: AbortSignal;
}

export interface ConnectOutcomeDescription {
  ok: boolean;
  message: string;
}

export type ConnectDeviceResult =
  | { kind: 'connected'; deviceId: string; label: string; sandbox: CloudDeviceSandbox }
  | { kind: 'cancelled'; deviceId: string }
  | { kind: 'already-running'; connected: boolean };

export async function connectDevice(auth: DeviceAuth, opts: ConnectDeviceOptions = {}): Promise<ConnectDeviceResult> {
  if (opts.session && runningDaemonPid() !== null) {
    // The running daemon owns device.json and its credentials.
    const devices = await listDevicesForConnect(auth, 'checking whether the installed daemon is connected');

    return { kind: 'already-running', connected: devices.some((device) => device.connected) };
  }

  assertDaemonPlatformSupported();
  const runtime = daemonRuntime();
  const device = await registerDeviceForConnect(auth, opts.label);
  installDaemonFiles(device);
  const launch = startInstalledDaemon(opts.session === true, runtime);
  // The daemon must show as connected on the server before success is claimed.
  const connected = await waitForDeviceConnected(auth, device.deviceId, launch, opts);

  if (connected === undefined) return { kind: 'cancelled', deviceId: device.deviceId };
  thisDeviceConnected = true;

  // The hub is the authority on the machine's name, not the name typed at the prompt.
  return { kind: 'connected', deviceId: device.deviceId, label: connected.label, sandbox: connected.sandbox };
}

export interface DaemonStatus {
  deviceConfigPresent: boolean;
  logPresent: boolean;
  daemonPid: number | null;
  sessionActive: boolean;
}

/** Read-only; a successor that dies before connecting is rolled back by the daemon (`pc-agent/src/update.js`). */
export function daemonStatus(): DaemonStatus {
  return {
    deviceConfigPresent: existsSync(DEVICE_CONFIG_PATH),
    logPresent: existsSync(DAEMON_LOG_PATH),
    daemonPid: runningDaemonPid(),
    sessionActive: sessionDaemon !== null && sessionDaemon.exitCode === null && !sessionDaemon.killed,
  };
}

let offerConsumed = false;

let thisDeviceConnected: boolean | null = null;

/** Compares hostnames: `device.json` holds no device id, so the hostname is the only local identity. */
function isThisMachine(device: CloudDevice): boolean {
  return device.hostname !== null && device.hostname.trim() === defaultDeviceName();
}

/**
 * Cloud auth present, not dismissed, and this machine (not the account) not connected; a true answer consumes the
 * per-invocation latch. Suppressing on any connected device hid the offer from everyone with another machine linked.
 */
export async function shouldOfferDeviceConnect(): Promise<boolean> {
  if (offerConsumed) return false;

  if (loadConfigFile().deviceConnectPromptDismissed) return false;
  const auth = resolveCloudSession();

  if (!auth) return false;

  if (thisDeviceConnected === null) {
    try {
      const devices = await listCloudDevices(auth.origin, auth.token);
      thisDeviceConnected = devices.some((device) => device.connected && isThisMachine(device));
    } catch (error) {
      // An unreachable cloud is not evidence of no device; a malformed origin is a local bug and must throw.
      if (classify({ cause: error }) === 'malformed-input') throw error;

      return false;
    }
  }

  if (thisDeviceConnected) return false;
  offerConsumed = true;

  return true;
}

export function dismissDeviceConnectPrompt(): void {
  updateConfigFile((config) => {
    config.deviceConnectPromptDismissed = true;
  });
}

export async function deviceStatusLine(): Promise<string> {
  try {
    const auth = requireAuthConfig();
    const devices = await listCloudDevices(auth.origin, auth.token);
    thisDeviceConnected = devices.some((device) => device.connected && isThisMachine(device));
    const connected = devices.filter((device) => device.connected);

    if (connected.length > 0) {
      const named = connected.map((device) => `${device.label} (${sandboxStateTag(device.sandbox)})`);

      return `Connected: ${named.join(', ')}`;
    }

    if (devices.length > 0) return `${devices.length} registered device${devices.length === 1 ? '' : 's'}, none connected.`;

    return 'No computer is connected to your account yet.';
  } catch (err) {
    return `Device status unavailable: ${renderThrownChain({ cause: err })}`;
  }
}

export function describeConnectOutcome(result: ConnectDeviceResult, session: boolean): ConnectOutcomeDescription {
  switch (result.kind) {
    case 'already-running':
      return result.connected
        ? { ok: true, message: 'This computer is already connected.' }
        : { ok: false, message: 'The daemon is installed here but not connected. Run: kinu connect' };
    case 'cancelled':
      return { ok: false, message: 'Stopped waiting for the daemon. It keeps trying to connect; check: kinu desktop logs' };
    case 'connected':
      return {
        ok: true,
        message: session
          ? 'Connected for this session. The daemon stops when you leave the CLI.'
          : 'Connected. This computer stays connected after you leave the CLI.',
      };
  }
}

/** The fix sentence comes from `@kinu.run/core`; the daemon's reason code (`no_bwrap`, `no_userns`) is deliberately not printed. */
export function describeDeviceSandbox(sandbox: CloudDeviceSandbox): string[] {
  switch (effectiveDeviceMode(sandbox)) {
    case 'sandboxed':
      return [
        'Sandbox on. The agent sees its home plus the folders you picked. Your other files stay invisible.'
        + ` GPU: ${describeGpuNodes(sandbox.gpu)}.`,
      ];
    case 'raw':
      return ['Sandbox is OFF for this device. Commands run as you, with full access.'];
    case 'files_only':
      return [
        'This machine cannot sandbox.',
        ...(sandbox.detail === null ? [] : [`The daemon said: ${sandbox.detail}`]),
        sandboxReasonFix(sandbox.reason),
        'Nothing runs here until you fix that, or turn Sandbox off for this device.',
      ];
  }
}

function sandboxStateTag(sandbox: CloudDeviceSandbox): string {
  switch (effectiveDeviceMode(sandbox)) {
    case 'sandboxed': return 'sandbox on';
    case 'raw': return 'sandbox OFF';
    case 'files_only': return 'cannot sandbox';
  }
}

let sessionDaemon: ChildProcess | null = null;

let sessionCleanupInstalled = false;

interface DaemonLaunch {
  child: ChildProcess;
  failure: KinuError | null;
}

async function listDevicesForConnect(auth: DeviceAuth, doing: string) {
  try {
    return await listCloudDevices(auth.origin, auth.token);
  } catch (cause) {
    const detail = redactSecrets(renderThrownChain({ cause }), [auth.token]);
    throw new KinuError(
      classifyErrorCode({ cause }) ?? 'unavailable',
      doing,
      { cause: new Error(detail) },
    );
  }
}

async function registerDeviceForConnect(auth: DeviceAuth, label: string | undefined) {
  try {
    return await registerCloudDevice(auth.origin, auth.token, label);
  } catch (cause) {
    const detail = redactSecrets(renderThrownChain({ cause }), [auth.token]);

    if (/\b(?:duplicate|already exists|already in use)\b/i.test(detail)) {
      throw new KinuError(
        'bad_input',
        'that device name is already registered; choose another name',
        { cause: new Error(detail) },
      );
    }

    throw new KinuError(
      classifyErrorCode({ cause }) ?? 'unavailable',
      'registering this device with Kinu',
      { cause: new Error(detail) },
    );
  }
}

function redactSecrets(text: string, secrets: string[]): string {
  let redacted = text;

  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join('[redacted]');
  }

  return redacted;
}

function installDaemonFiles(device: { origin: string; userId: string; token: string }): void {
  try {
    ensureAgentHome();
    ensureAgentRoot();
  } catch (cause) {
    throw toKinuError({
      doing: `preparing the device install directory ${AGENT_HOME}`,
      cause,
      otherwise: 'io',
    });
  }

  const config = `${JSON.stringify({
    user: device.userId,
    token: device.token,
    origin: device.origin.replace(/\/+$/, ''),
    // The directory `kinu connect` ran in is the consented root; the hub scopes base-tier file calls to it.
    root: process.cwd(),
  }, null, 2)}\n`;

  const scriptTemporary = stageInstallFile(
    SCRIPT_PATH,
    PC_AGENT_DAEMON_SOURCE,
    0o700,
    (temporary) => verifyStagedDaemon(temporary),
  );

  // Siblings ship with the release, never fetched; checked against the daemon's require lines before anything lands.
  const required = daemonSiblingNames(PC_AGENT_DAEMON_SOURCE);
  const shipped = new Set(DAEMON_SIBLINGS.map((sibling) => sibling.name));
  const unshipped = required.filter((name) => !shipped.has(name));

  if (unshipped.length > 0) {
    throw new KinuError('io', `this CLI ships no ${unshipped.join(', ')} beside the device daemon that requires it`);
  }

  const siblingTemporaries = DAEMON_SIBLINGS.map((sibling) => ({
    target: join(AGENT_HOME, sibling.name),
    temporary: stageInstallFile(
      join(AGENT_HOME, sibling.name),
      sibling.source,
      0o700,
      (temporary) => {
        if (readFileSync(temporary, 'utf-8') !== sibling.source) {
          throw new KinuError('io', `the staged device daemon module ${sibling.name} does not match this release`);
        }
      },
    ),
  }));

  const stamp = `${VERSION}\n`;

  const stampTemporary = stageInstallFile(
    VERSION_STAMP_PATH,
    stamp,
    0o600,
    (temporary) => {
      if (readFileSync(temporary, 'utf-8') !== stamp) {
        throw new KinuError('io', 'the staged device daemon version stamp does not match this release');
      }
    },
  );

  let scriptPending: string | null = scriptTemporary;
  let stampPending: string | null = stampTemporary;
  const siblingsPending = new Set(siblingTemporaries.map((entry) => entry.temporary));
  let configPending: string | null = null;

  try {
    const configTemporary = stageInstallFile(
      DEVICE_CONFIG_PATH,
      config,
      0o600,
      (temporary) => {
        if (readFileSync(temporary, 'utf-8') !== config) {
          throw new KinuError('io', 'temporary device configuration verification failed');
        }
      },
    );

    configPending = configTemporary;

    // Siblings land before the daemon and the config lands last, so a crash never leaves a daemon beside missing siblings
    // or new credentials beside an unverified script.
    for (const entry of siblingTemporaries) {
      renameSync(entry.temporary, entry.target);
      siblingsPending.delete(entry.temporary);
      enforceOwnerOnly(entry.target, 0o700);
    }

    renameSync(scriptTemporary, SCRIPT_PATH);
    scriptPending = null;
    enforceOwnerOnly(SCRIPT_PATH, 0o700);
    // The stamp lands after the daemon; a crash leaves an old stamp, which the hub reads as behind and re-lands.
    renameSync(stampTemporary, VERSION_STAMP_PATH);
    stampPending = null;
    enforceOwnerOnly(VERSION_STAMP_PATH, 0o600);
    rmSync(UPDATE_PENDING_PATH, { force: true });
    renameSync(configTemporary, DEVICE_CONFIG_PATH);
    configPending = null;
    enforceOwnerOnly(DEVICE_CONFIG_PATH, 0o600);
    syncAgentDirectory();
  } catch (cause) {
    try {
      for (const temporary of [scriptPending, stampPending, ...siblingsPending, configPending]) {
        if (temporary !== null) rmSync(temporary, { force: true });
      }
    } catch (cleanup) {
      throw toKinuError({
        doing: 'cleaning up a failed device install',
        cause: new AggregateError([cause, cleanup], 'device install and cleanup both failed'),
        otherwise: 'io',
      });
    }

    if (cause instanceof KinuError) throw cause;
    throw toKinuError({ doing: 'installing the device daemon', cause, otherwise: 'io' });
  }
}

function stageInstallFile(
  file: string,
  content: string,
  mode: number,
  verify: (temporary: string) => void,
): string {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  let created = false;

  try {
    const descriptor = openSync(temporary, 'wx', mode);
    created = true;

    try {
      writeFileSync(descriptor, content);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }

    enforceOwnerOnly(temporary, mode);
    verify(temporary);

    return temporary;
  } catch (cause) {
    if (created) {
      try {
        rmSync(temporary, { force: true });
      } catch (cleanup) {
        throw toKinuError({
          doing: `cleaning up the failed device install at ${file}`,
          cause: new AggregateError([cause, cleanup], 'device install and cleanup both failed'),
          otherwise: 'io',
        });
      }
    }

    if (cause instanceof KinuError) throw cause;
    throw toKinuError({ doing: `preparing the device install at ${file}`, cause, otherwise: 'io' });
  }
}

/** Byte equality with the daemon this CLI carries; a served digest would only prove the download arrived whole. */
function verifyStagedDaemon(temporary: string): void {
  if (readFileSync(temporary, 'utf-8') !== PC_AGENT_DAEMON_SOURCE) {
    throw new KinuError('io', 'the staged device daemon does not match the daemon this CLI ships');
  }
}

function syncAgentDirectory(): void {
  if (process.platform === 'win32') return;
  const descriptor = openSync(AGENT_HOME, 'r');

  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Ends only when the roster row reads connected, the daemon exits, or the user interrupts. No deadline. */
async function waitForDeviceConnected(
  auth: DeviceAuth,
  deviceId: string,
  launch: DaemonLaunch,
  opts: Pick<ConnectDeviceOptions, 'onWaiting' | 'signal'>,
): Promise<CloudDevice | undefined> {
  const stop = new AbortController();
  const stopOnCaller = () => stop.abort();
  opts.signal?.addEventListener('abort', stopOnCaller, { once: true });

  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    const outcome = signal ?? (code === null ? 'unknown exit' : `exit code ${code}`);
    launch.failure = new KinuError(
      'unavailable',
      `the device daemon exited before it could connect (${outcome}). Its last lines:\n${daemonTailForFailure()}\nSee ${DAEMON_LOG_PATH}`,
    );
    stop.abort();
  };

  const onError = () => stop.abort();
  launch.child.once('exit', onExit);
  // spawnDaemonChild's own listener records the failure; this one ends the wait.
  launch.child.once('error', onError);

  if (launch.failure !== null) stop.abort();
  const wait: StoppableWaitOptions = { intervalMs: CONNECT_POLL_MS, signal: stop.signal };

  if (opts.onWaiting) wait.onWaiting = opts.onWaiting;

  try {
    const connected = await waitForAnswer(async () => {
      // A transient GET error while the daemon lives is not-yet; recorded as a shape, never a sentinel a healthy answer could return.
      let miss: { readonly transient: string } | undefined;
      let rows: CloudDevice[] | undefined;

      try {
        rows = await listDevicesForConnect(auth, 'checking whether the device daemon connected');
      } catch (cause) {
        const failure = toKinuError({ doing: 'checking whether the device daemon connected', cause, otherwise: 'unavailable' });
        diagnostics.failure('device.connect.list_transient', failure);
        miss = { transient: renderThrownChain({ cause: failure }) };
      }

      if (miss !== undefined) {
        diagnostics.event('device.connect.list_transient_not_yet', { detail: miss.transient });

        return undefined;
      }

      return rows?.find((device) => device.id === deviceId && device.connected);
    }, wait);

    if (connected !== undefined) return connected;

    if (launch.failure !== null) throw launch.failure;

    return undefined;
  } finally {
    launch.child.off('exit', onExit);
    launch.child.off('error', onError);
    opts.signal?.removeEventListener('abort', stopOnCaller);
  }
}

function daemonTailForFailure(): string {
  return readDaemonLogTail(DAEMON_LOG_PATH, 15) ?? `no daemon log yet at ${DAEMON_LOG_PATH}`;
}

function startInstalledDaemon(session: boolean, runtime?: string): DaemonLaunch {
  assertDaemonPlatformSupported();

  try {
    ensureAgentHome();
  } catch (cause) {
    throw toKinuError({
      doing: `preparing the device install directory ${AGENT_HOME}`,
      cause,
      otherwise: 'io',
    });
  }

  const executable = runtime ?? daemonRuntime();
  killSessionDaemon();

  if (!session) stopRunningDaemon();

  const launch = spawnDaemonChild(executable, session);

  if (session) {
    sessionDaemon = launch.child;
    installSessionCleanup();

    return launch;
  }

  if (!launch.child.pid) return launch;

  try {
    if (!claimDaemonPid(launch.child.pid)) {
      throw new KinuError(
        'unavailable',
        'another device connect is already starting the daemon on this machine; retry in a moment',
      );
    }
  } catch (cause) {
    tolerate(() => launch.child.kill('SIGTERM'), 'esrch');
    throw cause;
  }

  launch.child.unref();

  return launch;
}

function spawnDaemonChild(runtime: string, session: boolean): DaemonLaunch {
  let logDescriptor: number;

  try {
    // Roll before the append fd exists; copy-truncate keeps the inode so later rolls also cap a running daemon.
    rotateDaemonLogIfNeeded(DAEMON_LOG_PATH);
    logDescriptor = openSync(DAEMON_LOG_PATH, 'a');
  } catch (cause) {
    throw toKinuError({
      doing: `opening the device daemon log at ${DAEMON_LOG_PATH}`,
      cause,
      otherwise: 'io',
    });
  }

  try {
    const child = spawn(runtime, [SCRIPT_PATH], session
      ? { stdio: ['ignore', logDescriptor, logDescriptor] }
      : { detached: true, stdio: ['ignore', logDescriptor, logDescriptor] });

    const launch: DaemonLaunch = { child, failure: null };
    child.once('error', (cause) => {
      launch.failure = toKinuError({ doing: 'starting the device daemon', cause, otherwise: 'io' });
    });

    return launch;
  } catch (cause) {
    throw toKinuError({ doing: 'starting the device daemon', cause, otherwise: 'io' });
  } finally {
    closeSync(logDescriptor);
  }
}

function recordedDaemonPid(): number | null {
  if (!existsSync(PID_PATH)) return null;
  let contents: string;

  try {
    contents = readFileSync(PID_PATH, 'utf-8');
  } catch (cause) {
    throw toKinuError({ doing: `reading the device daemon pidfile at ${PID_PATH}`, cause, otherwise: 'io' });
  }

  const pid = Number(contents.trim());

  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function runningDaemonPid(): number | null {
  const pid = recordedDaemonPid();

  if (pid === null) return null;

  return processAlive(pid) ? pid : null;
}

function claimDaemonPid(pid: number): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (writePidfile(pid)) return true;

    // The daemon claims this same file, so a pidfile naming this pid is this claim.
    if (recordedDaemonPid() === pid) return true;

    if (runningDaemonPid() !== null) return false;

    try {
      rmSync(PID_PATH, { force: true });
    } catch (cause) {
      throw toKinuError({ doing: `removing the stale device daemon pidfile at ${PID_PATH}`, cause, otherwise: 'io' });
    }
  }

  return false;
}

function writePidfile(pid: number): boolean {
  let descriptor: number | null = null;
  let created = false;

  try {
    descriptor = openSync(PID_PATH, 'wx', 0o600);
    created = true;
    writeFileSync(descriptor, `${pid}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    enforceOwnerOnly(PID_PATH, 0o600);
    syncAgentDirectory();

    return true;
  } catch (cause) {
    if (descriptor !== null) closeSync(descriptor);

    if (!created && classify({ cause }) === 'eexist') return false;

    if (created) {
      try {
        rmSync(PID_PATH, { force: true });
      } catch (cleanup) {
        throw toKinuError({
          doing: `cleaning up the failed device daemon pidfile at ${PID_PATH}`,
          cause: new AggregateError([cause, cleanup], 'pidfile write and cleanup both failed'),
          otherwise: 'io',
        });
      }
    }

    throw toKinuError({ doing: `writing the device daemon pidfile at ${PID_PATH}`, cause, otherwise: 'io' });
  }
}

function stopRunningDaemon(): void {
  const pid = runningDaemonPid();

  if (pid && processIsInstalledDaemon(pid)) {
    try {
      tolerate(() => process.kill(pid, 'SIGTERM'), 'esrch');
    } catch (cause) {
      throw toKinuError({ doing: `stopping the device daemon (pid ${pid})`, cause, otherwise: 'io' });
    }
  }

  try {
    rmSync(PID_PATH, { force: true });
  } catch (cause) {
    throw toKinuError({ doing: `removing the device daemon pidfile at ${PID_PATH}`, cause, otherwise: 'io' });
  }
}

function processIsInstalledDaemon(pid: number): boolean {
  try {
    if (process.platform === 'linux') {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').includes(SCRIPT_PATH);
    }

    if (process.platform === 'darwin') {
      return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' }).includes(SCRIPT_PATH);
    }

    return false;
  } catch (cause) {
    if (classify({ cause }) === 'enoent') return false;

    if (cause instanceof Error && 'code' in cause && (cause.code === 'EACCES' || cause.code === 'EPERM')) {
      return false;
    }

    if (process.platform === 'darwin' && cause instanceof Error && 'status' in cause && cause.status === 1) {
      return false;
    }

    throw toKinuError({
      doing: `checking whether pid ${pid} is the installed device daemon`,
      cause,
      otherwise: 'io',
    });
  }
}

export function killSessionDaemon(): void {
  const daemon = sessionDaemon;

  if (daemon && daemon.exitCode === null && !daemon.killed) {
    try {
      tolerate(() => daemon.kill('SIGTERM'), 'esrch');
    } catch (cause) {
      throw toKinuError({ doing: 'stopping the session device daemon', cause, otherwise: 'io' });
    }
  }

  sessionDaemon = null;
}

function installSessionCleanup(): void {
  if (sessionCleanupInstalled) return;
  sessionCleanupInstalled = true;
  process.on('exit', () => {
    killSessionDaemon();
  });
}

/** `kill(pid, 0)` reports presence under another user as EPERM, not only absence as ESRCH. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (cause) {
    if (classify({ cause }) === 'esrch') return false;

    if (cause instanceof Error && 'code' in cause && cause.code === 'EPERM') return true;
    throw toKinuError({ doing: `checking whether the device daemon pid ${pid} is running`, cause, otherwise: 'io' });
  }
}

function assertDaemonPlatformSupported(): void {
  if (process.platform === 'linux' || process.platform === 'darwin') return;
  throw new KinuError('unsupported', 'The daemon runs on Linux and macOS only.');
}

/** The Bun running this CLI; PATH `node` is never used, since the daemon needs `globalThis.WebSocket`. */
function daemonRuntime(): string {
  if ('bun' in process.versions) return process.execPath;
  throw new KinuError(
    'unsupported',
    'The Kinu CLI must run under its bundled Bun to start the desktop daemon.',
  );
}
