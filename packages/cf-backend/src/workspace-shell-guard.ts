/**
 * Keep the hosted workspace shell inside the memory its isolate has.
 *
 * The shell runs in the OrchestratorAgent Durable Object isolate, whose memory
 * (`worker.isolate.memory` in `core/src/platform-catalog.ts`) is shared
 * with the agent loop and every facet. Network git commands (isomorphic-git in
 * JS) and npm installs (tarball download plus extract into the SQLite VFS) are
 * what exhausted that isolate, so the guard wraps those commands after Nimbus
 * and git register them and refuses the heavy subcommands. The container
 * sandbox (`sandbox.*`) has real git, npm and node with its own memory, so the
 * refusal points there. `node` and every other command stay as they are.
 */

import type { Command, CommandContext } from '@nimbus-sh/core/substrate/lifo/commands/types.js';

/** The registry surface the guard needs, so tests can pass a fake. */
export interface HostedShellRegistry {
  resolve(name: string): Promise<Command | undefined>;
  register(name: string, command: Command): void;
}

/** Git subcommands that download or serve packs instead of touching local history. */
const GIT_BLOCKED = {
  clone: true,
  fetch: true,
  pull: true,
  push: true,
  submodule: true,
  lfs: true,
} satisfies Record<string, true>;

/** Npm subcommands that fetch or link packages instead of running local scripts. */
const NPM_BLOCKED = {
  install: true,
  i: true,
  add: true,
  ci: true,
  update: true,
  up: true,
  exec: true,
  x: true,
  link: true,
  rebuild: true,
} satisfies Record<string, true>;

/** First positional word of the argument list: flags never name the subcommand. */
function firstPositional(args: readonly string[]): string | undefined {
  return args.find((arg) => !arg.startsWith('-'));
}

/** The refusal line the shell prints for a command the isolate cannot afford. */
export function shellGuardRefusal(
  command: string,
  subcommand: string | undefined,
  originalLine: string,
): string {
  const target = subcommand === undefined || subcommand === '' ? command : `${command} ${subcommand}`;
  return `\`${target}\` is not run in the workspace shell: it needs more memory than this isolate has. Run it in the container: sandbox.exec("${originalLine}") — its files are visible to you under /sandbox.`;
}

function refuse(command: string, subcommand: string | undefined, ctx: CommandContext): number {
  ctx.stderr.write(`${shellGuardRefusal(command, subcommand, [command, ...ctx.args].join(' '))}\n`);
  return 2;
}

function wrapSubcommands(
  registry: HostedShellRegistry,
  name: 'git' | 'npm',
  blocked: Readonly<Record<string, true>>,
  original: Command,
): void {
  registry.register(name, async (ctx: CommandContext): Promise<number> => {
    const subcommand = firstPositional(ctx.args);
    if (subcommand !== undefined && Object.hasOwn(blocked, subcommand)) {
      return refuse(name, subcommand, ctx);
    }
    return original(ctx);
  });
}

/** Wrap the heavy `git`/`npm`/`npx` commands; leave everything else alone. */
export async function guardHostedShell(registry: HostedShellRegistry): Promise<void> {
  const git = await registry.resolve('git');
  if (git !== undefined) {
    wrapSubcommands(registry, 'git', GIT_BLOCKED, git);
  }
  const npm = await registry.resolve('npm');
  if (npm !== undefined) {
    wrapSubcommands(registry, 'npm', NPM_BLOCKED, npm);
  }
  const npx = await registry.resolve('npx');
  if (npx !== undefined) {
    registry.register('npx', async (ctx: CommandContext): Promise<number> =>
      refuse('npx', firstPositional(ctx.args), ctx));
  }
}
