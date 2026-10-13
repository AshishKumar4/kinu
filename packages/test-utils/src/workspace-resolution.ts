/**
 * Guard: every workspace package must resolve inside the checkout under test, not a donor's symlinked
 * node_modules. Imported by relative path; names are read from manifests on disk.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { parseJsonObject } from '@kinu.run/core';
import { Cause, Effect } from 'effect';
import { renderThrownChain, settleSync } from '@kinu.run/core/obs';
import * as v from 'valibot';

/** The one documented way to prepare a checkout that has no node_modules. */
const SETUP_COMMAND = 'bash scripts/setup-worktree.sh';

/** The checkout `from` belongs to (nearest ancestor with package.json and `packages/`), via realpath. */
function treeRoot(from: string): Effect.Effect<string> {
  return Effect.suspend(() => {
    let dir = realpathSync(from);

    for (;;) {
      if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'packages'))) return Effect.succeed(dir);
      const parent = dirname(dir);

      if (parent === dir) return Effect.die(new Error(`workspace guard: no repo root above ${from}`));
      dir = parent;
    }
  });
}

/**
 * Workspace packages with an entry point, name → directory, from the root manifest's `workspaces` globs as
 * `setup-worktree.sh` reads them: the vendored `@mossaic/sdk` lives outside `packages/`, and a list read from
 * `packages/` alone left it linked into a donor. The one list `scripts/bench-sandbox.ts` builds links from.
 */
export function workspacePackages(root: string): Map<string, string> {
  const packages = new Map<string, string>();
  const globs = v.parse(v.object({ workspaces: v.array(v.string()) }), parseJsonObject(readFileSync(join(root, 'package.json'), 'utf8'))).workspaces;
  const manifests = new Set(globs.flatMap((glob) => [...new Bun.Glob(`${glob}/package.json`).scanSync({ cwd: root })]));

  for (const manifestFile of [...manifests].sort()) {
    const dir = join(root, dirname(manifestFile));
    const manifest = parseJsonObject(readFileSync(join(root, manifestFile), 'utf8'));
    const name = v.safeParse(v.string(), manifest.name);
    const main = v.safeParse(v.string(), manifest.main);

    if (!name.success || (!main.success && manifest.exports === undefined)) continue;
    packages.set(name.output, dir);
  }

  return packages;
}

/** Assert every workspace package resolves from `from` to the same checkout; call with `import.meta.dir`. */
export function assertWorkspaceResolution(from: string): void {
  return settleSync(Effect.gen(function* () {
    const root = yield* treeRoot(from);
    const problems: string[] = [];

    for (const [name, dir] of workspacePackages(root)) {
      const resolved = yield* Effect.catchCause(Effect.sync((): string | null => realpathSync(Bun.resolveSync(name, from))), (failed) => Effect.sync(() => {
        problems.push(`  ${name}\n    does not resolve at all from ${from} (${renderThrownChain({ cause: Cause.squash(failed) })})`);

        return null;
      }));

      if (resolved === null) continue;

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

    return yield* Effect.die(new Error(
      `${scope} does not resolve inside this checkout (${root}):\n\n${problems.join('\n')}\n\n`
      + 'This tree\'s node_modules points at another checkout, so the suite is exercising THAT\n'
      + 'tree\'s source and every change under test is invisible. Prepare this checkout with:\n\n'
      + `    ${SETUP_COMMAND}\n\n`
      + 'Never symlink or copy a whole node_modules directory into a worktree: its workspace\n'
      + 'entries are relative to the donor, which is precisely how they end up back there.',
    ));
  }));
}
