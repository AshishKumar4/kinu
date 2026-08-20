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
import { tolerate } from '@kinu/core/obs';

const repoRoot = resolve(__dirname, '../../..');
const cliBin = join(repoRoot, 'packages/cli/bin/cli.ts');
const homes: string[] = [];

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
    cwd: repoRoot,
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
  });
});
