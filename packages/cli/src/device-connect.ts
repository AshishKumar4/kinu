/**
 * Device connect — the single implementation behind every "link this PC"
 * surface (kinu connect/desktop, the chat connect prompts, /connect).
 * Registers the device, installs the daemon this CLI ships (the daemon is the
 * only device-RPC implementation, and its bytes travel inside the release, so
 * connect fetches no executable code from anywhere), starts it either
 * persistently (detached + pidfile) or for this CLI session only (a child
 * killed when the CLI exits), and verifies the device actually shows up
 * connected on the server before claiming success.
 *
 * One daemon owns a machine. `~/.kinu/pc-agent.pid` names it, and the daemon
 * claims that file in its own process too, so a daemon started by anything
 * else exits instead of running beside this one.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { classify, classifyErrorCode, KinuError, renderThrownChain, tolerate, toKinuError } from '@kinu.run/core/obs';
import { describeGpuNodes, effectiveDeviceMode, sandboxReasonFix } from '@kinu.run/core';
import { enforceOwnerOnly, ensureSecretDir } from '@kinu.run/cli-backend';
import { AGENT_HOME, ensureAgentHome, loadConfigFile, requireAuthConfig, resolveCloudSession, updateConfigFile } from './config';
import { listCloudDevices, registerCloudDevice, type CloudDevice, type CloudDeviceSandbox } from './cloud-api';
import PC_AGENT_DAEMON_SOURCE from '../../pc-agent/src/index.js' with { type: 'text' };
import PC_AGENT_SANDBOX_SOURCE from '../../pc-agent/src/sandbox.js' with { type: 'text' };
import PC_AGENT_PTY_SOURCE from '../../pc-agent/src/pty.js' with { type: 'text' };

const PID_PATH = join(AGENT_HOME, 'pc-agent.pid');
const SCRIPT_PATH = join(AGENT_HOME, 'pc-agent.js');
/**
 * Every module the daemon `require`s beside itself, by the name it requires.
 *
 * The daemon is one file that requires siblings by relative path, so the
 * shipped set is the daemon's own require lines and nothing else — a sibling
 * missing here is a daemon that dies on its first require after a clean
 * install, which is how the pty module shipped nowhere for one release.
 * `daemonSiblingNames` reads those lines from the source this CLI ships, and
 * the install refuses to stage a daemon whose requires this table does not
 * cover.
 */
const DAEMON_SIBLINGS: readonly { readonly name: string; readonly source: string }[] = [
  { name: 'sandbox.js', source: PC_AGENT_SANDBOX_SOURCE },
  { name: 'pty.js', source: PC_AGENT_PTY_SOURCE },
];

