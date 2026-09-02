/**
 * `kinu daemon` lifecycle against a throwaway KINU_HOME. The daemon is a
 * real detached process, so these run the CLI end to end: the pidfile is the
 * daemon's own and it unlinks it on exit, which is exactly what restart has to
 * sequence correctly.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { tolerate } from '@kinu.run/core/obs';
import * as v from 'valibot';

const repoRoot = resolve(__dirname, '../../..');
const cliBin = join(repoRoot, 'packages/cli/bin/cli.ts');
const homes: string[] = [];

/** Fresh throwaway project directory per spawn: the CLI records its cwd as the agent file plane, so a spawn must never sit in the developer repo. */
function newProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kinu-test-project-'));
  homes.push(dir);
  return dir;
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    const pid = readPid(home);
    if (pid !== null) tolerate(() => process.kill(pid, 'SIGKILL'), 'esrch');
    rmSync(home, { recursive: true, force: true });
  }
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'kinu-daemon-'));
  homes.push(home);
  return home;
}

function runDaemon(home: string, action: string) {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, cliBin, 'daemon', action],
    cwd: newProjectDir(),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, KINU_HOME: home },
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function readPid(home: string): number | null {
  const pidfile = tolerate(() => readFileSync(join(home, 'daemon.pid'), 'utf-8'), 'enoent');
  if (pidfile === undefined) return null;
  const pid = Number(pidfile.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** `kill(pid, 0)` throws EPERM for a process that is alive but not ours, so
 *  only ESRCH may be read as absent. */
function isAlive(pid: number): boolean {
  return tolerate(() => { process.kill(pid, 0); return true; }, 'esrch') ?? false;
}

/** `daemon start` returns as soon as the child is spawned, so anything the
 *  daemon itself does lands a moment later. */
async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for the daemon');
    await Bun.sleep(25);
  }
}

describe('kinu daemon restart', () => {
  test('replaces a running daemon and waits for the old process to exit', () => {
    const home = makeHome();
    expect(runDaemon(home, 'start').exitCode).toBe(0);
    const before = readPid(home);
    expect(before).not.toBeNull();

    const restart = runDaemon(home, 'restart');

    expect(restart.exitCode).toBe(0);
    expect(restart.stderr).toBe('');
    expect(restart.stdout).toContain('restarted');
    const after = readPid(home);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    // The command returned only once the old daemon was actually gone, so its
    // exit could not delete the replacement's pidfile.
    expect(isAlive(before!)).toBe(false);
    expect(isAlive(after!)).toBe(true);
    expect(runDaemon(home, 'status').stdout).toContain(`running pid ${after}`);
  });

  test('starts the daemon when none is running', () => {
    const home = makeHome();

    const restart = runDaemon(home, 'restart');

    expect(restart.exitCode).toBe(0);
    expect(restart.stdout).toContain('was not running');
    const pid = readPid(home);
    expect(pid).not.toBeNull();
    expect(isAlive(pid!)).toBe(true);
  });

  test('an unknown action lists restart among the usable ones', () => {
    const proc = runDaemon(makeHome(), 'bounce');

    expect(proc.exitCode).toBe(1);
    expect(proc.stderr).toContain('start|stop|restart|status|logs|run');
  });
});

describe('kinu daemon logs', () => {
  test('caps an oversized log at startup and still shows the history', async () => {
    const home = makeHome();
    const logPath = join(home, 'daemon.log');
    writeFileSync(logPath, `${'padding line to grow the log past the cap\n'.repeat(30_000)}last line before the roll\n`);
    expect(statSync(logPath).size).toBeGreaterThan(1024 * 1024);

    expect(runDaemon(home, 'start').exitCode).toBe(0);
    // The daemon's first act is to log that it started, which is what rolls it.
    await waitFor(() => existsSync(`${logPath}.1`) && statSync(logPath).size < 1024 * 1024);

    expect(statSync(logPath).size).toBeLessThan(1024 * 1024);
    expect(statSync(`${logPath}.1`).size).toBeGreaterThan(1024 * 1024);
    const logs = runDaemon(home, 'logs');
    expect(logs.exitCode).toBe(0);
    expect(logs.stdout).toContain('last line before the roll');
    expect(logs.stdout).toContain('local scheduler daemon started');
  });
});

describe('kinu daemon stop', () => {
  test('reports the stopped pid, clears the pidfile, and is honest when nothing runs', () => {
    const home = makeHome();
    runDaemon(home, 'start');
    const pid = readPid(home)!;

    const stopped = runDaemon(home, 'stop');

    expect(stopped.exitCode).toBe(0);
    expect(stopped.stdout).toContain(`pid ${pid}`);
    expect(isAlive(pid)).toBe(false);
    expect(existsSync(join(home, 'daemon.pid'))).toBe(false);

    const again = runDaemon(home, 'stop');
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain('not running');
  // Measured 2.9 s on a box at load 66-98 (2026-09-02 sweep, foreign mutation jobs on all
  // 24 threads), where bun's default 5 s bound read red and the test is green alone. A bound
  // on a finite run, stated with its measurement, not a detector.
  }, 15_000);
});

