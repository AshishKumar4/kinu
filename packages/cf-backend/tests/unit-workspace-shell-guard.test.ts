/**
 * What the hosted shell guard refuses, and what it leaves alone.
 *
 * The guard wraps `git`, `npm` and `npx` after Nimbus and git register them:
 * the heavy subcommands fail with exit code 2 and a pointer at the container,
 * while local subcommands still reach the original command. A missing command
 * is skipped, and `node` is never wrapped.
 */
import { describe, expect, test } from 'bun:test';
import type { Command, CommandContext } from '@nimbus-sh/core/substrate/lifo/commands/types.js';
import {
  guardHostedShell, shellGuardRefusal, type HostedShellRegistry,
} from '../src/workspace-shell-guard';

function makeRegistry(names: readonly string[]) {
  const calls = new Map<string, string[][]>();
  const commands = new Map<string, Command>();
  for (const name of names) {
    calls.set(name, []);
    commands.set(name, async (ctx: CommandContext): Promise<number> => {
      calls.get(name)?.push(ctx.args);
      return 0;
    });
  }
  const registry: HostedShellRegistry = {
    resolve: async (name: string): Promise<Command | undefined> => commands.get(name),
    register: (name: string, command: Command): void => {
      commands.set(name, command);
    },
  };
  return { registry, calls };
}

function runContext(args: string[]) {
  const lines: string[] = [];
  // SAFETY: the guard's contract reads exactly `args` and `stderr.write` off
  // its context (workspace-shell-guard.ts `refuse`/`wrapSubcommands`); this
  // fake is constructed with both, and the code under test never reaches
  // another member of Nimbus's CommandContext.
  const ctx = {
    args,
    stderr: { write: (text: string): void => { lines.push(text); } },
  } as CommandContext;
  return { ctx, stderr: lines };
}

async function run(
  registry: HostedShellRegistry,
  name: string,
  args: string[],
): Promise<{ code: number; stderr: string[] }> {
  const command = await registry.resolve(name);
  if (command === undefined) throw new Error(`missing command: ${name}`);
  const { ctx, stderr } = runContext(args);
  return { code: await command(ctx), stderr };
}

describe('workspace shell guard', () => {
  test('git clone is refused with the container redirect', async () => {
    const { registry, calls } = makeRegistry(['git', 'npm', 'npx']);
    await guardHostedShell(registry);
    const { code, stderr } = await run(registry, 'git', ['clone', 'x']);
    expect(code).toBe(2);
    expect(calls.get('git')).toEqual([]);
    expect(stderr).toEqual([
      '`git clone` is not run in the workspace shell: it needs more memory than this isolate has. Run it in the container: sandbox.exec("git clone x") — its files are visible to you under /sandbox.\n',
    ]);
  });

  test('git status still reaches the original command', async () => {
    const { registry, calls } = makeRegistry(['git', 'npm', 'npx']);
    await guardHostedShell(registry);
    const { code, stderr } = await run(registry, 'git', ['status']);
    expect(code).toBe(0);
    expect(calls.get('git')).toEqual([['status']]);
    expect(stderr).toEqual([]);
  });

  test('flags do not hide the subcommand, either way', async () => {
    const { registry, calls } = makeRegistry(['git']);
    await guardHostedShell(registry);
    const refused = await run(registry, 'git', ['--no-pager', 'fetch', 'origin']);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toEqual([
      `${shellGuardRefusal('git', 'fetch', 'git --no-pager fetch origin')}\n`,
    ]);
    const allowed = await run(registry, 'git', ['--no-pager', 'status']);
    expect(allowed.code).toBe(0);
    expect(calls.get('git')).toEqual([['--no-pager', 'status']]);
  });

  test('npm install is refused but npm run build is delegated', async () => {
    const { registry, calls } = makeRegistry(['npm']);
    await guardHostedShell(registry);
    const refused = await run(registry, 'npm', ['install']);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toEqual([
      `${shellGuardRefusal('npm', 'install', 'npm install')}\n`,
    ]);
    const allowed = await run(registry, 'npm', ['run', 'build']);
    expect(allowed.code).toBe(0);
    expect(calls.get('npm')).toEqual([['run', 'build']]);
    expect(allowed.stderr).toEqual([]);
  });

  test('npx is always refused', async () => {
    const { registry, calls } = makeRegistry(['npx']);
    await guardHostedShell(registry);
    const { code, stderr } = await run(registry, 'npx', ['foo']);
    expect(code).toBe(2);
    expect(calls.get('npx')).toEqual([]);
    expect(stderr).toEqual([
      `${shellGuardRefusal('npx', 'foo', 'npx foo')}\n`,
    ]);
  });

  test('a registry without npm is guarded without throwing', async () => {
    const { registry, calls } = makeRegistry(['git']);
    await guardHostedShell(registry);
    const { code } = await run(registry, 'git', ['status']);
    expect(code).toBe(0);
    expect(calls.get('git')).toEqual([['status']]);
    expect(await registry.resolve('npm')).toBeUndefined();
  });

  test('node stays available and unwrapped', async () => {
    const { registry, calls } = makeRegistry(['git', 'npm', 'npx', 'node']);
    const before = await registry.resolve('node');
    await guardHostedShell(registry);
    expect(await registry.resolve('node')).toBe(before);
    const { code, stderr } = await run(registry, 'node', ['--version']);
    expect(code).toBe(0);
    expect(calls.get('node')).toEqual([['--version']]);
    expect(stderr).toEqual([]);
  });
});
