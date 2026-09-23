// The process-tree deadline is the hang detector on every runner path, so it
// is proved by a run that hangs: killed, named, and reported with the exit
// code the deploy wrapper reports — and a run that ends is left alone.
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { DEADLINE_EXIT_CODE, deadlineLine, runUnderDeadline } from './deadline';
import { GATE_DEADLINE_SECONDS, LADDER, scriptDeadline } from './ladder';

const HANG = join(import.meta.dir, 'fixtures', 'deadline', 'hang.ts');

describe('a run under a deadline', () => {
  test('a run that hangs is killed at the deadline and named, with the wrapper exit code', async () => {
    const outcome = await runUnderDeadline({ argv: ['bun', HANG], seconds: 1, label: 'Hang fixture', stdio: 'pipe' });

    expect(outcome.killed).toBe(true);
    expect(outcome.exitCode).toBe(DEADLINE_EXIT_CODE);
    expect(outcome.stdout).toContain('hanging');
    expect(outcome.stderr).toContain(deadlineLine({ label: 'Hang fixture', seconds: 1 }, outcome.seconds));
  });

  test('a run that ends keeps its own exit code and is not reported as killed', async () => {
    const ok = await runUnderDeadline({ argv: ['bun', '-e', 'process.exit(0)'], seconds: 30, label: 'ends', stdio: 'pipe' });
    const failed = await runUnderDeadline({ argv: ['bun', '-e', 'process.exit(3)'], seconds: 30, label: 'fails', stdio: 'pipe' });

    expect(ok).toMatchObject({ killed: false, exitCode: 0 });
    expect(failed).toMatchObject({ killed: false, exitCode: 3 });
    expect(failed.stderr).not.toContain('KILLED');
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
