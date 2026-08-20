/**
 * The corpus applicability census's own decision boundary.
 *
 * `expect(stalePatches(REPO_ROOT)).toEqual([])` over a healthy corpus is a check
 * that cannot fail, and this repo has shipped several of those. So every verdict
 * here is driven from a fixture: a patch that applies, the same patch after the
 * source moved under it, and a patch file no `tasks.jsonl` line names — which is
 * the direction only the directory walk can see and which the two enumerations
 * this census replaced never named.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '@kinu/test-utils';
import { stalePatches } from './bench-corpus';

/** The fixture's own patch list. `trackedFiles()` answers for THIS repo, so a
 *  fixture must name its files itself — see `stalePatches`. */
const PATCH_FILES = ['tests/bench/patches/pick-returns-largest.patch'];
const WITH_ORPHAN = [...PATCH_FILES, 'tests/bench/patches/nobody-measures-me.patch'];

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const SOURCE = ['export function pick(items: number[]): number {',
  '  const sorted = [...items].sort((a, b) => a - b);',
  '  return sorted[0]!;',
  '}', ''].join('\n');

/** The defect: return the largest instead of the smallest. Anchored on the
 *  three lines above it, exactly as a real corpus patch is. */
const PATCH = ['diff --git a/src/pick.ts b/src/pick.ts',
  '--- a/src/pick.ts',
  '+++ b/src/pick.ts',
  '@@ -1,4 +1,4 @@',
  ' export function pick(items: number[]): number {',
  '   const sorted = [...items].sort((a, b) => a - b);',
  '-  return sorted[0]!;',
  '+  return sorted[sorted.length - 1]!;',
  ' }', ''].join('\n');

interface FixtureOptions {
  /** Overwrite the seeded source, so the patch's context no longer matches. */
  readonly source?: string;
  /** A second patch file with no task line — an orphan. */
  readonly orphanPatch?: boolean;
}

function fixture(opts: FixtureOptions = {}): string {
  const root = scratchDir('bench-corpus-census');
  roots.push(root);
  mkdirSync(join(root, 'tests', 'bench', 'patches'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'pick.ts'), opts.source ?? SOURCE);
  writeFileSync(join(root, 'tests', 'bench', 'tasks.jsonl'), `${JSON.stringify({
    id: 'pick-returns-largest', title: 'pick returns the largest',
    prompt: 'One test fails: pick returns the wrong end of the sorted list. Fix the source.',
    suite: 'core', editable: ['src/pick.ts'],
  })}\n`);
  writeFileSync(join(root, 'tests', 'bench', 'patches', 'pick-returns-largest.patch'), PATCH);
  if (opts.orphanPatch === true) {
    writeFileSync(join(root, 'tests', 'bench', 'patches', 'nobody-measures-me.patch'), PATCH);
  }
  return root;
}

describe('stalePatches', () => {
  test('a patch whose context still matches is not stale', () => {
    expect(stalePatches(fixture(), PATCH_FILES)).toEqual([]);
  });

  // The red direction, without which the committed assertion asserts nothing.
  test('a patch whose anchor moved is stale, and carries git\'s own reason', () => {
    const moved = SOURCE.replace('const sorted', 'const ordered').replace('sorted[0]', 'ordered[0]');
    const stale = stalePatches(fixture({ source: moved }), PATCH_FILES);
    expect(stale.map((p) => p.id)).toEqual(['pick-returns-largest']);
    // Verbatim, because the line and hunk it failed on IS the re-anchor. A
    // summarised message would make the reader re-derive what git already knew.
    expect(stale[0]?.detail).toContain('patch does not apply');
    expect(stale[0]?.detail).toContain('src/pick.ts');
    expect(stale[0]?.orphan).toBe(false);
  });

  // Only the directory walk can see this: the corpus-loaded enumeration never
  // loads a file no task line names, so for it the patch does not exist.
  test('an orphan patch file is reported and labelled as one', () => {
    const stale = stalePatches(fixture({ source: 'export const gone = 1;\n', orphanPatch: true }), WITH_ORPHAN);
    expect(stale.map((p) => p.id).sort()).toEqual(['nobody-measures-me', 'pick-returns-largest']);
    expect(stale.find((p) => p.id === 'nobody-measures-me')?.orphan).toBe(true);
    expect(stale.find((p) => p.id === 'pick-returns-largest')?.orphan).toBe(false);
  });

  // An orphan that still applies is invisible to an applicability-only check, so
  // the flag has to be carried by the census rather than inferred from failure.
  test('an orphan that still applies is not reported by the census', () => {
    // The whole point of `orphan` being a FIELD rather than a second census: this
    // file is unmeasured, and the corpus test that owns that direction reads
    // tasks.jsonl against the directory rather than waiting for an apply to fail.
    expect(stalePatches(fixture({ orphanPatch: true }), WITH_ORPHAN)).toEqual([]);
  });
});
