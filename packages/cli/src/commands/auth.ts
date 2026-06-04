import { spawn } from 'node:child_process';
import { hostname, platform } from 'node:os';
import { defaultOrigin, logout, pollCliAuth, startCliAuth, whoami } from '../cloud-api.js';
import { loadConfigFile, saveConfigFile } from '../config.js';
import { ACCENT, DIM, OK } from '../display.js';

export async function authCommand(opts: { origin?: string }): Promise<void> {
  const origin = defaultOrigin(opts);
  const flow = await startCliAuth(origin, hostname());

  console.log('');
  console.log(`${DIM('Open:')} ${ACCENT(flow.verificationUrl)}`);
  console.log(`${DIM('Code:')} ${ACCENT(flow.userCode)}`);
  console.log('');

  openBrowser(flow.verificationUrl);

  const expiresAt = Date.parse(flow.expiresAt);
  while (Date.now() < expiresAt) {
    await delay(Math.max(1, flow.intervalSeconds) * 1000);
    const status = await pollCliAuth(origin, flow.deviceToken);
    if (status.status === 'pending') {
      process.stdout.write('.');
      continue;
    }
    console.log('');
    if (status.status === 'expired') throw new Error(status.message ?? 'CLI auth expired.');
    if (!status.token || !status.user) throw new Error('Auth approved but no token returned.');
    const config = loadConfigFile();
    saveConfigFile({
      ...config,
      origin: status.origin ?? origin,
      accessToken: status.token,
      tokenExpiresAt: status.expiresAt,
      user: status.user,
    });
    console.log(`${OK('✓')} Signed in as ${ACCENT(status.user.email)}`);
    return;
  }

  throw new Error('CLI auth expired. Run proteus auth again.');
}

export async function whoamiCommand(opts: { origin?: string }): Promise<void> {
  const config = loadConfigFile();
  const origin = defaultOrigin(opts);
  const token = config.accessToken;
  if (!token) throw new Error('Not authenticated. Run: proteus auth');
  const result = await whoami(origin, token);
  console.log(`${ACCENT(result.user.email)} ${DIM(result.user.id)}`);
}

export async function logoutCommand(opts: { origin?: string }): Promise<void> {
  const config = loadConfigFile();
  const origin = defaultOrigin(opts);
  if (config.accessToken) {
    try { await logout(origin, config.accessToken); } catch { /* local logout still clears */ }
  }
  saveConfigFile({ ...config, accessToken: undefined, tokenExpiresAt: undefined, user: undefined });
  console.log(`${OK('✓')} Logged out`);
}

function openBrowser(url: string): void {
  const command = platform() === 'darwin'
    ? 'open'
    : platform() === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = platform() === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
