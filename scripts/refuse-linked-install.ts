/**
 * `bun install` in a worktree that `setup-worktree.sh` linked writes THROUGH
 * the links into the primary checkout's `node_modules`. Measured 2026-09-10:
 * one lane's bump left the primary on think 0.17.0 beside agents 0.20.1, and
 * every sibling's typecheck went red on lines nobody had touched. Bun runs the
 * root `preinstall` before it installs anything, so this is where the refusal
 * lives. Dependency-free on purpose: it runs before there is a `node_modules`.
 */
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

const here = realpathSync(process.cwd());

const modules = join(here, 'node_modules');

if (!existsSync(modules)) process.exit(0); // nothing linked yet: a real install is what is wanted

const leaked = readdirSync(modules)
  .filter((name) => !name.startsWith('.') && !name.startsWith('@'))
  .filter((name) => lstatSync(join(modules, name)).isSymbolicLink())
  .map((name) => ({ name, target: resolve(modules, readlinkSync(join(modules, name))) }))
  .filter(({ target }) => !realpathSync(target).startsWith(`${here}/`));

if (leaked.length === 0) process.exit(0);

const [first] = leaked;

console.error(
  `refuse-linked-install: ${String(leaked.length)} node_modules entr${leaked.length === 1 ? 'y' : 'ies'} link outside this checkout `
  + `(${first?.name ?? ''} -> ${first?.target ?? ''}), so an install here would rewrite another tree.\n`
  + `  fix: rm -rf node_modules && bun install   (a real install for this worktree)\n`
  + `  or:  leave node_modules alone; the links already resolve to the primary's pinned set`,
);

process.exit(1);
