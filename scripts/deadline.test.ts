// The process-tree deadline is the hang detector on every runner path, so it
// is proved by a run that hangs: killed, named, and reported with the exit
// code the deploy wrapper reports — and a run that ends is left alone.
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { tolerate } from '@kinu.run/core/obs';
import { DEADLINE_EXIT_CODE, deadlineLine, leftoverLine, runUnderDeadline } from './deadline';
import { GATE_DEADLINE_SECONDS, LADDER, scriptDeadline } from './ladder';

const HANG = join(import.meta.dir, 'fixtures', 'deadline', 'hang.ts');

/** Whether `pid` still holds memory: gone, a zombie, or a process past releasing it on its way out holds none. */
function holdsMemory(pid: number, read = (path: string) => readFileSync(path, 'utf8')): boolean {
  const status = tolerate(() => tolerate(() => read(`/proc/${String(pid)}/status`), 'esrch'), 'enoent');

  return status !== undefined && /^VmRSS:/mu.test(status);
}

describe('a run under a deadline', () => {
  test('a run that hangs is killed at the deadline and named, with the wrapper exit code', async () => {
    const outcome = await runUnderDeadline({ argv: ['bun', HANG], seconds: 1, label: 'Hang fixture', stdio: 'pipe' });

    expect(outcome.killed).toBe(true);
    expect(outcome.exitCode).toBe(DEADLINE_EXIT_CODE);
    expect(outcome.stdout).toContain('hanging');
    expect(outcome.stderr).toContain(deadlineLine({ label: 'Hang fixture', seconds: 1 }, outcome.seconds));
  });

  // ci-0965z: the CLI suite passed 484 tests in 476 s and was killed at its 480 s bound; it was slow, not hung.
  test('a run that keeps writing outlives its bound and is not killed, whether its output is piped or passed on', async () => {
    const writes = 'for (let at = 0; at < 10; at += 1) { console.log(`result ${String(at)}`); await Bun.sleep(300); }';

    for (const stdio of ['pipe', 'inherit'] as const) {
      const outcome = await runUnderDeadline({ argv: ['bun', '-e', writes], seconds: 1, label: 'writes', stdio });

      expect(outcome).toMatchObject({ killed: false, exitCode: 0 });
      expect(outcome.seconds).toBeGreaterThan(2);
    }
  });

  test('a run that writes and then falls silent is killed its bound after its last output', async () => {
    const stalls = 'for (let at = 0; at < 8; at += 1) { console.log(`result ${String(at)}`); await Bun.sleep(300); } await new Promise(() => {});';
    const outcome = await runUnderDeadline({ argv: ['bun', '-e', stalls], seconds: 1, label: 'stalls', stdio: 'pipe' });

    expect(outcome).toMatchObject({ killed: true, exitCode: DEADLINE_EXIT_CODE });
    expect(outcome.stdout).toContain('result 7');
    expect(outcome.seconds).toBeGreaterThan(3);
  });

  test('a run that ends keeps its own exit code and is not reported as killed', async () => {
    const ok = await runUnderDeadline({ argv: ['bun', '-e', 'process.exit(0)'], seconds: 30, label: 'ends', stdio: 'pipe' });
    const failed = await runUnderDeadline({ argv: ['bun', '-e', 'process.exit(3)'], seconds: 30, label: 'fails', stdio: 'pipe' });

    expect(ok).toMatchObject({ killed: false, exitCode: 0 });
    expect(failed).toMatchObject({ killed: false, exitCode: 3 });
    expect(failed.stderr).not.toContain('KILLED');
  });

  test('a run that exits with a process of its own still running fails, naming it, and it is ended', async () => {
    // The shell exits at once; the sleep it backgrounded outlives it and holds the stdout pipe.
    const outcome = await runUnderDeadline({ argv: ['sh', '-c', 'sleep 30 & echo $!'], seconds: 30, label: 'leaves one', stdio: 'pipe' });
    const pid = Number(outcome.stdout.trim());

    expect(outcome.exitCode).toBe(1);
    // Named as it was when ended: the sleep, or, ended between its fork and its exec, the shell it was forked from.
    expect([[`${String(pid)} sleep 30`], [`${String(pid)} sh -c sleep 30 & echo $!`]]).toContainEqual([...outcome.leftovers]);
    expect(outcome.stderr).toContain(leftoverLine({ label: 'leaves one' }, outcome.leftovers));
    expect(holdsMemory(pid)).toBe(false);
  });

  // The read that CI lost the race on (bd4c10f239): the process exited between its lookup and the read.
  test('a process gone in the middle of the status read holds no memory', () => {
    const exited = (): string => { throw Object.assign(new Error('ESRCH: no such process, read'), { code: 'ESRCH' }); };

    expect(holdsMemory(process.pid, exited)).toBe(false);
  });

  test('a process the run ended before it exited is not a leftover', async () => {
    const outcome = await runUnderDeadline({ argv: ['sh', '-c', 'sleep 30 & kill $!; wait $!; exit 0'], seconds: 30, label: 'ends its own', stdio: 'pipe' });

    expect(outcome).toMatchObject({ exitCode: 0, leftovers: [] });
  });

  test('a given environment is the child\'s whole environment, and none inherits this process\'s', async () => {
    // The ladder runs a cached gate under exactly the names its key hashes;
    // an environment merged over this process's would hand the gate every
    // unkeyed ambient name. `PATH` is the one name the child needs to find bun.
    process.env.KINU_DEADLINE_PLANTED = 'ambient';
    const probe = 'process.exit(process.env.KINU_DEADLINE_PLANTED === undefined ? 0 : 1)';

    const given = await runUnderDeadline({
      argv: [process.execPath, '-e', probe], seconds: 30, label: 'given', stdio: 'pipe', env: { PATH: process.env.PATH ?? '' },
    });

    const inherited = await runUnderDeadline({ argv: [process.execPath, '-e', probe], seconds: 30, label: 'inherited', stdio: 'pipe' });
    delete process.env.KINU_DEADLINE_PLANTED;

    expect(given.exitCode).toBe(0);
    expect(inherited.exitCode).toBe(1);
  });

  test('a package script runs under its own ladder row deadline, and an unrowed one under the default', () => {
    const rows = LADDER.filter((row) => row.run.startsWith('bun run test:'));

    expect(rows.length).toBeGreaterThan(3);

    for (const row of rows) {
      expect(scriptDeadline(row.run.slice('bun run '.length)))
        .toEqual({ seconds: row.deadline?.seconds ?? GATE_DEADLINE_SECONDS, label: row.label });
    }

    expect(scriptDeadline('not-a-row')).toEqual({ seconds: GATE_DEADLINE_SECONDS, label: 'not-a-row' });
    expect(scriptDeadline(undefined).seconds).toBe(GATE_DEADLINE_SECONDS);
  });
});
