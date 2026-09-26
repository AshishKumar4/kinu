// A process of this user whose environment the kernel still refuses to read: it holds a capability its reader
// lacks. The user manager holds CAP_WAKE_ALARM and grants it to a unit that asks, so this suite needs a user
// systemd that can. Its ladder row says so, and CI, whose runner's user manager starts no such unit, never runs it.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runToExit } from '@kinu.run/test-utils';
import { runUnderDeadline } from './deadline';

/** CAP_WAKE_ALARM's bit in a capability mask (linux/capability.h). */
const CAP_WAKE_ALARM = 35n;

/** Whether `pid`'s effective capability set holds CAP_WAKE_ALARM, read off its status file. */
function holdsWakeAlarm(pid: number): boolean {
  const mask = /^CapEff:\s*([0-9a-f]+)$/mu.exec(readFileSync(`/proc/${String(pid)}/status`, 'utf8'))?.[1];

  if (mask === undefined) throw new Error(`/proc/${String(pid)}/status names no CapEff`);

  return ((BigInt(`0x${mask}`) >> CAP_WAKE_ALARM) & 1n) === 1n;
}

/** A property of a user unit, as `systemctl --user show` prints it. */
async function unitProperty(unit: string, property: string): Promise<string> {
  return (await runToExit(['systemctl', '--user', 'show', `--property=${property}`, '--value', unit])).stdout.trim();
}

test('a run beside a process of this user that holds a capability it lacks still ends, and that process is left', async () => {
  const unit = `kinu-deadline-capability-${String(process.pid)}`;

  // `Type=exec`: the start returns once `sleep` has been executed, so the process read below holds what its unit
  // grants it, never what the manager's own fork still carries between fork and exec.
  const started = await runToExit([
    'systemd-run', '--user', '--quiet', '--collect', `--unit=${unit}`, '-p', 'Type=exec', '-p', 'AmbientCapabilities=CAP_WAKE_ALARM', 'sleep', '60',
  ]);

  try {
    // The subject first: a running unit whose process holds the capability. A machine that cannot make one fails
    // here, loudly, rather than proving nothing green.
    expect(started.exitCode).toBe(0);
    expect(await unitProperty(unit, 'ActiveState')).toBe('active');
    expect(holdsWakeAlarm(Number(await unitProperty(unit, 'MainPID')))).toBe(true);

    const outcome = await runUnderDeadline({ argv: ['bun', '-e', 'process.exit(0)'], seconds: 30, label: 'beside a capability', stdio: 'pipe' });

    expect(outcome).toMatchObject({ killed: false, exitCode: 0, leftovers: [] });
    expect(await unitProperty(unit, 'ActiveState')).toBe('active');
  } finally {
    await runToExit(['systemctl', '--user', 'stop', unit]);
  }
});
