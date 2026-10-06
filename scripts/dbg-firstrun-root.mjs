// Linux/Bun 1.4.2 reproduction, adapted from the 2026-09-30 measurement in
// https://github.com/oven-sh/bun/pull/40078. Run with stderr on a pipe and
// BUN_JSC_slowPathAllocsBetweenGCs=5. No timeout is used to end the wait.
import { spawnSync } from 'node:child_process';

const kind = process.argv[2];

const runToExit = kind === 'async' ? (await import('../packages/test-utils/src/spawn')).runToExit : undefined;

const runtime = new URL('../node_modules/.bin/bun', import.meta.url).pathname;

const cwd = new URL('..', import.meta.url).pathname;

const env = { ...process.env };

delete env.BUN_JSC_slowPathAllocsBetweenGCs;

const list = ['--bun', './node_modules/.bin/vitest', 'list', '--config', 'vitest.first-run.config.ts',
  '--project', 'first-run-fleet', '--filesOnly', '--json'];

const first = { cmd: ['/bin/echo', 'first'], stdout: 'pipe', stderr: 'ignore' };

globalThis.writers = [];

const refs = [];

const writes = [];

for (let index = 0; index < 3; index++) {
  const writer = Bun.stderr.writer();
  writes.push(writer.write(''), writer.flush());
  globalThis.writers.push(writer);
  refs.push(new WeakRef(writer));
}

await Promise.all(writes);

await Bun.sleep(0);

Bun.spawnSync(first);

globalThis.writers = null;

Bun.spawnSync(first);

let collectedDuringCall = 0;

for (const ref of refs) if (ref.deref() === undefined) collectedDuringCall++;

console.error(JSON.stringify({ event: 'before-list', pid: process.pid, kind, collectedDuringCall }));

if (collectedDuringCall !== 3) throw new Error('the finalizers did not run inside the synchronous wait');

let status;

let stdout;

if (kind === 'async') {
  const listed = await runToExit([runtime, ...list], { env, cwd });
  status = listed.exitCode;
  stdout = listed.stdout;
  process.stderr.write(listed.stderr);
} else {
  const listed = spawnSync(runtime, list, { env, cwd, encoding: 'utf8' });
  status = listed.status;
  stdout = listed.stdout;
  process.stderr.write(listed.stderr);
}

const files = JSON.parse(stdout);

if (status !== 0 || !Array.isArray(files) || files.length === 0) throw new Error('the exact fleet listing failed');

console.log(JSON.stringify({ event: 'after-list', pid: process.pid, kind, status, files: files.length }));
