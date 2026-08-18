import { requireAuthConfig, resolveCloudOrigin } from '../config';
import {
  connectDevice,
  daemonStatus,
  DAEMON_LOG_PATH,
  DEVICE_CONFIG_PATH,
  DEVICE_CONNECT_DEADLINE_MS,
  readDaemonLogTail,
} from '../device-connect';
import { ACCENT, DIM, ERR, OK } from '../display';
import { authCommand } from './auth';

export async function desktopCommand(action: string | undefined, opts: { label?: string }): Promise<void> {
  const sub = action ?? 'status';
  if (sub === 'connect' || sub === 'install') {
    const auth = await requireAuthOrLogin();
    let waiting = false;
    const result = await connectDevice(auth, {
      label: opts.label,
      onPoll: () => {
        if (!waiting) {
          process.stdout.write(DIM('Waiting for the daemon to connect'));
          waiting = true;
        }
        process.stdout.write(DIM('.'));
      },
    });
    if (waiting) process.stdout.write('\n');
    if (result.kind !== 'connected') {
      const device = result.kind === 'timeout' ? ` (device ${result.deviceId})` : '';
      console.error(`${ERR('✗')} Daemon did not connect within ${DEVICE_CONNECT_DEADLINE_MS / 1000}s${device}.`);
      console.error(`${DIM('Daemon log tail')} (${DAEMON_LOG_PATH}):`);
      console.error(readDaemonLogTail(15));
      process.exit(1);
    }
    console.log('');
    console.log(`${OK('✓')} Connected this machine as ${ACCENT(opts.label ?? 'My device')}`);
    console.log(`${DIM('Daemon log:')} ${DAEMON_LOG_PATH}`);
    console.log('');
    return;
  }
  if (sub === 'status') {
    const status = daemonStatus();
    console.log(`${DIM('Device config:')} ${status.deviceConfigPresent ? OK('present') : 'missing'} ${DIM(DEVICE_CONFIG_PATH)}`);
    console.log(`${DIM('Daemon log:')} ${status.logPresent ? OK('present') : 'missing'} ${DIM(DAEMON_LOG_PATH)}`);
    console.log(`${DIM('Daemon process:')} ${status.persistentPid ? OK(`running (pid ${status.persistentPid})`) : 'not running'}`);
    return;
  }
  if (sub === 'logs') {
    if (!daemonStatus().logPresent) throw new Error(`No desktop daemon log at ${DAEMON_LOG_PATH}`);
    console.log(readDaemonLogTail(80));
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
