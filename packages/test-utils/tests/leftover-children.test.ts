// A test file that ends with a child of its own still running fails, naming
// the child, and the child is ended (scripts/test-preload.ts). Measured
// 2026-09-24: unit-pc-agent-exec.test.ts ended with nine 30 MB exec
// supervisors running and passed. They run under the sandbox's allow-list
// environment, so only their parent can name them, while it lives.
import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tolerate } from '@kinu.run/core/obs';
import { scratchDir } from '../src/scratch';

interface FixtureRun {
  readonly exitCode: number;
  readonly stderr: string;
  readonly pid: number;
}

/** One throwaway file through the real preload: from the repository root, so bunfig.toml's preload runs. */
async function runFile(body: string): Promise<FixtureRun> {
  const dir = scratchDir('leftover-children');
  const file = join(dir, 'fixture.test.ts');
  const pidFile = join(dir, 'pid');

  writeFileSync(file, `import { test } from 'bun:test';\nimport { writeFileSync } from 'node:fs';\n`
    + `const PID_FILE = ${JSON.stringify(pidFile)};\n${body}`);
  const run = Bun.spawn(['bun', 'test', '--timeout=0', file], { cwd: join(import.meta.dir, '..', '..', '..'), stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()]);

  return { exitCode, stderr, pid: Number(readFileSync(pidFile, 'utf8').trim()) };
}

/** Whether `pid` still holds memory: gone, a zombie, or a process past releasing it on its way out holds none. */
function holdsMemory(pid: number): boolean {
  const status = tolerate(() => readFileSync(`/proc/${String(pid)}/status`, 'utf8'), 'enoent');

  return status !== undefined && /^VmRSS:/mu.test(status);
}

describe('a child a test file leaves running', () => {
  test('fails the file, naming the child, and the child is ended', async () => {
    const run = await runFile(`test('starts a server and never ends it', () => {
  writeFileSync(PID_FILE, String(Bun.spawn(['sleep', '30']).pid));
});`);

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain(`${String(run.pid)} sleep 30`);
    expect(holdsMemory(run.pid)).toBe(false);
  });

  test('is not claimed when the file ended it and waited for its exit', async () => {
    const run = await runFile(`test('ends what it started', async () => {
  const server = Bun.spawn(['sleep', '30']);
  writeFileSync(PID_FILE, String(server.pid));
  server.kill();
  await server.exited;
});`);

    expect({ exitCode: run.exitCode, stderr: run.exitCode === 0 ? '' : run.stderr }).toEqual({ exitCode: 0, stderr: '' });
    expect(holdsMemory(run.pid)).toBe(false);
  });
});