describe('a daemon-hosted agent resolves the same profile authority as an interactive one', () => {
  /** What the scenario prints: every line the commands wrote, the authority
   *  reads the daemon-driven turn performed, and what the interactive reader
   *  resolves out of the same store. */
  const DaemonTickRun = v.object({
    printed: v.array(v.string()),
    authorityReads: v.array(v.object({ source: v.string() })),
    interactive: v.object({ model: v.string(), version: v.number() }),
  });

  /**
   * One pass of the REGISTERED daemon surface — `kinu daemon tick <agent>` —
   * over an agent `kinu create` really made, in a subprocess with its own
   * KINU_HOME: `config.ts` binds that at import, so a static import here
   * would bind the developer's own home instead of the scenario's.
   *
   * The trigger is what gives the pass work. An idle tick opens the agent and
   * converts nothing, so it resolves no profile and would prove nothing about
   * the authority; a due timer makes the daemon drive a real turn, which is
   * the moment a hosted agent reads its catalog.
   */
  function tickWithDueTrigger(home: string, project: string): v.InferOutput<typeof DaemonTickRun> {
    const script = `
      const { createRecordingLogger, setDiagnosticsSink } = await import('@kinu.run/core/obs');
      const { createCliAgent } = await import('./packages/cli/src/agent-create.ts');
      const { triggersCommand } = await import('./packages/cli/src/commands/control.ts');
      const { daemonCommand } = await import('./packages/cli/src/commands/daemon.ts');
      const { createProfileAuthorityReader, updateDefaultTier } =
        await import('./packages/cli/src/profiles.ts');

      const printed = [];
      const realLog = console.log;
      console.log = (...args) => { printed.push(args.map(String).join(' ')); };
      let payload;
      try {
        await createCliAgent({
          name: 'daemonbot',
          mode: 'local',
          purpose: 'parity',
          cwd: process.env.KINU_PROJECT,
          baseUrl: process.env.KINU_BASE_URL,
          apiKey: process.env.KINU_AUTH,
          model: process.env.KINU_MODEL,
        });
        // The catalog the daemon must resolve: what \`/model\` writes.
        await updateDefaultTier({ model: 'daemon-catalog-model' });
        // \`kinu triggers daemonbot at <now>\` — already due, so the next pass
        // converts it into a turn.
        await triggersCommand('daemonbot', 'at', String(Date.now()), {});

        const recorder = createRecordingLogger();
        setDiagnosticsSink(recorder);
        await daemonCommand('tick', 'daemonbot');
        const authorityReads = recorder.emitted
          .filter((line) => line.event === 'profile.authority_read')
          .map((line) => ({ source: line.fields.source }));

        const interactive = await createProfileAuthorityReader()();
        payload = {
          printed,
          authorityReads,
          interactive: {
            model: interactive.catalog.tiers.default.model,
            version: interactive.version,
          },
        };
      } finally {
        console.log = realLog;
      }
      console.log(JSON.stringify(payload));
    `;
    const proc = Bun.spawnSync({
      cmd: [process.execPath, '-e', script],
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        KINU_HOME: home,
        KINU_PROJECT: project,
        // No resident daemon: this scenario drives the foreground pass itself,
        // and a child daemon would race it for the driver lease.
        KINU_SKIP_DAEMON: '1',
        // An endpoint nothing connects to: creating a workspace, opening it and
        // resolving its catalog must not need the network, and this proves they
        // did not. The turn's own model call fails against it, which is fine —
        // the authority is resolved before the first token either way.
        KINU_BASE_URL: 'http://127.0.0.1:1/v1',
        KINU_AUTH: 'Bearer offline',
        KINU_MODEL: '@cf/test/model',
      },
    });
    if (proc.exitCode !== 0) {
      throw new Error(`daemon tick scenario failed (${proc.exitCode}): ${proc.stderr.toString()}`);
    }
    return v.parse(DaemonTickRun, JSON.parse(proc.stdout.toString()));
  }

  test('the daemon-driven turn resolves the CLI profile store, not the workspace bootstrap', () => {
    const run = tickWithDueTrigger(makeHome(), newProjectDir());

    // The pass ran: the daemon opened a real agent over a real bun:sqlite
    // database at a real path, through the host's own `open` seam.
    expect(run.printed.some((line) => line.includes('ticked daemonbot'))).toBe(true);

    // And the turn it drove resolved its catalog through the shared reader.
    // Only that reader reports this, so an open path that stopped supplying
    // one leaves the list empty: the session would silently fall back to the
    // workspace's own bootstrap envelope, and a role the account knows about
    // would run interactively and fail on a schedule.
    expect(run.authorityReads).toEqual([{ source: 'local' }]);

    // The store it read is the one holding this machine's catalog: the model
    // the tier edit wrote, at the version that edit created.
    expect(run.interactive).toEqual({ model: 'daemon-catalog-model', version: 1 });
  }, 30_000);
});
