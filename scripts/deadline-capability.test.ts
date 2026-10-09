// A same-uid process holding a capability its reader lacks: prepare grants it to a copy of sleep, and the kernel
// refuses its environ read. The suite checks the capability before claiming anything about the leftover scan.
// Armada medium, 2026-10-09 (20261009201112-97443639): real uid 1001, CapEff 0x2000, environ EACCES.
// The detached control was fully sampled at 20261009202753-2aa17ed7, without a sampler permission exemption.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { tolerate } from '@kinu.run/core/obs';
import { isRunning, runToExit } from '@kinu.run/test-utils';
import { runUnderDeadline } from './deadline';

const SUBJECT_CAPABILITY = /^subject_capability=(cap_[a-z_]+)$/mu.exec(readFileSync(new URL('./armada/setup.sh', import.meta.url), 'utf8'))?.[1];

/** Decode the kernel's effective capability mask with libcap, whose prepare-time name grants the subject's bit. */
async function holdsCapability(pid: number): Promise<boolean> {
  if (SUBJECT_CAPABILITY === undefined) throw new Error('armada setup names no subject_capability');
  const mask = /^CapEff:\s*([0-9a-f]+)$/mu.exec(readFileSync(`/proc/${String(pid)}/status`, 'utf8'))?.[1];

  if (mask === undefined) throw new Error(`/proc/${String(pid)}/status names no CapEff`);

  const decoded = await runToExit(['/usr/sbin/capsh', `--decode=0x${mask}`]);

  if (decoded.exitCode !== 0) throw new Error(`capsh failed: ${decoded.stderr}`);

  return decoded.stdout.split('=')[1]?.trim().split(',').includes(SUBJECT_CAPABILITY) === true;
}

test('a run beside a process of this user that holds a capability it lacks still ends, and that process is left', async () => {
  // An unrelated process, not a descendant whose unreadable smaps would make the row's cost unmeasurable.
  const started = await runToExit([process.execPath, '-e', `
import { spawn } from 'node:child_process';
const subject = spawn('/usr/local/bin/kinu-cap-subject', ['300'], { detached: true, stdio: 'ignore' });
console.log(subject.pid);
subject.unref();
`]);

  const pid = Number(started.stdout.trim());

  if (started.exitCode !== 0 || !Number.isSafeInteger(pid) || pid <= 1) throw new Error(`capability subject did not start: ${started.stderr}`);

  try {
    expect(await holdsCapability(pid)).toBe(true);
    const status = readFileSync(`/proc/${String(pid)}/status`, 'utf8');
    const uid = /^Uid:\s*(\d+)/mu.exec(status)?.[1];

    expect(uid).toBe(String(process.getuid?.()));
    expect(/^PPid:\s*(\d+)/mu.exec(status)?.[1]).toBe('1');
    expect(await holdsCapability(process.pid)).toBe(false);
    expect(tolerate(() => readFileSync(`/proc/${String(pid)}/environ`), 'eacces')).toBeUndefined();

    const outcome = await runUnderDeadline({ argv: ['bun', '-e', 'process.exit(0)'], seconds: 30, label: 'beside a capability', stdio: 'pipe' });

    expect(outcome).toMatchObject({ killed: false, exitCode: 0, leftovers: [] });
    expect(await holdsCapability(pid)).toBe(true);
  } finally {
    tolerate(() => process.kill(pid, 'SIGKILL'), 'esrch');
    const waited = await runToExit(['pidwait', '-F', '/dev/stdin'], { stdin: String(pid) });

    expect(waited.exitCode === 0 || waited.exitCode === 1).toBe(true);
    expect(isRunning(pid)).toBe(false);
  }
});
