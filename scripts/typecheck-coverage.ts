#!/usr/bin/env bun
/**
 * Every directory holding a test file is typechecked by some project.
 *
 * The twelfth instance of this repo's signature defect, and the reason this
 * file exists: the root `tests/` directory was typechecked by NOTHING. There
 * was no root tsconfig, and `bun run check` named eight projects — agent-utils,
 * core, compaction, cf-backend, cli-backend, cli, test-utils, and
 * scripts/tsconfig.scripts.json — not one of which included it. When it was
 * finally pointed at the project's own compiler it produced 23 errors, and they
 * were not cosmetic: `EvolutionEngine.onTurnComplete` and
 * `BuiltinToolDeps.engine` had both been deleted from the codebase while four
 * suites went on calling them. The suites had rotted, and because they also
 * skipped for want of a credential, nothing anywhere could tell.
 *
 * A `tests/tsconfig.json` existing does not fix that. A tsconfig nobody runs is
 * the same artifact class as the gate that never ran. What fixes it is this: the
 * project list is DERIVED from `bun run check` and compared against a corpus
 * DISCOVERED on disk, so adding a folder of tests that no project covers fails
 * here instead of rotting quietly for months.
 *
 * Two rules keep it honest:
 *
 *   1. BOTH SIDES MUST BE NON-EMPTY. A parse that finds no projects, or a walk
 *      that finds no test directories, would make every comparison below
 *      vacuous — the exact shape being guarded against. `assertMeasured` kills
 *      the run instead.
 *   2. THE EXCLUSION LIST IS DECLARED AND ONLY SHRINKS. `scripts/
 *      tsconfig.scripts.json` already carries five files with pre-existing type
 *      errors, documented as debt. That is the CORRECT posture, and the only
 *      difference between it and the `tests/` omission is that one was visible
 *      and bounded and the other was invisible. So exclusions here are spelled
 *      out with reasons, pinned by equality, and can never be joined by
 *      accident.
 */

import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import * as v from 'valibot';
import { assertMeasured, finding } from './gate-ratchet.ts';

const root = new URL('..', import.meta.url).pathname;

/**
 * Directories that hold test files and are deliberately typechecked by no
 * tsconfig, mapped to the reason and the runner that does cover them. Pinned by
 * equality: a new entry is a deliberate act, not a default, and a stale one
 * fails this gate.
 *
 * A Map because the lookup key is a path discovered at runtime, and because the
 * gate iterates the keys to report stale entries.
 */
export const UNTYPECHECKED_TEST_DIRS = new Map<string, string>();

/** Directories never walked: not ours, or not source. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'external', '.claude',
  'terminal-bench-2.0', 'terminal-bench-2.1', 'bench-artifacts',
]);

/** Directories containing at least one `*.test.ts`, repo-relative. */
export function testDirectories(from = root): string[] {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name));
      } else if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) {
        found.add(relative(from, dir) || '.');
      }
    }
  };
  walk(from);
  return [...found].sort();
}

/**
 * The tsconfig projects `bun run check` actually passes to `tsc -p`, following
 * `bun run <script>` references transitively.
 *
 * Parsed from package.json rather than listed here, so this gate cannot report
 * on a different list than the one that runs. Following references is not
 * pedantry: `check` runs `bun run lint`, which runs `test:anti-slop`, which is
 * the only thing that typechecks `tools/oxlint/anti-slop`. A parse that stopped
 * at `check`'s own text would have demanded an exclusion entry for a directory
 * that is in fact covered — a gate lying in the safe direction, which still
 * teaches people to add exclusions to shut it up.
 */
export function checkedProjects(
  packageJson = readFileSync(resolve(root, 'package.json'), 'utf8'),
): string[] {
  const scripts = v.parse(
    v.object({ scripts: v.record(v.string(), v.string()) }),
    JSON.parse(packageJson),
  ).scripts;

  const projects = new Set<string>();
  const visited = new Set<string>();
  const walk = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    const body = scripts[name];
    if (body === undefined) return;
    for (const match of body.matchAll(/-p\s+(\S+)/g)) {
      if (match[1] !== undefined) projects.add(match[1]);
    }
    for (const match of body.matchAll(/bun run\s+([\w:.-]+)/g)) {
      if (match[1] !== undefined) walk(match[1]);
    }
  };
  walk('check');
  return [...projects].sort();
}

/**
 * The directories a project covers.
 *
 * A project's `include` is resolved relative to the tsconfig's own directory,
 * and a project given as a directory means the tsconfig inside it. Only prefix
 * containment is needed: `include: ["src", "tests"]` covers everything beneath
 * both, and a glob like `**` / `*.ts` covers the project directory itself.
 */
export function coveredPrefixes(project: string): string[] {
  const asFile = project.endsWith('.json') ? project : join(project, 'tsconfig.json');
  const base = dirname(asFile);
  const config = v.parse(
    v.object({ include: v.optional(v.array(v.string())) }),
    JSON.parse(readFileSync(resolve(root, asFile), 'utf8')),
  );
  const include = config.include ?? ['.'];
  return include.map((pattern) => {
    // Everything up to the first glob segment is the literal prefix.
    const literal = pattern.split('/').filter((seg) => !seg.includes('*')).join('/');
    return join(base, literal);
  });
}

function main(): number {
  const dirs = testDirectories();
  const projects = checkedProjects();
  const prefixes = projects.flatMap(coveredPrefixes);

  const measured = assertMeasured('typecheck-coverage', [
    ['test directories', dirs.length],
    ['projects in `check`', projects.length],
    ['covered prefixes', prefixes.length],
  ]);

  const uncovered = dirs.filter((dir) => !UNTYPECHECKED_TEST_DIRS.has(dir)
    && !prefixes.some((prefix) => dir === prefix || dir.startsWith(`${prefix}/`)));

  const staleExclusions = [...UNTYPECHECKED_TEST_DIRS.keys()]
    .filter((dir) => !dirs.includes(dir));

  if (uncovered.length === 0 && staleExclusions.length === 0) {
    console.log(`typecheck-coverage: ok — ${measured}`);
    return 0;
  }
  for (const dir of uncovered) {
    console.error(finding({
      invariant: 'every directory holding a test file is included by a project `bun run check` runs',
      at: dir,
      found: `no project in \`check\` includes it (${projects.join(', ')})`,
      silently: 'the tests there compile against nothing, so a deleted API keeps being called '
        + 'and the rot is invisible until someone runs them — which is how four e2e suites came '
        + 'to call `EvolutionEngine.onTurnComplete` and `BuiltinToolDeps.engine` long after both '
        + 'were removed',
      fix: 'add a tsconfig covering it AND append `tsc --noEmit -p <dir>` to the `check` script — '
        + 'the tsconfig alone is a gate nobody runs. Or, if it is deliberately covered by another '
        + 'runner, declare it in UNTYPECHECKED_TEST_DIRS with that reason',
    }));
  }
  if (staleExclusions.length > 0) {
    console.error(
      `\ntypecheck-coverage: ${String(staleExclusions.length)} declared exclusion(s) hold no test `
      + 'files any more. Ratchet down — remove them from UNTYPECHECKED_TEST_DIRS:',
    );
    for (const dir of staleExclusions) console.error(`  ${dir}`);
  }
  return 1;
}

if (import.meta.main) process.exit(main());
