/**
 * Pins the launcher's `cli/current`/`cli/prev` swap by running it as bash;
 * each home carries the running Bun at `runtime/bin/bun`, and no origin is contacted.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { scratchDir } from '@kinu.run/test-utils';
import { handleCliRequest } from '../src/cli/routes';
import { staticRouteCliEnv } from './helpers/bindings';

async function launcherScript(): Promise<string> {
  const shim = await handleCliRequest(
    new Request('https://kinu.example.com/downloads/kinu'), staticRouteCliEnv(),
  );

  if (!shim) throw new Error('the launcher route answered nothing');

  return shim.text();
}

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

/** `cli.js` prints `stamp` for --version, echoes args otherwise; `broken` exits 1. */
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

  test('a swap killed after current moved out is finished from the proven next-* tree, no download', async () => {
    // State a kill between the swap's renames leaves; the origin (port 9) answers
    // nothing, so a launch that reached for a download fails.
    const { home, launcher } = await launcherHome();
    cliTree(home, 'prev', '1.0.0+old');
    cliTree(home, 'next-4242', '2.0.0+new');

    const run = await launch(home, launcher, '--version');
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe('2.0.0+new');
    expect(readFileSync(join(home, 'cli', 'current', 'cli.js'), 'utf-8')).toContain('2.0.0+new');
    expect(existsSync(join(home, 'cli', 'next-4242'))).toBe(false);
  });

  test('a missing current with only prev beside it runs prev, no download', async () => {
    const { home, launcher } = await launcherHome();
    cliTree(home, 'prev', '1.0.0+old');

    const run = await launch(home, launcher, '--version');
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe('1.0.0+old');
    expect(readFileSync(join(home, 'cli', 'current', 'cli.js'), 'utf-8')).toContain('1.0.0+old');
    expect(existsSync(join(home, 'cli', 'prev'))).toBe(false);
  });

  test('a launcher that cannot take the tree lock runs what is installed', async () => {
    const { home, launcher } = await launcherHome();
    cliTree(home, 'current', '1.0.0+old');
    mkdirSync(join(home, 'cli', '.lock'), { recursive: true });
    writeFileSync(join(home, 'cli', '.lock', 'pid'), `${String(process.pid)}\n`);

    const run = await launch(home, launcher, '--version');
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe('1.0.0+old');
    expect(existsSync(join(home, 'cli', '.lock'))).toBe(true);
  });

  test('the launcher no longer intercepts update: the installed CLI owns it', async () => {
    const { home, launcher } = await launcherHome();
    cliTree(home, 'current', '2.0.0+new');

    const run = await launch(home, launcher, 'update', '--force');
    expect(run).toEqual({ stdout: 'ran 2.0.0+new update --force', stderr: '', exitCode: 0 });
  });
});
