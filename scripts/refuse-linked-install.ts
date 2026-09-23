/**
 * `bun install` in a worktree that `setup-worktree.sh` linked writes THROUGH
 * the links into the primary checkout's `node_modules`. Measured 2026-09-10:
 * one lane's bump left the primary on think 0.17.0 beside agents 0.20.1, and
 * every sibling's typecheck went red on lines nobody had touched.
 *
 * WHERE THE REFUSAL RUNS. Not in the root `preinstall`: measured 2026-09-23 on
 * bun 1.4.0 (`refuse-linked-install.test.ts` holds the fixture), bun saves the
 * lockfile and extracts the changed packages, through a linked scope
 * directory into the primary, before the root `preinstall` runs. Bun consults
 * the security scanner `bunfig.toml` names before it writes anything: at the
 * scan the lockfile is unwritten and every link intact, and a scanner that
 * throws cancels the install. So `scripts/security-scanner.ts` calls
 * {@link installRefusal} first thing in its `scan`.
 *
 * `bun pm scan` consults the same scanner and writes nothing, so it is the one
 * command that proceeds over linked modules: the advisory gate runs it in
 * worktrees. Bun runs the scanner in a child of the command's own process, so
 * the command is read off the parent's argv, and one nobody can read is refused.
 */
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface LinkedEntry {
  readonly name: string;
  readonly target: string;
}

/** Every `node_modules` entry of `root` that is a link resolving outside it:
 *  a write through one lands in another tree. */
export function linkedOutside(root: string): readonly LinkedEntry[] {
  const modules = join(root, 'node_modules');

  if (!existsSync(modules)) return [];
  const inside = `${realpathSync(root)}/`;

  return readdirSync(modules)
    .filter((name) => lstatSync(join(modules, name)).isSymbolicLink())
    .map((name) => {
      const literal = resolve(modules, readlinkSync(join(modules, name)));

      return { name, target: existsSync(literal) ? realpathSync(literal) : literal };
    })
    .filter(({ target }) => !target.startsWith(inside));
}

/** The bun command that spawned this process, as `ps` prints it, in words. */
function parentCommand(): readonly string[] {
  const ps = Bun.spawnSync(['ps', '-o', 'args=', '-p', String(process.ppid)], { stdout: 'pipe', stderr: 'pipe' });

  return ps.exitCode === 0 ? ps.stdout.toString().trim().split(/\s+/) : [];
}

/** Why the bun command running this scanner must not proceed in `root`, or
 *  nothing when it may: no entry links outside, or the command is `bun pm scan`. */
export function installRefusal(root: string, command: () => readonly string[] = parentCommand): string | undefined {
  const leaked = linkedOutside(root);
  const [first] = leaked;

  if (first === undefined) return undefined;
  const words = command();

  if (words[1] === 'pm' && words[2] === 'scan') return undefined;

  return `refuse-linked-install: ${String(leaked.length)} node_modules entr${leaked.length === 1 ? 'y' : 'ies'} link outside this checkout `
    + `(${first.name} -> ${first.target}), so \`${words.length > 0 ? words.join(' ') : 'an unreadable bun command'}\` `
    + 'here would write through them into another tree. Nothing was written.\n'
    + '  fix: rm -rf node_modules && bun install   (a real install for this worktree)\n'
    + '  or:  leave node_modules alone; the links already resolve to the primary\'s pinned set';
}
