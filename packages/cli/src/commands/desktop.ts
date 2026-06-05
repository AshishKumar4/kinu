import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { AGENT_HOME, requireAuthConfig, resolveCloudOrigin } from '../config.js';
import { registerCloudDevice } from '../cloud-api.js';
import { ACCENT, DIM, OK } from '../display.js';
import { authCommand } from './auth.js';

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
    console.log('');
    console.log(`${OK('✓')} Connected this machine as ${ACCENT(opts.label ?? 'My device')}`);
    console.log(`${DIM('Daemon log:')} ${join(AGENT_HOME, 'pc-agent.log')}`);
    console.log('');
    return;
  }
  if (sub === 'status') {
    const cfgPath = join(AGENT_HOME, 'device.json');
    const logPath = join(AGENT_HOME, 'pc-agent.log');
    console.log(`${DIM('Device config:')} ${existsSync(cfgPath) ? OK('present') : 'missing'} ${DIM(cfgPath)}`);
    console.log(`${DIM('Daemon log:')} ${existsSync(logPath) ? OK('present') : 'missing'} ${DIM(logPath)}`);
    return;
  }
  if (sub === 'logs') {
    const logPath = join(AGENT_HOME, 'pc-agent.log');
    if (!existsSync(logPath)) throw new Error(`No desktop daemon log at ${logPath}`);
    const lines = readFileSync(logPath, 'utf-8').split('\n').slice(-80).join('\n');
    console.log(lines);
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
  const logPath = join(AGENT_HOME, 'pc-agent.log');

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

  const logFd = openSync(logPath, 'a');
  try {
    const child = spawn('node', [agentPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
}

function nodeAvailable(): boolean {
  const result = spawnSync('node', ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}
