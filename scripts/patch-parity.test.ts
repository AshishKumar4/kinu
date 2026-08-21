/**
 * The patch-parity gate, red-proven against real drift in both directions.
 *
 * A gate for this defect class is worth exactly what its red is worth, and this
 * one has to survive a specific trap: `node_modules` and the pristine cache
 * entry are BOTH derived from the same tarball, so a check written slightly
 * wrong compares the tree against itself and passes forever. So the fixtures
 * here are built from the real pristine cache and the real committed patch, and
 * then perturbed — a copy is perturbed, never a committed patch — until each of
 * the three cases the incident produced is reproduced:
 *
 *   1. the patch is MISSING a hunk the installed tree has. The incident's exact
 *      shape: an edit made in `node_modules` that no regeneration captured.
 *   2. the patch CARRIES a hunk the installed tree does not have. A patch cut
 *      from a tree that has since been reinstalled from an older one.
 *   3. a faithful patch, which must pass — the case that fails if the check is
 *      accidentally vacuous.
 *
 * Two more, because the gate's OUTPUT is load-bearing and not just its exit
 * code: a tree that was never patched at all must be classified `unpatched`
 * rather than `differ`, since the two carry opposite remedies; and a pristine
 * source that is not the one the patch was generated against must REFUSE rather
 * than blame the installed tree for a mismatch it did not cause.
 *
 * The fixture package is whichever dependency `patchedDependencies` lists first,
 * never a name typed in here — a hand-maintained mirror of that map is the
 * defect class the gate exists to close, and a test carrying one would reproduce
 * it inside the proof.
 */

import { describe, expect, test } from 'bun:test';
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git, initRepo, scratchDir } from '@kinu.run/test-utils';
import * as v from 'valibot';
import {
  BLIND_SPOTS,
  bunCacheDir,
  checkPackage,
  parsePatch,
  patchedDependencies,
  pristineTree,
  type PatchedDependency,
} from './patch-parity';

const REPO_ROOT = join(import.meta.dir, '..');
const MARKER = '// patch-parity fixture drift';

interface Fixture {
  readonly entry: PatchedDependency;
  /** A file the patch MODIFIES, as the post-image names it. */
  readonly victim: string;
  /** Root holding a patch at `entry.patch` that faithfully describes `faithful`. */
  readonly faithfulRoot: string;
  /** Root whose patch carries one hunk beyond what `faithful` contains. */
  readonly widerRoot: string;
  /** `node_modules` in which the patch applied cleanly — the honest tree. */
  readonly faithful: string;
  /** `faithful` plus an edit nothing captured. */
  readonly drifted: string;
  /** The upstream tree, never patched. */
  readonly pristineModules: string;
}

/** Write `patch` where `checkPackage` looks for it, and return the root. */
function rootWithPatch(label: string, entry: PatchedDependency, patch: string): string {
  const root = scratchDir(label);
  const target = join(root, entry.patch);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, patch);
  return root;
}

/**
 * Every tree and patch the cases need, derived once from the real cache entry.
 *
 * The perturbed PATCH is produced by `git diff` over a real repository rather
 * than by editing diff text, so it is a patch git itself would have written —
 * hand-spliced hunks would prove the parser tolerates hand-spliced hunks.
 */
function buildFixture(): Fixture {
  const entry = patchedDependencies(REPO_ROOT)[0];
  if (entry === undefined) throw new Error('package.json declares no patchedDependencies');

  const pristine = pristineTree(bunCacheDir(REPO_ROOT), entry.pkg, entry.version);
  const committed = readFileSync(join(REPO_ROOT, entry.patch), 'utf8');
  const files = parsePatch(committed);
  const modified = files.find((f) => f.from !== undefined && f.to !== undefined);
  if (modified?.to === undefined || modified.from === undefined) {
    throw new Error(`${entry.patch} modifies no existing file, so it cannot exercise drift`);
  }

  // A repository holding the upstream bytes of exactly the files the patch names.
  const repo = scratchDir('patch-parity-repo');
  for (const file of files) {
    if (file.from === undefined) continue;
    const target = join(repo, file.from);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(pristine, file.from), target);
  }
  const pristineModules = scratchDir('patch-parity-pristine');
  cpSync(repo, join(pristineModules, entry.pkg), { recursive: true });

  initRepo(repo);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'pristine');

  git(repo, 'apply', join(REPO_ROOT, entry.patch));
  const faithfulPatch = git(repo, 'diff');
  const faithful = scratchDir('patch-parity-faithful');
  cpSync(repo, join(faithful, entry.pkg), { recursive: true, filter: (s) => !s.includes('/.git') });

  // One hunk beyond the faithful tree, captured as a patch git wrote.
  appendFileSync(join(repo, modified.to), `\n${MARKER}\n`);
  const widerPatch = git(repo, 'diff');

  const drifted = scratchDir('patch-parity-drifted');
  cpSync(faithful, drifted, { recursive: true });
  appendFileSync(join(drifted, entry.pkg, modified.to), `\n${MARKER}\n`);

  return {
    entry,
    victim: modified.to,
    faithfulRoot: rootWithPatch('patch-parity-root', entry, faithfulPatch),
    widerRoot: rootWithPatch('patch-parity-wider', entry, widerPatch),
    faithful,
    drifted,
    pristineModules,
  };
}