/** The sibling names the daemon source requires — `require('./x.js')`. */
function daemonSiblingNames(daemonSource: string): readonly string[] {
  return [...daemonSource.matchAll(/require\('\.\/([^']+)'\)/g)].map((m) => m[1] ?? '').filter((n) => n !== '');
}
export const DAEMON_LOG_PATH = join(AGENT_HOME, 'pc-agent.log');
export const DEVICE_CONFIG_PATH = join(AGENT_HOME, 'device.json');
/** Where this machine keeps agent homes. The daemon reports this ROOT to the
 *  hub on HELLO and the hub composes `<root>/<workspace>/home` per command, so
 *  the CLI creates the root and the daemon owns everything under it. */
const AGENT_ROOT = join(AGENT_HOME, 'agents');
export const DEVICE_CONNECT_DEADLINE_MS = 20_000;
const CONNECT_POLL_MS = 1_000;
const DAEMON_EARLY_EXIT_GRACE_MS = 250;

/** The name a machine has when nobody named it. */
export const UNNAMED_DEVICE_NAME = 'Your PC';

/**
 * What this machine offers as its own name: `user@hostname`, which is what a
 * person recognises in a device list. `os.userInfo()` is the POSIX answer and
 * raises ENOENT when the uid has no passwd entry (a container built without
 * one), so the environment answers second and the neutral name last.
 */
export function defaultDeviceName(): string {
  const user = (tolerate(() => userInfo().username, 'enoent') ?? process.env.USER ?? '').trim();
  const host = hostname().trim();
  return user && host ? `${user}@${host}` : UNNAMED_DEVICE_NAME;
}

/**
 * Create the agent-home root, owner-only. `mkdir -p` then a VERIFIED chmod, so
 * a root an earlier build left group-readable is tightened instead of kept.
 * What the agent writes on this machine is the owner's alone.
 */
function ensureAgentRoot(): void {
  ensureSecretDir(AGENT_ROOT);
}

/**
 * What linking this machine means. The words live in `@kinu.run/core` because
 * the web connect panel renders the same five sentences; this re-export keeps
 * every CLI surface importing them from the module it already imports.
 */
export { DEVICE_CONNECT_DISCLOSURE } from '@kinu.run/core';

export interface DeviceAuth {
  origin: string;
  token: string;
}

export interface ConnectDeviceOptions {
  label?: string;
  /** Tie the daemon to this CLI process instead of installing it persistently. */
  session?: boolean;
  /** Called once per verification poll tick (~1/s) while waiting for the daemon. */
  onPoll?: () => void;
}


export interface ConnectOutcomeDescription {
  ok: boolean;
  message: string;
}

export type ConnectDeviceResult =
  | { kind: 'connected'; deviceId: string; sandbox: CloudDeviceSandbox }
  | { kind: 'timeout'; deviceId: string }
  /** Session mode found a persistent daemon already running and left it alone. */
  | { kind: 'already-running'; connected: boolean };

export async function connectDevice(auth: DeviceAuth, opts: ConnectDeviceOptions = {}): Promise<ConnectDeviceResult> {
  if (opts.session && runningDaemonPid() !== null) {
    // The running daemon owns device.json and its credentials — leave it alone.
    const devices = await listDevicesForConnect(auth, 'checking whether the installed daemon is connected');
    return { kind: 'already-running', connected: devices.some((device) => device.connected) };
  }
  assertDaemonPlatformSupported();
  const runtime = daemonRuntime();
  const device = await registerDeviceForConnect(auth, opts.label);
  installDaemonFiles(device);
  const launch = startInstalledDaemon(opts.session === true, runtime);
  if (launch !== null) await waitForDaemonStart(launch);
  // Don't trust the spawn — the daemon must show up as connected on the
  // server before we claim success.
  const connected = await waitForDeviceConnected(auth, device.deviceId, opts.onPoll);
  if (connected === undefined) return { kind: 'timeout', deviceId: device.deviceId };
  anyDeviceConnected = true;
  return { kind: 'connected', deviceId: device.deviceId, sandbox: connected.sandbox };
}


export interface DaemonStatus {
  deviceConfigPresent: boolean;
  logPresent: boolean;
  /** Pid of the live daemon that owns this machine, or null when none does. */
  daemonPid: number | null;
  /** Whether this CLI process has a live session daemon child. */
  sessionActive: boolean;
}

export function daemonStatus(): DaemonStatus {
  return {
    deviceConfigPresent: existsSync(DEVICE_CONFIG_PATH),
    logPresent: existsSync(DAEMON_LOG_PATH),
    daemonPid: runningDaemonPid(),
    sessionActive: sessionDaemon !== null && sessionDaemon.exitCode === null && !sessionDaemon.killed,
  };
}

export function readDaemonLogTail(lines: number): string {
  if (!existsSync(DAEMON_LOG_PATH)) return '(no log file)';
  const content = readFileSync(DAEMON_LOG_PATH, 'utf-8').trimEnd();
  return content ? content.split('\n').slice(-lines).join('\n') : '(log is empty)';
}

// ── Connect prompt policy ────────────────────────────────────────

let offerConsumed = false;
let anyDeviceConnected: boolean | null = null;

/**
 * Whether a chat surface should offer the connect prompt now: cloud auth
 * present, the prompt not permanently dismissed, and no device connected
 * (the device list answer is cached — never polled). A true answer consumes
 * the per-invocation latch, so the prompt is asked at most once per CLI run.
 */
export async function shouldOfferDeviceConnect(): Promise<boolean> {
  if (offerConsumed) return false;
  if (loadConfigFile().deviceConnectPromptDismissed) return false;
  const auth = resolveCloudSession();
  if (!auth) return false;
  if (anyDeviceConnected === null) {
    try {
      const devices = await listCloudDevices(auth.origin, auth.token);
      anyDeviceConnected = devices.some((device) => device.connected);
    } catch (error) {
      // Never nag when the answer is unknown — an unreachable cloud is not evidence that no device
      // is connected. A malformed origin is ours, not the network's: swallowing it would disable
      // the prompt for good with nothing to show for it.
      if (classify({ cause: error }) === 'malformed-input') throw error;
      return false;
    }
  }
  if (anyDeviceConnected) return false;
  offerConsumed = true;
  return true;
}

/** Persist the "[d] don't ask again" choice. */
export function dismissDeviceConnectPrompt(): void {
  updateConfigFile((config) => {
    config.deviceConnectPromptDismissed = true;
  });
}

/** One-line current device status for the /connect surfaces. */
export async function deviceStatusLine(): Promise<string> {
  try {
    const auth = requireAuthConfig();
    const devices = await listCloudDevices(auth.origin, auth.token);
    anyDeviceConnected = devices.some((device) => device.connected);
    const connected = devices.filter((device) => device.connected);
    if (connected.length > 0) {
      const named = connected.map((device) => `${device.label} (${sandboxStateTag(device.sandbox)})`);
      return `Connected: ${named.join(', ')}`;
    }
    if (devices.length > 0) return `${devices.length} registered device${devices.length === 1 ? '' : 's'}, none connected.`;
    return 'No PC is connected to your account yet.';
  } catch (err) {
    return `Device status unavailable: ${renderThrownChain({ cause: err })}`;
  }
}

/** Shared outcome wording for the chat connect surfaces. */
export function describeConnectOutcome(result: ConnectDeviceResult, session: boolean): ConnectOutcomeDescription {
  switch (result.kind) {
    case 'already-running':
      return result.connected
        ? { ok: true, message: 'This PC is already connected.' }
        : { ok: false, message: 'The daemon is installed here but not connected. Run: kinu connect' };
    case 'timeout':
      return { ok: false, message: `The daemon did not connect within ${DEVICE_CONNECT_DEADLINE_MS / 1000}s. Check: kinu desktop logs` };
    case 'connected':
      return {
        ok: true,
        message: session
          ? 'Connected for this session. The daemon stops when you leave the CLI.'
          : 'Connected. This PC stays linked across sessions.',
      };
  }
}

/**
 * What the machine reported about its own sandbox, in the words the owner
 * needs. One line while the sandbox is on or off. Three lines when the machine
 * cannot sandbox: the state, the fix, and what stays blocked meanwhile. A
 * fourth line, the daemon's own, when it sent one, because for a probe that
 * failed in words nobody classified that line is what the fix tells the owner
 * to act on. The reason code the daemon reported (`no_bwrap`, `no_userns`) is
 * deliberately NOT printed: it names our own implementation, and the fix
 * sentence is the half the owner can act on. The fix lives in
 * `@kinu.run/core`, so every surface prints the same one.
 */
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

/** The shortest honest form of a connected device's sandbox state, for the
 *  one-line device status. */
function sandboxStateTag(sandbox: CloudDeviceSandbox): string {
  switch (effectiveDeviceMode(sandbox)) {
    case 'sandboxed': return 'sandbox on';
    case 'raw': return 'sandbox OFF';
    case 'files_only': return 'cannot sandbox';
  }
}

// ── Internals ────────────────────────────────────────────────────

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
    // The directory `kinu connect` ran in is the directory the owner
    // consented; the daemon sends it in HELLO and the hub scopes every
    // base-tier file call to it.
    root: process.cwd(),
  }, null, 2)}\n`;
  const scriptTemporary = stageInstallFile(
    SCRIPT_PATH,
    PC_AGENT_DAEMON_SOURCE,
    0o700,
    (temporary) => verifyStagedDaemon(temporary),
  );
  // The daemon requires these beside itself, so they are not optional and
  // they are not fetched: each ships in the same release as the code that
  // reads it, or a released daemon dies on its first require. The table is
  // checked against the daemon's own require lines before anything lands.
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
  let scriptPending: string | null = scriptTemporary;
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

    // The config activates the replacement on the next daemon start, so it
    // lands last. A crash can leave a newer script beside the old credentials,
    // never new credentials beside an unverified script.
    // Every sibling lands BEFORE the daemon that requires it, for the same
    // reason the config lands after: no ordering leaves a daemon on disk whose
    // sibling is missing or older than it.
    for (const entry of siblingTemporaries) {
      renameSync(entry.temporary, entry.target);
      siblingsPending.delete(entry.temporary);
      enforceOwnerOnly(entry.target, 0o700);
    }
    renameSync(scriptTemporary, SCRIPT_PATH);
    scriptPending = null;
    enforceOwnerOnly(SCRIPT_PATH, 0o700);
    renameSync(configTemporary, DEVICE_CONFIG_PATH);
    configPending = null;
    enforceOwnerOnly(DEVICE_CONFIG_PATH, 0o600);
    syncAgentDirectory();
  } catch (cause) {
    try {
      for (const temporary of [scriptPending, ...siblingsPending, configPending]) {
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

/**
 * What landed on disk is the daemon this CLI carries, byte for byte. The
 * question a client can answer about its own bytes is equality with them —
 * a digest served beside a download only proves the download arrived whole.
 */
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

/** The connected device row the server reports, or undefined once the deadline
 *  passes. The row carries what the machine said about its own sandbox, so the
 *  caller states that without a second request. */
async function waitForDeviceConnected(auth: DeviceAuth, deviceId: string, onPoll?: () => void): Promise<CloudDevice | undefined> {
  const deadline = Date.now() + DEVICE_CONNECT_DEADLINE_MS;
  while (Date.now() < deadline) {
    const nextPoll = Promise.withResolvers<void>();
    setTimeout(nextPoll.resolve, CONNECT_POLL_MS);
    await nextPoll.promise;
    onPoll?.();
    const devices = await listDevicesForConnect(auth, 'checking whether the device daemon connected');
    const connected = devices.find((device) => device.id === deviceId && device.connected);
    if (connected) return connected;
  }
  return undefined;
}

function startInstalledDaemon(session: boolean, runtime?: string): DaemonLaunch | null {
  if (session && runningDaemonPid() !== null) return null;
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

function waitForDaemonStart(launch: DaemonLaunch): Promise<void> {
  const completion = Promise.withResolvers<void>();
  let settled = false;

  function finish(error?: KinuError): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    launch.child.off('exit', onExit);
    launch.child.off('error', onError);
    if (error) completion.reject(error);
    else completion.resolve();
  }

  function onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const outcome = signal ?? (code === null ? 'unknown exit' : `exit code ${code}`);
    finish(new KinuError(
      'unavailable',
      `the device daemon exited before it could connect (${outcome}). See ${DAEMON_LOG_PATH}`,
    ));
  }

  function onError(cause: Error): void {
    finish(toKinuError({ doing: 'starting the device daemon', cause, otherwise: 'io' }));
  }

  const timer = setTimeout(() => finish(), DAEMON_EARLY_EXIT_GRACE_MS);
  launch.child.once('exit', onExit);
  launch.child.once('error', onError);
  if (launch.failure !== null) finish(launch.failure);
  return completion.promise;
}

/** The pid the pidfile names, whether or not that process still exists. */
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

/** The pid of the daemon that owns this machine, or null when none runs. */
function runningDaemonPid(): number | null {
  const pid = recordedDaemonPid();
  if (pid === null) return null;
  return processAlive(pid) ? pid : null;
}

function claimDaemonPid(pid: number): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (writePidfile(pid)) return true;
    // The daemon claims this same file at startup, so a pidfile that already
    // names the process being claimed for is this claim, not a competing one.
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

/**
 * Whether `pid` exists. `kill(pid, 0)` reports absence as ESRCH and *presence under another user*
 * as EPERM, so treating every failure as death reported a live daemon as gone — and a session
 * daemon was then started alongside it while its pidfile was deleted.
 */
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

/**
 * The runtime the daemon runs on: the Bun that is already running this CLI.
 * A `node` found on PATH is never consulted — the daemon speaks WebSocket with
 * `globalThis.WebSocket`, which a host Node without a `ws` install lacks, and a
 * machine's PATH Node is exactly the runtime the CLI does not control (a conda
 * base Node answered `--version` and then killed the daemon with "install Node
 * 22+ or the ws package"). The installer's Bun is the one runtime verified
 * compatible, so the one that runs the CLI runs the daemon.
 */
function daemonRuntime(): string {
  if ('bun' in process.versions) return process.execPath;
  throw new KinuError(
    'unsupported',
    'The Kinu CLI must run under its bundled Bun to start the desktop daemon.',
  );
}
