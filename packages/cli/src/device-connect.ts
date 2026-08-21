/**
 * Device connect — the single implementation behind every "link this PC"
 * surface (kinu connect/desktop, the chat connect prompts, /connect).
 * Registers the device, installs the daemon script downloaded from
 * /pc/daemon.js (the daemon is the only device-RPC implementation), starts it
 * either persistently (detached + pidfile) or for this CLI session only (a
 * child killed when the CLI exits), and verifies the device actually shows up
 * connected on the server before claiming success.
 */

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { classify, renderThrownChain, tolerate } from '@kinu.run/core/obs';
import { AGENT_HOME, loadConfigFile, requireAuthConfig, resolveCloudSession, updateConfigFile } from './config';
import { listCloudDevices, registerCloudDevice } from './cloud-api';

const PID_PATH = join(AGENT_HOME, 'pc-agent.pid');
const SCRIPT_PATH = join(AGENT_HOME, 'pc-agent.js');
export const DAEMON_LOG_PATH = join(AGENT_HOME, 'pc-agent.log');
export const DEVICE_CONFIG_PATH = join(AGENT_HOME, 'device.json');
export const DEVICE_CONNECT_DEADLINE_MS = 20_000;
const CONNECT_POLL_MS = 1_000;

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

export interface StartDaemonResult {
  started: boolean;
}

export interface ConnectOutcomeDescription {
  ok: boolean;
  message: string;
}

export type ConnectDeviceResult =
  | { kind: 'connected'; deviceId: string }
  | { kind: 'timeout'; deviceId: string }
  /** Session mode found a persistent daemon already running and left it alone. */
  | { kind: 'already-running'; connected: boolean };

export async function connectDevice(auth: DeviceAuth, opts: ConnectDeviceOptions = {}): Promise<ConnectDeviceResult> {
  if (opts.session && persistentDaemonPid() !== null) {
    // The persistent daemon owns device.json and its credentials — leave it alone.
    const devices = await listCloudDevices(auth.origin, auth.token);
    return { kind: 'already-running', connected: devices.some((device) => device.connected) };
  }
  if (!nodeAvailable()) {
    throw new Error('Node.js is required for the desktop daemon. Install Node.js, then retry.');
  }
  const device = await registerCloudDevice(auth.origin, auth.token, opts.label);
  installDaemonFiles(await downloadDaemonScript(device.origin), device);
  startDaemon({ session: opts.session });
  // Don't trust the spawn — the daemon must show up as connected on the
  // server before we claim success.
  const connected = await waitForDeviceConnected(auth, device.deviceId, opts.onPoll);
  if (connected) anyDeviceConnected = true;
  return { kind: connected ? 'connected' : 'timeout', deviceId: device.deviceId };
}

/**
 * Start the installed daemon. Persistent mode replaces any previous daemon
 * (detached child + pidfile); session mode spawns a child tied to this CLI
 * process (killed on exit, no pidfile) and no-ops when a persistent daemon is
 * already running.
 */
export function startDaemon(opts: { session?: boolean } = {}): StartDaemonResult {
  if (opts.session && persistentDaemonPid() !== null) return { started: false };
  // Replace, don't accumulate: a previous daemon (with its old credentials)
  // must die before the new one starts.
  killSessionDaemon();
  if (!opts.session) stopPersistentDaemon();

  const logFd = openSync(DAEMON_LOG_PATH, 'a');
  try {
    if (opts.session) {
      sessionDaemon = spawn('node', [SCRIPT_PATH], { stdio: ['ignore', logFd, logFd] });
      installSessionCleanup();
    } else {
      const child = spawn('node', [SCRIPT_PATH], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
      child.unref();
      if (child.pid) writeFileSync(PID_PATH, `${child.pid}\n`, { mode: 0o600 });
    }
  } finally {
    closeSync(logFd);
  }
  return { started: true };
}

export interface DaemonStatus {
  deviceConfigPresent: boolean;
  logPresent: boolean;
  /** Pid of a live persistent daemon, or null when none is running. */
  persistentPid: number | null;
  /** Whether this CLI process has a live session daemon child. */
  sessionActive: boolean;
}

export function daemonStatus(): DaemonStatus {
  return {
    deviceConfigPresent: existsSync(DEVICE_CONFIG_PATH),
    logPresent: existsSync(DAEMON_LOG_PATH),
    persistentPid: persistentDaemonPid(),
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
    if (connected.length > 0) return `Connected: ${connected.map((device) => device.label).join(', ')}`;
    if (devices.length > 0) return `${devices.length} registered device${devices.length === 1 ? '' : 's'}, none connected.`;
    return 'No devices are registered for your account yet.';
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
        : { ok: false, message: 'A connect daemon is installed but not connected. Run: kinu connect' };
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

// ── Internals ────────────────────────────────────────────────────

let sessionDaemon: ChildProcess | null = null;
let sessionCleanupInstalled = false;

async function downloadDaemonScript(origin: string): Promise<string> {
  const daemonUrl = `${origin.replace(/\/+$/, '')}/pc/daemon.js`;
  const res = await fetch(daemonUrl);
  if (!res.ok) throw new Error(`Failed to download desktop daemon: HTTP ${res.status}`);
  return await res.text();
}

function installDaemonFiles(script: string, device: { origin: string; userId: string; token: string }): void {
  mkdirSync(AGENT_HOME, { recursive: true });
  chmodSync(AGENT_HOME, 0o700);
  writeFileSync(SCRIPT_PATH, script, { mode: 0o700 });
  chmodSync(SCRIPT_PATH, 0o700);
  writeFileSync(DEVICE_CONFIG_PATH, `${JSON.stringify({
    user: device.userId,
    token: device.token,
    origin: device.origin.replace(/\/+$/, ''),
  }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(DEVICE_CONFIG_PATH, 0o600);
}

async function waitForDeviceConnected(auth: DeviceAuth, deviceId: string, onPoll?: () => void): Promise<boolean> {
  const deadline = Date.now() + DEVICE_CONNECT_DEADLINE_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, CONNECT_POLL_MS));
    onPoll?.();
    const devices = await listCloudDevices(auth.origin, auth.token);
    if (devices.some((device) => device.id === deviceId && device.connected)) return true;
  }
  return false;
}

function persistentDaemonPid(): number | null {
  if (!existsSync(PID_PATH)) return null;
  const pid = Number(readFileSync(PID_PATH, 'utf-8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return processAlive(pid) ? pid : null;
}

function stopPersistentDaemon(): void {
  const pid = persistentDaemonPid();
  if (pid) {
    // ESRCH only: the daemon raced its own exit. Anything else means it is still running and the
    // pidfile removal below would forget a daemon nobody can stop.
    tolerate(() => process.kill(pid, 'SIGTERM'), 'esrch');
  }
  rmSync(PID_PATH, { force: true });
}

function killSessionDaemon(): void {
  if (sessionDaemon && sessionDaemon.exitCode === null && !sessionDaemon.killed) {
    sessionDaemon.kill('SIGTERM');
  }
  sessionDaemon = null;
}

function installSessionCleanup(): void {
  if (sessionCleanupInstalled) return;
  sessionCleanupInstalled = true;
  process.on('exit', () => {
    if (sessionDaemon && sessionDaemon.exitCode === null) sessionDaemon.kill('SIGTERM');
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
  } catch (error) {
    if (classify({ cause: error }) === 'esrch') return false;
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') return true;
    throw error;
  }
}

function nodeAvailable(): boolean {
  const result = spawnSync('node', ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}
