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
  });
});

describe('a daemon-hosted agent resolves the same profile authority as an interactive one', () => {
  /** What the parity scenario prints: whether the open path supplied an
   *  authority at all, and the default-tier model each read resolved. */
  const HostedAuthorityParity = v.object({
    supplied: v.string(),
    hostedFirst: v.object({ model: v.string(), digest: v.string() }),
    interactiveFirst: v.object({ model: v.string(), digest: v.string() }),
    hostedSecond: v.object({ model: v.string() }),
  });

  /**
   * Drives the real `openDaemonAgent` in a subprocess with its own
   * KINU_HOME: `config.ts` binds that at import, so a static import here
   * would bind the developer's own home instead of the scenario's.
   */
  function openHostedAgent(
    home: string,
    project: string,
    body: string,
  ): v.InferOutput<typeof HostedAuthorityParity> {
    const script = `
      const { mkdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { Database } = await import('bun:sqlite');
      const { createWorkspace } = await import('@kinu.run/core/identity');
      const { initWorkspaceSchema } = await import('@kinu.run/core');
      const { makeWorkspaceSchemaSql } = await import('./packages/cli-backend/src/index.ts');
      const { resolveLLMConfig } = await import('./packages/cli/src/config.ts');
      const { openDaemonAgent } = await import('./packages/cli/src/commands/daemon.ts');
      const { createProfileAuthorityReader, updateDefaultTier } =
        await import('./packages/cli/src/profiles.ts');

      const dir = join(process.env.KINU_HOME, 'daemonbot');
      mkdirSync(dir, { recursive: true });
      const dbPath = join(dir, 'agent.db');
      {
        const seed = new Database(dbPath);
        seed.exec('PRAGMA journal_mode = WAL');
        await createWorkspace(seed, { name: 'daemonbot', purpose: 'parity', llm: resolveLLMConfig() });
        initWorkspaceSchema(makeWorkspaceSchemaSql(seed));
        seed.close();
      }
      const ref = { name: 'daemonbot', cwd: process.env.KINU_PROJECT, workspaceId: 'parity' };
      const hosted = await openDaemonAgent(ref, new Database(dbPath), dbPath);
      ${body}
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
        // An endpoint nothing connects to: opening a workspace and building a
        // resolver must not need the network, and this proves it did not.
        KINU_BASE_URL: 'http://127.0.0.1:1/v1',
        KINU_AUTH: 'Bearer offline',
        KINU_MODEL: '@cf/test/model',
      },
    });
    if (proc.exitCode !== 0) {
      throw new Error(`hosted-agent scenario failed (${proc.exitCode}): ${proc.stderr.toString()}`);
    }
    return v.parse(HostedAuthorityParity, JSON.parse(proc.stdout.toString()));
  }

  test('the open path supplies the shared reader, and it stays live after a tier edit', () => {
    const parsed = openHostedAgent(makeHome(), newProjectDir(), `
      await updateDefaultTier({ model: 'daemon-first' });
      const hostedFirst = await hosted.profileAuthority?.();
      const interactiveFirst = await createProfileAuthorityReader()();
      await updateDefaultTier({ model: 'daemon-second' });
      // The SAME closure the open call returned, re-invoked the way a second
      // scheduled turn invokes it.
      const hostedSecond = await hosted.profileAuthority?.();
      console.log(JSON.stringify({
        supplied: typeof hosted.profileAuthority,
        hostedFirst: { model: hostedFirst?.catalog.tiers.default.model, digest: hostedFirst?.digest },
        interactiveFirst: { model: interactiveFirst?.catalog.tiers.default.model, digest: interactiveFirst?.digest },
        hostedSecond: { model: hostedSecond?.catalog.tiers.default.model },
      }));
    `);
    // The daemon hands its hosted agent an authority at all — without one a
    // scheduled turn resolves from the workspace bootstrap while an
    // interactive turn of the same agent resolves from the real catalog.
    expect(parsed.supplied).toBe('function');
    // And it is the same authority: identical catalog, byte for byte.
    expect(parsed.hostedFirst).toEqual(parsed.interactiveFirst);
    expect(parsed.hostedFirst.model).toBe('daemon-first');
    // Re-invoking it after an edit resolves the edit, so a long-lived daemon
    // does not pin an agent to the catalog it booted with.
    expect(parsed.hostedSecond.model).toBe('daemon-second');
  });
});
