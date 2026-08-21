/**
 * The workspace-resolution guard: a workspace package must resolve INSIDE the
 * checkout being tested.
 *
 * This has broken silently three times, always the same way. A tree with no
 * node_modules of its own borrows one wholesale — `ln -s` the directory, a bind
 * mount, a copied sandbox image — and every entry inside it resolves through the
 * DONOR's path, the workspace scope included. `<scope>/core` is then the donor's
 * core: the suite runs, passes, and measures a tree nobody edited. It cost us a
 * bench run in which solver edits were graded as if they had never been made,
 * the harbor adapter, and a week of agent worktrees.
 *
 * Nothing about that failure is loud on its own — the imports work, the tests
 * are green — so this makes it loud. Every package's suite calls it, and the
 * message names the fix.
 *
 * Reached from those suites by RELATIVE path, never through the workspace scope
 * itself: a guard imported through that scope cannot report that the scope is
 * wrong.
 *
 * Every name here is READ from the manifests on disk. Writing the scope down
 * would put this file's own copy of it one rename behind the packages it
 * checks — and a guard that checks the wrong name passes, which is the exact
 * failure it exists to make loud.
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { parseJsonObject } from '@kinu.run/core';
import * as v from 'valibot';

/** The one documented way to prepare a checkout that has no node_modules. */
const SETUP_COMMAND = 'bash scripts/setup-worktree.sh';

/** The checkout `from` belongs to — the nearest ancestor holding both a root
 *  package.json and `packages/`. Resolved through realpath so a tree reached by
 *  a symlinked path still compares equal to what module resolution reports. */
function treeRoot(from: string): string {
  let dir = realpathSync(from);
  for (;;) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'packages'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`workspace guard: no repo root above ${from}`);
    dir = parent;
  }
}

/** Every workspace package that has an entry point to resolve, name → directory.
 *  A bin-only package (the CLI) has none and is not a resolution target. */
function workspacePackages(root: string): Map<string, string> {
  const packages = new Map<string, string>();
  for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, 'packages', entry.name);
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = parseJsonObject(readFileSync(manifestPath, 'utf8'));
    const name = v.safeParse(v.string(), manifest.name);
    const main = v.safeParse(v.string(), manifest.main);
    if (!name.success || (!main.success && manifest.exports === undefined)) continue;
    packages.set(name.output, dir);
  }
  return packages;
}

/**
 * Assert that every workspace package resolves, from `from`, to that same
 * checkout's copy. Throws with the diagnosis and the fix. Call it with
 * `import.meta.dir` from a test inside the package whose resolution you mean.
 */
export function assertWorkspaceResolution(from: string): void {
  const root = treeRoot(from);
  const problems: string[] = [];
  for (const [name, dir] of workspacePackages(root)) {
    let resolved: string;
    try {
      resolved = realpathSync(Bun.resolveSync(name, from));
    } catch {
      problems.push(`  ${name}\n    does not resolve at all from ${from}`);
      continue;
    }
    const expected = realpathSync(dir) + sep;
    if (!resolved.startsWith(expected)) {
      problems.push(`  ${name}\n    resolves to ${resolved}\n    expected  ${expected}...`);
    }
  }
  if (problems.length === 0) return;
  const scopes = [...new Set([...workspacePackages(root).keys()]
    .filter((name) => name.startsWith('@'))
    .map((name) => name.slice(0, name.indexOf('/'))))].sort();
  const scope = scopes.length === 1 ? `${scopes[0]}/*` : 'a workspace package';
  throw new Error(
    `${scope} does not resolve inside this checkout (${root}):\n\n${problems.join('\n')}\n\n`
    + 'This tree\'s node_modules points at another checkout, so the suite is exercising THAT\n'
    + 'tree\'s source and every change under test is invisible. Prepare this checkout with:\n\n'
    + `    ${SETUP_COMMAND}\n\n`
    + 'Never symlink or copy a whole node_modules directory into a worktree: its workspace\n'
    + 'entries are relative to the donor, which is precisely how they end up back there.',
  );
}
