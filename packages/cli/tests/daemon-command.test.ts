/**
 * `proteus daemon` lifecycle against a throwaway PROTEUS_HOME. The daemon is a
 * real detached process, so these run the CLI end to end: the pidfile is the
 * daemon's own and it unlinks it on exit, which is exactly what restart has to
 * sequence correctly.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

const repoRoot = resolve(__dirname, '../../..');
const cliBin = join(repoRoot, 'packages/cli/bin/cli.ts');
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    const pid = readPid(home);
    if (pid !== null) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    rmSync(home, { recursive: true, force: true });
  }
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'proteus-daemon-'));
  homes.push(home);
  return home;
}

function runDaemon(home: string, action: string) {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, cliBin, 'daemon', action],
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, PROTEUS_HOME: home },
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function readPid(home: string): number | null {
  try {
    const pid = Number(readFileSync(join(home, 'daemon.pid'), 'utf-8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('proteus daemon restart', () => {
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

describe('proteus daemon stop', () => {
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
