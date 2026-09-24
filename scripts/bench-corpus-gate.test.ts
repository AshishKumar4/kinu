/**
 * The corpus census's own decision boundaries.
 *
 * `expect(stalePatches(REPO_ROOT)).toEqual([])` over a healthy corpus is a check
 * that cannot fail, and this repo has shipped several of those. So every verdict
 * here is driven from a fixture: a patch that applies, the same patch after the
 * source moved under it, a patch file no `tasks.jsonl` line names, and a task
 * whose patch the tracked list lacks.
 */
import { describe, test, expect } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';
import { corpusMembership, stalePatches } from './bench-corpus';

/** The fixture's own patch list. A fixture has no git index, so it
 *  names its files itself — see `stalePatches`. */
const PATCH_FILES = ['bench/corpus/patches/pick-returns-largest.patch'];

const WITH_ORPHAN = [...PATCH_FILES, 'bench/corpus/patches/nobody-measures-me.patch'];

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
  mkdirSync(join(root, 'bench', 'corpus', 'patches'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'pick.ts'), opts.source ?? SOURCE);
  writeFileSync(join(root, 'bench', 'corpus', 'tasks.jsonl'), `${JSON.stringify({
    id: 'pick-returns-largest', title: 'pick returns the largest',
    prompt: 'One test fails: pick returns the wrong end of the sorted list. Fix the source.',
    suite: 'core', editable: ['src/pick.ts'],
  })}\n`);
  writeFileSync(join(root, 'bench', 'corpus', 'patches', 'pick-returns-largest.patch'), PATCH);

  if (opts.orphanPatch === true) {
    writeFileSync(join(root, 'bench', 'corpus', 'patches', 'nobody-measures-me.patch'), PATCH);
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
  });
});

// The gate prints one count; these are the two ways it can overstate or
// understate the corpus while every listed patch still applies.
describe('corpusMembership', () => {
  test('one tracked patch per task is a match', () => {
    expect(corpusMembership(fixture(), PATCH_FILES)).toEqual({ tasks: 1, orphans: [], unchecked: [] });
  });

  test('an orphan patch that still applies is reported', () => {
    expect(corpusMembership(fixture({ orphanPatch: true }), WITH_ORPHAN).orphans)
      .toEqual(['bench/corpus/patches/nobody-measures-me.patch']);
  });

  // On disk, so `loadBenchCorpus` is satisfied here and throws on a fresh clone.
  test('a task whose patch is untracked is reported', () => {
    expect(corpusMembership(fixture(), []).unchecked).toEqual(['pick-returns-largest']);
  });
});
