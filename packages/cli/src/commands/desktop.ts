import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_HOME, requireAuthConfig } from '../config.js';
import { registerCloudDevice } from '../cloud-api.js';
import { ACCENT, DIM, OK } from '../display.js';

export async function desktopCommand(action: string | undefined, opts: { label?: string }): Promise<void> {
  const sub = action ?? 'status';
  if (sub === 'connect' || sub === 'install') {
    const auth = requireAuthConfig();
    const device = await registerCloudDevice(auth.origin, auth.token, opts.label);
    console.log('');
    console.log(DIM('Run this on the machine Proteus should use as its execution environment:'));
    console.log(ACCENT(device.installCommand));
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
