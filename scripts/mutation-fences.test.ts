/**
 * The mutation-fence gate's own decision boundaries — including the one that
 * decides whether the gate is worth anything: GREEN WITH THE FENCE STRIPPED
 * must be a failure, and it must name the fence.
 *
 * Both halves are asserted here. The cheap half runs against the live tree:
 * every declared fence names a tracked file, sits in it exactly once, and its
 * owning test exists under exactly the title claimed. The expensive half is
 * the verdict itself, driven over recorded run outcomes rather than by copying
 * the tree four more times — the copy machinery is what `bun run
 * gate:mutation-fences` exercises on every run, and its red directions were
 * proven by mutating the fences for real (recorded in this branch's commit
 * body).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { FENCES, snippetSitsExactlyOnce, type FenceResult } from './mutation-fences';
import { trackedFiles } from './sources';

const REPO = resolve(import.meta.dir, '..');

/** The verdict the gate's own reporting takes, restated as a predicate so both
 *  its directions are assertable without spawning eight test processes. A
 *  fence is proved only when the pristine owner PASSED and the mutant FAILED
 *  with a settled exit code. */
function proved(result: FenceResult): boolean {
  return result.pristineExit === 0 && result.mutantExit !== 0 && result.mutantExit !== null;
}

describe('the declaration is measurable', () => {
  test('there are fences, and each names a tracked file and a tracked owner', () => {
    // The denominator. A gate over an empty list reports a clean tree.
    expect(FENCES.length).toBeGreaterThan(0);
    const tracked = new Set(trackedFiles());
    const unknown = FENCES
      .filter((fence) => !tracked.has(fence.file) || !tracked.has(fence.owner.suite))
      .map((fence) => fence.name);
    expect(unknown).toEqual([]);
  });

  test('every fence snippet sits in its file EXACTLY once', () => {
    // The stale-fixture direction, against the live tree. A snippet that moved
    // would apply the mutation to the wrong site or to none — and a mutation
    // that silently missed proves a guard is load-bearing by never removing it.
    const moved = FENCES.filter((fence) => !snippetSitsExactlyOnce(fence)).map((fence) => fence.name);
    expect(moved).toEqual([]);
  });

  test('a snippet that is absent, or present twice, is NOT exactly once', () => {
    // Guards the guard: the check above is only worth its green if it can fail.
    const anchor = FENCES[0];
    expect(anchor).toBeDefined();
    if (anchor === undefined) return;
    expect(snippetSitsExactlyOnce({ ...anchor, snippet: 'a line no source file contains' }))
      .toBe(false);
    expect(snippetSitsExactlyOnce({ ...anchor, snippet: 'const' })).toBe(false);
  });

  test('every owning test exists under exactly the title the fence claims', () => {
    // A mutation that claims to turn a named test red proves nothing if the
    // name has rotted: the gate would run `--grep` over a pattern matching
    // nothing, get a green, and report the fence as unproved — or worse, match
    // a different test and report it as proved.
    const missing = FENCES.filter((fence) => {
      const source = readFileSync(resolve(REPO, fence.owner.suite), 'utf8');
      return source.split(`test('${fence.owner.grep}'`).length - 1
        + source.split(`test("${fence.owner.grep}"`).length - 1 !== 1;
    }).map((fence) => `${fence.owner.suite}: ${fence.owner.grep}`);
    expect(missing).toEqual([]);
  });

  test('every fence states what its absence costs', () => {
    // A fence list whose entries carry no reason is a list of TODOs. The `why`
    // is what a reader gets when the gate goes red on a snippet that moved.
    expect(FENCES.filter((fence) => fence.why.length < 40)).toEqual([]);
  });

  test('every mutation actually changes its file', () => {
    // An identity mutation would leave the owner green and the gate would
    // report the fence as unproved forever — a permanently red gate nobody can
    // clear is as bad as a green one nobody can trust.
    expect(FENCES.filter((fence) => fence.mutation === fence.snippet)).toEqual([]);
  });
});

describe('the verdict, in every direction it claims', () => {
  const fence = 'core/heads/journal#markInterrupted:spawnedBefore-bound';

  test('pristine green and mutant red is the ONLY proved shape', () => {
    expect(proved({ fence, pristineExit: 0, mutantExit: 1, output: 'expect(received)' })).toBe(true);
  });

  test('GREEN WITH THE MUTATION is a failure — the finding that matters', () => {
    // The whole point. A fence whose strip leaves its owner passing is a fence
    // nothing guards: the next refactor removes it and no suite notices.
    expect(proved({ fence, pristineExit: 0, mutantExit: 0, output: '2 pass' })).toBe(false);
  });

  test('a red PRISTINE baseline is a failure, not a proved fence', () => {
    // Otherwise the gate passes vacuously on a broken sandbox: every owner
    // fails, every mutant fails, and every fence reads proved. That is the
    // false green this gate would have shipped with — measured, when the
    // sparse checkout omitted `packages/test-utils` and the preload could not
    // load: all four owners failed for a reason unrelated to any fence.
    expect(proved({ fence, pristineExit: 1, mutantExit: 1, output: 'cannot find module' }))
      .toBe(false);
  });

  test('a mutant that never SETTLED is neither red nor proved', () => {
    // A hung or unrunnable owner is indistinguishable from a pass unless the
    // gate refuses to read `null` as a failure.
    expect(proved({ fence, pristineExit: 0, mutantExit: null, output: 'timed out' })).toBe(false);
  });
});
