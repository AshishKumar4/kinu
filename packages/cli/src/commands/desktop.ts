import { requireAuthConfig, resolveCloudOrigin } from '../config';
import {
  connectDevice,
  daemonStatus,
  DAEMON_LOG_PATH,
  defaultDeviceName,
  describeConnectOutcome,
  describeDeviceSandbox,
  DEVICE_CONFIG_PATH,
  DEVICE_CONNECT_DISCLOSURE,
  type ConnectDeviceResult,
} from '../device-connect';
import { readDaemonLogTail } from '../daemon-log';
import { ACCENT, DIM, ERR, OK } from '../display';
import { ask, canPrompt, confirm } from '../prompt';
import { authCommand } from './auth';
import { renderThrownChain } from '@kinu.run/core/obs';

/** What `kinu desktop logs` and a failed connect print. */
function daemonLogTail(lines: number): string {
  return readDaemonLogTail(DAEMON_LOG_PATH, lines) ?? DIM(`No daemon log at ${DAEMON_LOG_PATH}`);
}

export async function desktopCommand(action: string | undefined, opts: { label?: string }): Promise<void> {
  const sub = action ?? 'status';
  if (sub === 'connect' || sub === 'install') {
    const auth = await requireAuthOrLogin();
    const name = await confirmConnect(opts.label);
    if (!name) {
      console.log(`${DIM('Nothing was installed. This machine is not linked.')}`);
      return;
    }
    let waiting = false;
    let result: ConnectDeviceResult;
    try {
      result = await connectDevice(auth, {
        label: name,
        onWaiting: () => {
          if (!waiting) {
            process.stdout.write(DIM('Waiting for the daemon to connect'));
            waiting = true;
          }
          process.stdout.write(DIM('.'));
        },
      });
    } catch (err) {
      if (waiting) process.stdout.write('\n');
      console.error(`${ERR('✗')} ${renderThrownChain({ cause: err })}`);
      console.error(`${DIM('Daemon log tail')} (${DAEMON_LOG_PATH}):`);
      console.error(daemonLogTail(15));
      process.exit(1);
    }
    if (waiting) process.stdout.write('\n');
    if (result.kind !== 'connected') {
      console.error(`${ERR('✗')} ${describeConnectOutcome(result, false).message}`);
      process.exit(1);
    }
    console.log('');
    console.log(`${OK('✓')} Connected this machine as ${ACCENT(name)}`);
    for (const line of describeDeviceSandbox(result.sandbox)) console.log(`  ${line}`);
    console.log(`${DIM('Rename or revoke it under Account settings → Devices.')}`);
    console.log(`${DIM('Daemon log:')} ${DAEMON_LOG_PATH}`);
    console.log('');
    return;
  }
  if (sub === 'status') {
    const status = daemonStatus();
    console.log(`${DIM('Device config:')} ${status.deviceConfigPresent ? OK('present') : 'missing'} ${DIM(DEVICE_CONFIG_PATH)}`);
    console.log(`${DIM('Daemon log:')} ${status.logPresent ? OK('present') : 'missing'} ${DIM(DAEMON_LOG_PATH)}`);
    console.log(`${DIM('Daemon process:')} ${status.daemonPid ? OK(`running (pid ${status.daemonPid})`) : 'not running'}`);
    return;
  }
  if (sub === 'logs') {
    console.log(daemonLogTail(80));
    return;
  }
  throw new Error('Usage: kinu desktop [connect|status|logs]');
}

/**
 * State what linking does, take the machine's name, and require an explicit
 * yes. Installing the daemon is the moment an agent can reach this machine, so
 * it is never a side effect of typing a command: without a terminal to state
 * the terms in, this refuses instead of proceeding.
 *
 * Returns the name to register the device under, or null when the answer is no.
 */
async function confirmConnect(label?: string): Promise<string | null> {
  console.log('');
  for (const line of DEVICE_CONNECT_DISCLOSURE) console.log(`  ${DIM(line)}`);
  console.log('');
  if (!canPrompt()) {
    throw new Error(
      'Linking a machine needs a terminal. Re-run `kinu connect` from one.',
    );
  }
  const name = label?.trim() || await ask('Name this device', defaultDeviceName());
  const proceed = await confirm(`Link this machine as "${name}" and start the daemon?`, false);
  return proceed ? name : null;
}

async function requireAuthOrLogin(): Promise<{ origin: string; token: string; user?: { id: string; email: string; displayName?: string | null } }> {
  try {
    return requireAuthConfig();
  } catch (err) {
    if (!/Not authenticated/.test(renderThrownChain({ cause: err }))) throw err;
  }
  const origin = resolveCloudOrigin();
  console.log(`${DIM('Not signed in. Starting Kinu login...')}`);
  await authCommand({ origin });
  return requireAuthConfig();
}
