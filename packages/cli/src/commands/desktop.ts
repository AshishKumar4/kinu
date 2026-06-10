import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { AGENT_HOME, requireAuthConfig, resolveCloudOrigin } from '../config.js';
import { listCloudDevices, registerCloudDevice } from '../cloud-api.js';
import { ACCENT, DIM, ERR, OK } from '../display.js';
import { authCommand } from './auth.js';

const PID_PATH = join(AGENT_HOME, 'pc-agent.pid');
const LOG_PATH = join(AGENT_HOME, 'pc-agent.log');
const CONNECT_DEADLINE_MS = 20_000;
const CONNECT_POLL_MS = 1_000;

export async function desktopCommand(action: string | undefined, opts: { label?: string }): Promise<void> {
  const sub = action ?? 'status';
  if (sub === 'connect' || sub === 'install') {
    const auth = await requireAuthOrLogin();
    const device = await registerCloudDevice(auth.origin, auth.token, opts.label);
    await installAndStartDaemon({
      origin: device.origin,
      userId: device.userId,
      token: device.token,
    });

    // Don't trust the spawn — the daemon must show up as connected on the
    // server before we claim success.
    process.stdout.write(DIM('Waiting for the daemon to connect'));
    const connected = await waitForDeviceConnected(auth.origin, auth.token, device.deviceId);
    process.stdout.write('\n');
    if (!connected) {
      console.error(`${ERR('✗')} Daemon did not connect within ${CONNECT_DEADLINE_MS / 1000}s (device ${device.deviceId}).`);
      console.error(`${DIM('Daemon log tail')} (${LOG_PATH}):`);
      console.error(tailFile(LOG_PATH, 15));
      process.exit(1);
    }
    console.log('');
    console.log(`${OK('✓')} Connected this machine as ${ACCENT(opts.label ?? 'My device')}`);
    console.log(`${DIM('Daemon log:')} ${LOG_PATH}`);
    console.log('');
    return;
  }
  if (sub === 'status') {
    const cfgPath = join(AGENT_HOME, 'device.json');
    console.log(`${DIM('Device config:')} ${existsSync(cfgPath) ? OK('present') : 'missing'} ${DIM(cfgPath)}`);
    console.log(`${DIM('Daemon log:')} ${existsSync(LOG_PATH) ? OK('present') : 'missing'} ${DIM(LOG_PATH)}`);
    const pid = readDaemonPid();
    console.log(`${DIM('Daemon process:')} ${pid && processAlive(pid) ? OK(`running (pid ${pid})`) : 'not running'}`);
    return;
  }
  if (sub === 'logs') {
    if (!existsSync(LOG_PATH)) throw new Error(`No desktop daemon log at ${LOG_PATH}`);
    console.log(tailFile(LOG_PATH, 80));
    return;
  }
  throw new Error('Usage: proteus desktop [connect|status|logs]');
}

async function requireAuthOrLogin(): Promise<{ origin: string; token: string; user?: { id: string; email: string; displayName?: string | null } }> {
  try {
    return requireAuthConfig();
  } catch (err) {
    if (!/Not authenticated/.test(err instanceof Error ? err.message : String(err))) throw err;
  }
  const origin = resolveCloudOrigin();
  console.log(`${DIM('Not signed in. Starting Proteus login...')}`);
  await authCommand({ origin });
  return requireAuthConfig();
}

async function installAndStartDaemon(input: { origin: string; userId: string; token: string }): Promise<void> {
  if (!nodeAvailable()) {
    throw new Error('Node.js is required for the desktop daemon. Install Node.js, then run: proteus connect');
  }
  mkdirSync(AGENT_HOME, { recursive: true });
  chmodSync(AGENT_HOME, 0o700);

  const agentPath = join(AGENT_HOME, 'pc-agent.js');
  const configPath = join(AGENT_HOME, 'device.json');

  const daemonUrl = `${input.origin.replace(/\/+$/, '')}/pc/daemon.js`;
  const res = await fetch(daemonUrl);
  if (!res.ok) throw new Error(`Failed to download desktop daemon: HTTP ${res.status}`);
  writeFileSync(agentPath, await res.text(), { mode: 0o700 });
  chmodSync(agentPath, 0o700);
  writeFileSync(configPath, `${JSON.stringify({
    user: input.userId,
    token: input.token,
    origin: input.origin.replace(/\/+$/, ''),
  }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(configPath, 0o600);

  // Replace, don't accumulate: a previous daemon (with its old credentials)
  // must die before the new one starts.
  stopExistingDaemon();

  const logFd = openSync(LOG_PATH, 'a');
  try {
    const child = spawn('node', [agentPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    if (child.pid) writeFileSync(PID_PATH, `${child.pid}\n`, { mode: 0o600 });
  } finally {
    closeSync(logFd);
  }
}

async function waitForDeviceConnected(origin: string, token: string, deviceId: string): Promise<boolean> {
  const deadline = Date.now() + CONNECT_DEADLINE_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, CONNECT_POLL_MS));
    process.stdout.write(DIM('.'));
    try {
      const devices = await listCloudDevices(origin, token);
      if (devices.some((d) => d.id === deviceId && d.connected)) return true;
    } catch { /* transient — keep polling until the deadline */ }
  }
  return false;
}

function readDaemonPid(): number | null {
  if (!existsSync(PID_PATH)) return null;
  const pid = Number(readFileSync(PID_PATH, 'utf-8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function stopExistingDaemon(): void {
  const pid = readDaemonPid();
  if (pid && processAlive(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* raced its exit */ }
  }
  rmSync(PID_PATH, { force: true });
}

function tailFile(path: string, lines: number): string {
  if (!existsSync(path)) return '(no log file)';
  const content = readFileSync(path, 'utf-8').trimEnd();
  return content ? content.split('\n').slice(-lines).join('\n') : '(log is empty)';
}

function nodeAvailable(): boolean {
  const result = spawnSync('node', ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}