const fixture = buildFixture();
const cache = bunCacheDir(REPO_ROOT);

describe('patch-parity — the governed set comes from package.json', () => {
  test('every declared patch exists and the set is not empty', () => {
    const declared = patchedDependencies(REPO_ROOT);
    expect(declared.length).toBeGreaterThan(0);
    for (const entry of declared) {
      expect(Bun.file(join(REPO_ROOT, entry.patch)).size).toBeGreaterThan(0);
      expect(entry.version).toMatch(/^\d/);
    }
  });

  test('the map is read, not mirrored — the keys match package.json exactly', () => {
    const manifest = v.parse(
      v.object({ patchedDependencies: v.record(v.string(), v.string()) }),
      JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')),
    );
    const read = patchedDependencies(REPO_ROOT).map((e) => `${e.pkg}@${e.version}`).sort();
    expect(read).toEqual(Object.keys(manifest.patchedDependencies).sort());
  });
});

describe('patch-parity — red-proven in both directions', () => {
  test('a faithful patch over the tree it describes PASSES', () => {
    const report = checkPackage(fixture.entry, cache, fixture.faithful, fixture.faithfulRoot);

    expect(report.refusal).toBeUndefined();
    expect(report.findings).toEqual([]);
    expect(report.compared).toBeGreaterThan(0);
    expect(report.matching).toBe(report.compared);
  });

  test('a patch MISSING a hunk node_modules has FAILS — the incident shape', () => {
    const report = checkPackage(fixture.entry, cache, fixture.drifted, fixture.faithfulRoot);

    expect(report.refusal).toBeUndefined();
    expect(report.findings.map((f) => f.path)).toEqual([fixture.victim]);
    expect(report.findings[0]?.state).toBe('differ');
    expect(report.findings[0]?.sample.join('\n')).toContain(MARKER);
    expect(report.matching).toBe(report.compared - 1);
  });

  test('a patch CARRYING a hunk node_modules lacks FAILS', () => {
    const report = checkPackage(fixture.entry, cache, fixture.faithful, fixture.widerRoot);

    expect(report.refusal).toBeUndefined();
    expect(report.findings.map((f) => f.path)).toEqual([fixture.victim]);
    expect(report.findings[0]?.state).toBe('differ');
    expect(report.findings[0]?.sample.join('\n')).toContain(MARKER);
  });
});

describe('patch-parity — the verdict names the remedy', () => {
  test('a tree that was never patched reads as unpatched, not as arbitrary drift', () => {
    const report = checkPackage(
      fixture.entry, cache, fixture.pristineModules, fixture.faithfulRoot,
    );

    expect(report.refusal).toBeUndefined();
    expect(report.findings.length).toBeGreaterThan(0);
    // Every finding is the SAME direction: the patch never reached this tree.
    // Filtered rather than deduplicated so a failure prints the offenders.
    expect(report.findings.filter((f) => f.state !== 'unpatched')).toEqual([]);
  });

  test('a pristine source the patch was not generated against REFUSES rather than blames', () => {
    // A cache whose entry is named exactly as bun names one, holding bytes that
    // are not the ones the patch declares. Without this refusal the mismatch
    // reads as installed-tree drift and sends the reader to the wrong file.
    const fakeCache = scratchDir('patch-parity-cache');
    const slash = fixture.entry.pkg.indexOf('/');
    const parent = join(fakeCache, fixture.entry.pkg.slice(0, slash));
    const entryDir = join(parent, `${fixture.entry.pkg.slice(slash + 1)}@${fixture.entry.version}@@@1`);
    cpSync(join(fixture.pristineModules, fixture.entry.pkg), entryDir, { recursive: true });
    appendFileSync(join(entryDir, fixture.victim), `\n${MARKER}\n`);

    const report = checkPackage(
      fixture.entry, fakeCache, fixture.faithful, fixture.faithfulRoot,
    );

    expect(report.refusal?.reason).toBe('pristine_mismatch');
    expect(report.refusal?.error).toContain(fixture.victim);
    expect(report.findings).toEqual([]);
  });

  test('a missing pristine tree refuses rather than reporting a vacuous pass', () => {
    const report = checkPackage(
      fixture.entry, scratchDir('patch-parity-empty'), fixture.faithful, fixture.faithfulRoot,
    );

    expect(report.refusal?.reason).toBe('pristine_missing');
    expect(report.compared).toBe(0);
  });
});

describe('patch-parity — the blind spots are stated', () => {
  test('the green path names what the gate does not cover', () => {
    expect(BLIND_SPOTS.length).toBeGreaterThan(0);
    // The three the reader most needs, because each has already been mistaken
    // for coverage: untouched files, the shared node_modules, and correctness.
    expect(BLIND_SPOTS.join(' ')).toContain('does NOT touch');
    expect(BLIND_SPOTS.join(' ')).toContain('setup-worktree.sh');
  });
});
