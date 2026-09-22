/**
 * Guard: every workspace package must resolve inside the checkout under test, not a donor's symlinked
 * node_modules. Imported by relative path; names are read from manifests on disk.
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { parseJsonObject } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import * as v from 'valibot';

/** The one documented way to prepare a checkout that has no node_modules. */
const SETUP_COMMAND = 'bash scripts/setup-worktree.sh';

/** The checkout `from` belongs to (nearest ancestor with package.json and `packages/`), via realpath. */
function treeRoot(from: string): string {
  let dir = realpathSync(from);

  for (;;) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'packages'))) return dir;
    const parent = dirname(dir);

    if (parent === dir) throw new Error(`workspace guard: no repo root above ${from}`);
    dir = parent;
  }
}

/**
 * Workspace packages with an entry point, name → directory. The one list `scripts/bench-sandbox.ts` builds
 * links from; `setup-worktree.sh` globs the same set and is checked against this.
 */
export function workspacePackages(root: string): Map<string, string> {
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

/** Assert every workspace package resolves from `from` to the same checkout; call with `import.meta.dir`. */
export function assertWorkspaceResolution(from: string): void {
  const root = treeRoot(from);
  const problems: string[] = [];

  for (const [name, dir] of workspacePackages(root)) {
    let resolved: string;

    try {
      resolved = realpathSync(Bun.resolveSync(name, from));
    } catch (error) {
      problems.push(`  ${name}\n    does not resolve at all from ${from} (${renderThrownChain({ cause: error })})`);
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
