// A process's first /proc read is not its last: one can exit while it is being identified, while another is only
// between fork and exec. The same first empty cmdline must not turn either outcome into the other.
import fs from 'node:fs';
import { mock } from 'bun:test';
import { endChildren, endLeftovers, RUN_MARK } from '../../deadline';

const [caller, mode] = process.argv.slice(2);

if (!['children', 'marked'].includes(caller ?? '') || !['exiting', 'live', 'exec'].includes(mode ?? '')) throw new Error('invalid lifecycle fixture');

const mark = `identified-child-${process.pid}`;

const child = Bun.spawn([process.execPath, '-e', "process.stdin.resume(); process.stdout.write('ready\\n');"], {
  stdin: 'pipe', stdout: 'pipe', stderr: 'inherit', env: { ...process.env, [RUN_MARK]: mark },
});

const reader = child.stdout.getReader();

await reader.read();

reader.releaseLock();

const read = fs.readFileSync;

let intercepted = false;

const readAtBoundary = function (...args: Parameters<typeof fs.readFileSync>) {
  if ((!intercepted || mode === 'exec') && String(args[0]) === `/proc/${child.pid}/cmdline`) {
    intercepted = true;

    // The lookup has already found a live, owned PID. At the next read it is either ending or still executing.
    // `exec` keeps its arguments unreadable through the detector's existing settle bound; no test owns that clock.
    // `exiting` is gone (a zombie this blocked loop cannot reap) before the read returns: a SIGTERM the child had
    // not yet acted on let a loaded machine read it as live and end it (armada, batch 58).
    if (mode === 'exiting') {
      child.kill('SIGKILL');

      while (fs.existsSync(`/proc/${child.pid}`) && !/\) Z /u.test(read(`/proc/${child.pid}/stat`, 'utf8'))) Bun.sleepSync(1);
    }

    return '';
  }

  return read(...args);
};

await mock.module('node:fs', () => ({ ...fs, readFileSync: readAtBoundary }));

let left: string[];

try {
  left = caller === 'children' ? await endChildren(process.pid) : await endLeftovers(mark);
} finally {
  child.kill();
  await child.exited;
}

const expected = mode === 'exiting' ? 0 : 1;

const correct = intercepted && left.length === expected && (expected === 0 || left[0]?.startsWith(`${child.pid} `));

console.log(JSON.stringify({ caller, mode, intercepted, left, expected, correct }));

if (!correct) process.exitCode = 1;
