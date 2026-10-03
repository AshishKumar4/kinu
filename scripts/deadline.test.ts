// The process-tree deadline is the hang detector on every runner path, so it
// is proved by a run that hangs: killed, named, and reported with the exit
// code the deploy wrapper reports — and a run that ends is left alone.
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createReadStream, readFileSync } from 'node:fs';
import { tolerate } from '@kinu.run/core/obs';
import { spawnTest, scratchPath } from '@kinu.run/test-utils'
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

  test('a silent run is told through its notice file before the kill, once per silent stretch', async () => {
    // Prints what it was told, once: that output restarts the silence, and the second stretch ends in the kill.
    const listens = "const { watch, readFileSync } = await import('node:fs'); const path = process.env.KINU_SILENCE_NOTICE ?? '';"
      + " const watcher = watch(path, () => { const told = readFileSync(path, 'utf8'); if (told !== '') { console.log(`told: ${told.trim()}`); watcher.close(); } });"
      + ' await new Promise(() => {});';

    const outcome = await runUnderDeadline({ argv: ['bun', '-e', listens], seconds: 1, label: 'listens', stdio: 'pipe' });

    expect(outcome).toMatchObject({ killed: true, exitCode: DEADLINE_EXIT_CODE });
    expect(outcome.stdout).toMatch(/^told: silent 0\.\d+s of 1s$/mu);
  });

  test('a run that ends keeps its own exit code and is not reported as killed', async () => {
    const ok = await runUnderDeadline({ argv: ['bun', '-e', 'process.exit(0)'], seconds: 30, label: 'ends', stdio: 'pipe' });
    const failed = await runUnderDeadline({ argv: ['bun', '-e', 'process.exit(3)'], seconds: 30, label: 'fails', stdio: 'pipe' });

    expect(ok).toMatchObject({ killed: false, exitCode: 0 });
    expect(failed).toMatchObject({ killed: false, exitCode: 3 });
    expect(failed.stderr).not.toContain('KILLED');
  });

  // A deploy's live status reads each row's last line as it comes (scripts/deploy-live.ts).
  test('a run\'s output is told as it arrives, with the stream it came on, and then its end', async () => {
    const told: string[] = [];

    const outcome = await runUnderDeadline({
      argv: [process.execPath, '-e', 'console.log("to stdout"); console.error("to stderr")'], seconds: 30, label: 'told', stdio: 'pipe',
      status: { output: (text, from) => { told.push(`${from}: ${text}`); }, ended: () => { told.push('ended'); } },
    });

    expect(outcome.exitCode).toBe(0);
    expect([told.slice(0, -1).sort(), told.at(-1)]).toEqual([['stderr: to stderr\n', 'stdout: to stdout\n'], 'ended']);
  });

  // A deploy phase's lone row: its output reaches the terminal as it comes, and the deploy's report still quotes it.
  test('a tee\'d run passes its output on as it comes and keeps it too', () => {
    const probe = `import { runUnderDeadline } from ${JSON.stringify(join(import.meta.dir, 'deadline.ts'))};\n`
      + 'const outcome = await runUnderDeadline({ argv: [process.execPath, \'-e\', \'console.log("from the row")\'], '
      + 'seconds: 30, label: \'tee\', stdio: \'tee\' });\n'
      + 'console.log(`KEPT ${JSON.stringify(outcome.stdout)}`);';

    const run = Bun.spawnSync([process.execPath, '-e', probe], { env: process.env, stdout: 'pipe', stderr: 'pipe' });

    expect(run.stdout.toString()).toBe('from the row\nKEPT "from the row\\n"\n');
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

  // Review of d35c1060fe: a child that drops the run's mark (`env -i`) and holds the output pipes kept the run open
  // for its whole life after the shell exited, with no bound watching.
  test('a process that drops the run\'s mark and holds its output is still the run\'s, and is ended', async () => {
    const outcome = await runUnderDeadline({
      argv: ['sh', '-c', 'env -i /bin/sleep 3600 & exit 0'], seconds: 1, label: 'unmarked', stdio: 'pipe',
    });

    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.leftovers.map((line) => line.replace(/^\d+ /u, ''))).toEqual(['/bin/sleep 3600']);
  });

  // The shell exits only once the holder has dropped the mark: its fork, still marked, must not be what the exit sees.
  test('a holder that left the run\'s session and dropped its mark is cut off at the bound, not waited for', async () => {
    const dropped = scratchPath('deadline-escape', 'dropped');

    const outcome = await runUnderDeadline({
      argv: ['sh', '-c', 'mkfifo "$0" || exit 1; setsid env -i sh -c \'echo > "$0"; exec /bin/sleep 30\' "$0" & read _ < "$0"; exit 0', dropped],
      seconds: 1, label: 'escaped', stdio: 'pipe',
    });

    expect(outcome).toMatchObject({ killed: true, exitCode: DEADLINE_EXIT_CODE });
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


/** A row's command that writes its pid into `fifo` once its SIGTERM handler is in, and holds the FIFO open until it
 *  ends; on SIGTERM it does `onTerm`: the shape of a run that records what it was doing when cancelled, as the eval
 *  harness does. */
function cancellable(fifo: string, onTerm: string): string[] {
  return [process.execPath, '-e', `process.on('SIGTERM', () => { ${onTerm} }); const fs = require('node:fs');`
    + ` fs.writeSync(fs.openSync(${JSON.stringify(fifo)}, 'w'), String(process.pid)); setInterval(() => {}, 1000);`];
}

/**
 * A row's FIFO, as the test reads it: `pid` once the row is ready for its SIGTERM, `ended` once it has ended, when its
 * end of the FIFO closes. Both are waits on the row itself, with no clock.
 */
type WatchedRow = { readonly fifo: string; readonly pid: Promise<number>; readonly ended: Promise<void> };

function watchRow(name: string): WatchedRow {
  const fifo = scratchPath('deadline-cancel', name);

  if (Bun.spawnSync(['mkfifo', fifo]).exitCode !== 0) throw new Error(`mkfifo ${fifo} failed`);

  // Opened on demand: the open waits for the row to open its end.
  const chunks = (async function* read() { yield* createReadStream(fifo, { encoding: 'utf8' }); })();
  const pid = chunks.next().then((first) => Number(first.value));

  return { fifo, pid, ended: pid.then(async () => { for await (const _ of chunks); }) };
}

/**
 * The ladder's part, cut to it: `rows` under the deadline at once with their output piped, as a deploy wave runs them,
 * in a process group of its own, as a terminal's foreground job is: a Ctrl-C reaches it, and not the rows, which lead
 * sessions of their own. A run asked for after its SIGINT says so if it starts.
 */
function runner(rows: readonly (readonly string[])[]) {
  const probe = `import { runUnderDeadline } from ${JSON.stringify(join(import.meta.dir, 'deadline.ts'))};\n`
    + `const rows = ${JSON.stringify(rows)};\n`
    + 'const ended = (index) => () => { require(\'node:fs\').writeSync(1, `ENDED row ${String(index)}\\n`); };\n'
    + 'const runs = rows.map((argv, index) => runUnderDeadline({ argv, seconds: 60, label: `row ${String(index)}`, stdio: \'pipe\', status: { output: () => undefined, ended: ended(index) } }));\n'
    + 'process.on(\'SIGINT\', () => { runUnderDeadline({ argv: [process.execPath, \'-e\', \'console.log("started after the cancel")\'], seconds: 60, label: \'late\', stdio: \'tee\' }).catch(() => undefined); });\n'
    + 'console.log(`RETURNED ${JSON.stringify((await Promise.all(runs)).map((outcome) => outcome.exitCode))}`);\n';

  return spawnTest([process.execPath, '-e', probe], { detached: true, stdout: 'pipe', stderr: 'pipe' });
}

describe("a runner that is cancelled, as a person's Ctrl-C or a stop of its service cancels it", () => {
  // Until 2026-10-01 the runner killed every run at once with SIGKILL, so a run that records what it was doing when
  // cancelled never did: the eval pass's trials, and what held them, were lost with it.
  test('passes each run SIGTERM and waits for it to record and end, passing on what it says, then exits 130', async () => {
    const rows = [watchRow('row-0'), watchRow('row-1')];
    const running = runner(rows.map((row, index) => cancellable(row.fifo, `setTimeout(() => { console.log('recorded ${String(index)}'); process.exit(143); }, 1000);`)));
    const pids = await Promise.all(rows.map((row) => row.pid));

    try {
      process.kill(-running.pid, 'SIGINT');
      const [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()]);

      // Every run, not the first one alone: a wave runs many, and each is a session no Ctrl-C reaches. Each end is told
      // before the exit, so a deploy's live status does not name a run that ended in its grace as still running.
      expect([code, stdout.split('\n').filter((line) => /^(recorded|ENDED)/u.test(line)).sort()], stderr)
        .toEqual([130, ['ENDED row 0', 'ENDED row 1', 'recorded 0', 'recorded 1']]);
      expect(stdout).not.toContain('RETURNED');
      expect(stdout).not.toContain('started after the cancel');
      await Promise.all(rows.map((row) => row.ended));
    } finally {
      for (const pid of pids) tolerate(() => process.kill(pid, 'SIGKILL'), 'esrch');
    }
  });

  // Its end is never told: a deploy's live status names it as still running when the runner exits.
  test('kills a run that does not end on SIGTERM once its grace has passed, and still exits', async () => {
    const row = watchRow('row-stubborn');
    const running = runner([cancellable(row.fifo, "console.log('ignored SIGTERM');")]);
    const pid = await row.pid;

    try {
      process.kill(-running.pid, 'SIGINT');
      const [code, stdout] = await Promise.all([running.exited, new Response(running.stdout).text()]);

      expect([code, stdout.trim()]).toEqual([130, 'ignored SIGTERM']);
      await row.ended;
    } finally {
      tolerate(() => process.kill(pid, 'SIGKILL'), 'esrch');
    }
  });
});
