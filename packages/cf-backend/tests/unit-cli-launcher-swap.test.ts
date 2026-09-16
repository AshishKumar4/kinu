/**
 * The launcher's swap and its launch check, run as bash against a home the
 * test built — the launcher is the one file `kinu update` rewrites, so what
 * it does to `cli/current` and `cli/prev` is pinned by running it, not by
 * reading it.
 *
 * The served script resolves Bun through the launcher's own order (a managed
 * `runtime/bin/bun` first), so each home carries the running Bun under that
 * path and the script never reaches PATH. No origin is contacted: every case
 * below has a `cli/current` to run, and the launch check downloads nothing.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { scratchDir } from '@kinu.run/test-utils';
import { handleCliRequest } from '../src/cli/routes';

async function launcherScript(): Promise<string> {
  const env: Partial<Env> = {};
  // SAFETY: the launcher route returns before reading any Worker binding.
  const shim = await handleCliRequest(new Request('https://kinu.example.com/downloads/kinu'), env as Env);

  if (!shim) throw new Error('the launcher route answered nothing');

  return shim.text();
}

/** A home with the running Bun as its managed runtime and the launcher installed. */
async function launcherHome(): Promise<{ home: string; launcher: string }> {
  const home = scratchDir('launcher-swap');
  mkdirSync(join(home, 'runtime', 'bin'), { recursive: true });
  symlinkSync(process.execPath, join(home, 'runtime', 'bin', 'bun'));
  mkdirSync(join(home, 'bin'), { recursive: true });
  const launcher = join(home, 'bin', 'kinu');
  writeFileSync(launcher, await launcherScript(), { mode: 0o755 });
  chmodSync(launcher, 0o755);

  return { home, launcher };
}

/** A CLI tree whose `cli.js` prints `stamp` for --version and echoes its
 *  arguments otherwise; `broken` makes it exit 1 on every launch. */
function cliTree(home: string, name: string, stamp: string, broken = false): string {
  const tree = join(home, 'cli', name);
  mkdirSync(tree, { recursive: true });

  writeFileSync(join(tree, 'cli.js'), broken
    ? `process.exit(1);\n`
    : `console.log(process.argv[2] === '--version' ? ${JSON.stringify(stamp)} : 'ran ' + ${JSON.stringify(stamp)} + ' ' + process.argv.slice(2).join(' '));\n`);

  return tree;
}

async function launch(home: string, launcher: string, ...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: ['bash', launcher, ...args],
    env: { HOME: home, KINU_HOME: home, PATH: '/usr/bin:/bin', KINU_ORIGIN: 'http://127.0.0.1:9' },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

describe('the launcher launch check', () => {
  test('a current that launches keeps its place and prev is dropped', async () => {
    const { home, launcher } = await launcherHome();
    cliTree(home, 'current', '2.0.0+new');
    cliTree(home, 'prev', '1.0.0+old');

    const run = await launch(home, launcher, 'list');
    expect(run).toEqual({ stdout: 'ran 2.0.0+new list', stderr: '', exitCode: 0 });
    expect(existsSync(join(home, 'cli', 'prev'))).toBe(false);
    expect(readFileSync(join(home, 'cli', 'current', 'cli.js'), 'utf-8')).toContain('2.0.0+new');
  });

  test('a current that fails its --version smoke is replaced by prev, which then runs', async () => {
    const { home, launcher } = await launcherHome();
    cliTree(home, 'current', '2.0.0+new', true);
    cliTree(home, 'prev', '1.0.0+old');

    const run = await launch(home, launcher, '--version');
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe('1.0.0+old');
    expect(run.stderr).toContain('restoring the previous one');
    expect(existsSync(join(home, 'cli', 'prev'))).toBe(false);
    expect(readFileSync(join(home, 'cli', 'current', 'cli.js'), 'utf-8')).toContain('1.0.0+old');
  });

  test('without a prev tree nothing is smoked: a broken current fails as itself', async () => {
    const { home, launcher } = await launcherHome();
    cliTree(home, 'current', '2.0.0+new', true);

    const run = await launch(home, launcher, '--version');
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toBe('');
    expect(existsSync(join(home, 'cli', 'current', 'cli.js'))).toBe(true);
  });

  test('the launcher no longer intercepts update: the installed CLI owns it', async () => {
    const { home, launcher } = await launcherHome();
    cliTree(home, 'current', '2.0.0+new');

    const run = await launch(home, launcher, 'update', '--force');
    expect(run).toEqual({ stdout: 'ran 2.0.0+new update --force', stderr: '', exitCode: 0 });
  });
});
