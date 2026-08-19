/**
 * Every committed patch reproduces the `node_modules` the tests actually ran against.
 *
 * THE DEFECT. A patch to `@nimbus-sh/core` was regenerated BEFORE its `.d.ts`
 * hunks were written, so a fresh install restored undeclared type files and
 * `bun run check` failed with `confinePrincipal does not exist on type
 * SqliteVFS`. Every local instrument read GREEN anyway: `bun run check`
 * typechecked against a `node_modules` that already held the edits, and the
 * runtime parity test read `dist/*.js` and says nothing about declarations.
 * Both instruments were measuring a tree the patch did not describe. Four
 * dependencies are patched, so this is not one branch's accident — it is the
 * substrate every other green result in this repository stands on.
 *
 * THE MECHANISM, established by experiment on bun 1.3.14, 2026-08-18, not
 * assumed:
 *
 *   - `bun pm cache` prints the cache root (`~/.bun/install/cache` here).
 *   - An install extracts each tarball to `<cache>/<name>@<version>@@@1`. That
 *     tree is PRISTINE: upstream bytes, no patch applied.
 *   - A `patchedDependencies` entry makes bun write a SECOND tree beside it,
 *     `<cache>/<name>@<version>@@@1_patch_hash=<16 hex>`, and hardlink
 *     `node_modules/<name>` from that one. Proven on a fresh `--cache-dir`:
 *     installing `@nimbus-sh/sdk@0.2.0` unpatched produced only
 *     `sdk@0.2.0@@@1`; adding the patch and reinstalling produced
 *     `sdk@0.2.0@@@1_patch_hash=36bb80152188ff78` alongside it, and
 *     `node_modules/@nimbus-sh/sdk/package.json` then shared an inode with the
 *     PATCHED tree and not the pristine one.
 *   - The pristine tree is dependable offline: deleting it while the patched
 *     tree stayed cached and running `bun install --frozen-lockfile` recreated
 *     it. So this gate never needs the network and never needs a scratch
 *     install.
 *   - The hash is derived from the patch file and is recorded nowhere in
 *     `bun.lock`, which is why every regeneration leaves its predecessor
 *     behind. This machine holds 4 such trees for `@nimbus-sh/core` and 14 for
 *     `@plannotator/ui` — a visible history of the patch being cut repeatedly.
 *
 * `node_modules` being HARDLINKED to the cache is why nothing here writes into
 * it, and the blast radius is worse than it looks. A patched package's files
 * are hardlinks to the PATCHED cache tree (measured: `package.json` inode
 * 42479915, nlink=2, shared with `..._patch_hash=2404a0820d26bace`; an
 * unpatched `zod` sits at nlink=80), so an in-place write in ANY checkout
 * rewrites a cache entry every other checkout will later hardlink from. And
 * because bun keys that tree on the PATCH rather than on its contents, the
 * corrupted tree is served again for the same patch, indefinitely.
 *
 * That is not hypothetical either. Installing main's committed core patch into
 * a clean `--cache-dir` resolves it to `_patch_hash=1b11df3a32a2c814`; this
 * machine's tree of that exact name differs from the clean rebuild in four
 * files carrying another branch's edits. So `bun install` alone does not always
 * restore parity — the remedy below says so.
 *
 * THE CHECK. For each entry in `patchedDependencies` — read from
 * `package.json`, because a hand-maintained mirror of that list is the exact
 * defect class this gate exists to close — stage the pre-image files into a
 * throwaway tree, apply the committed patch with `git apply`, and compare every
 * file the patch touches, byte for byte, against the installed copy.
 *
 * Two things make the red trustworthy rather than merely alarming.
 *
 *   1. The pre-image is verified first. Each staged file's blob SHA-1 must match
 *      the `index <pre>..<post>` hash the patch declares for it. Without that, a
 *      corrupt cache entry or a registry that republished the pinned version
 *      produces a mismatch that reads as `node_modules` drift and sends the
 *      reader to the wrong file entirely. A failure here is a REFUSAL, not a
 *      finding: the gate says it cannot judge, and why.
 *   2. A drifting file is classified by WHICH DIRECTION it drifted, because the
 *      two have opposite remedies and the incident produced both. A file whose
 *      installed bytes equal the PRISTINE bytes means the patch's change never
 *      reached the tree — reinstall. A file that matches neither pristine nor
 *      the patch result carries edits the patch does not describe — regenerate.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitEnv, scratchDir } from '@proteus/test-utils';
import * as v from 'valibot';
import { assertMeasured, finding } from './gate-ratchet';

const REPO_ROOT = join(import.meta.dir, '..');
const MODULES = join(REPO_ROOT, 'node_modules');

/** What this gate does NOT cover, printed on the GREEN path. A blind spot
 *  visible only in red output is invisible exactly when the tree is clean, and
 *  this repository has three times trusted a gate for something it never looked
 *  at. */
export const BLIND_SPOTS: readonly string[] = [
  'files the patch does NOT touch. The claim is "the touched set matches", not "the package '
  + 'matches": an edit to any other file in an installed package passes unseen. Measured '
  + '2026-08-18, the gap is currently EMPTY — a full byte walk of all four pristine trees against '
  + 'the installed ones (1,935 files, 84.1 MB, 0.11s) finds exactly 41 files differing, and those '
  + 'are exactly the 41 the patches touch. So nothing is hiding here today, and closing the gap '
  + 'permanently costs 0.11s. It is left open as a scope choice with a number behind it, not an '
  + 'oversight.',
  "the patch's own internal consistency. `git apply` never reads the `index` line it applies "
  + 'under, so a hand-edited patch whose declared post-image blob disagrees with its own hunk '
  + 'body is invisible here. Only the PRE-image is verified, and only because a wrong pre-image '
  + 'would misattribute the red. This is not hypothetical: measured 2026-08-18, three sections of '
  + "`@nimbus-sh/core`'s committed patch (dist/runtime/os-contracts.d.ts, "
  + 'dist/runtime/port-registry.d.ts, dist/substrate/lifo/shell/Shell.d.ts) declare a post-image '
  + 'blob their own hunks do not produce. Parity is unaffected — bun applies the body — so these '
  + 'are deliberately not findings here.',
  'whether the patch is CORRECT or wanted. It asserts the tree matches the patch, never that '
  + 'either is a good idea, and a patch that breaks the dependency passes as long as the install '
  + 'reproduces it.',
  'any dependency absent from `patchedDependencies`. The governed set is exactly that map, so a '
  + 'package edited in `node_modules` with no patch entry at all is outside this gate — nothing '
  + 'declares it, so nothing here can miss it either.',
  'the tree on any OTHER machine. It compares the `node_modules` on this box; CI is covered only '
  + 'because CI runs it after its own install.',
  'WHICH CHECKOUT it is answering for. `scripts/setup-worktree.sh` mirrors a worktree by '
  + "symlinking each of node_modules' entries to the main checkout's, so `node_modules/@nimbus-sh` "
  + 'is ONE directory shared by every worktree on the machine while `patches/` is per-commit. '
  + 'Whichever checkout last ran `bun install` materialised it for all of them, so this gate '
  + 'answers "do THIS commit\'s patches describe the shared tree", and at most one checkout can '
  + 'be truthful at a time. A red here can therefore be another branch\'s install rather than '
  + "this commit's mistake — which is still a real finding, because the suites running beside it "
  + 'are measuring that same tree.',
];

const ManifestSchema = v.object({
  patchedDependencies: v.optional(v.record(v.string(), v.string())),
});

/** A `patchedDependencies` entry, split. */
export interface PatchedDependency {
  /** Package name, scope included: `@nimbus-sh/core`. */
  readonly pkg: string;
  readonly version: string;
  /** Repository-relative path to the committed patch. */
  readonly patch: string;
}

/** The governed set, read from the one place that decides it. */
export function patchedDependencies(root: string = REPO_ROOT): readonly PatchedDependency[] {
  const manifest = v.parse(
    ManifestSchema,
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
  );
  return Object.entries(manifest.patchedDependencies ?? {}).map(([spec, patch]) => {
    const at = spec.lastIndexOf('@');
    if (at <= 0) {
      throw new Error(
        `patch-parity: patchedDependencies key ${spec} carries no @version — bun keys this map `
        + 'by name@version and the cache entry cannot be located without one',
      );
    }
    return { pkg: spec.slice(0, at), version: spec.slice(at + 1), patch };
  });
}

/** The gate cannot judge. Reason first: the tag is what a reader triages on,
 *  the message is what they act on. */
export interface Refusal {
  readonly reason:
    | 'cache_unreachable'
    | 'pristine_missing'
    | 'pristine_mismatch'
    | 'unmodelled_patch'
    | 'apply_failed'
    | 'not_installed';
  readonly error: string;
}

class RefusedError extends Error {
  constructor(readonly reason: Refusal['reason'], message: string) {
    super(message);
  }
}

/** Where bun keeps extracted packages, asked of bun rather than assumed, so
 *  `--cache-dir`, `BUN_INSTALL_CACHE_DIR` and bunfig all reach this gate the
 *  same way they reach the install that produced the tree. */
export function bunCacheDir(cwd: string = REPO_ROOT): string {
  const proc = Bun.spawnSync(['bun', 'pm', 'cache'], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const dir = proc.stdout.toString().trim();
  if (proc.exitCode !== 0 || dir === '') {
    throw new RefusedError(
      'cache_unreachable',
      `bun pm cache failed (exit ${String(proc.exitCode)}): ${proc.stderr.toString().trim()}`,
    );
  }
  return dir;
}

/**
 * The pristine extraction for one package.
 *
 * Selected by prefix rather than by hardcoding `@@@1`, and filtered against
 * `_patch_hash=` so the PATCHED sibling can never be mistaken for the pristine
 * source — which would make this gate compare the tree against itself and pass
 * unconditionally. That is the failure mode worth spending a filter on.
 */
export function pristineTree(cache: string, pkg: string, version: string): string {
  const slash = pkg.indexOf('/');
  const scoped = pkg.startsWith('@') && slash > 0;
  const parent = scoped ? join(cache, pkg.slice(0, slash)) : cache;
  const base = scoped ? pkg.slice(slash + 1) : pkg;
  const prefix = `${base}@${version}@@@`;
  const found = existsSync(parent)
    ? readdirSync(parent).filter((e) => e.startsWith(prefix) && !e.includes('_patch_hash='))
    : [];
  const entry = found[0];
  if (found.length !== 1 || entry === undefined) {
    throw new RefusedError(
      'pristine_missing',
      `expected exactly one pristine cache tree matching ${parent}/${prefix}*, found `
      + `${String(found.length)}. Run \`bun install\` — bun recreates it from the cached tarball `
      + 'without touching the network.',
    );
  }
  return join(parent, entry);
}

/** One file as the patch describes it. `from`/`to` are undefined for a created
 *  and a deleted file respectively; both are set, and equal, for the ordinary
 *  modification, and differ for a rename. */
export interface PatchedFile {
  readonly from: string | undefined;
  readonly to: string | undefined;
  /** Blob SHA-1 of the pre-image as the patch declares it, possibly abbreviated. */
  readonly preBlob: string | undefined;
}

/**
 * The files a patch touches.
 *
 * Paths come from the `---`/`+++` lines rather than the `diff --git` header,
 * which is genuinely ambiguous for a path containing a space. Only the lines
 * BEFORE the first `@@` are read: a removed line whose content begins `-- ` is
 * emitted as `--- ` and would otherwise be parsed as a header.
 *
 * Anything not modelled is a REFUSAL naming the shape, never a silent skip. A
 * gate that quietly ignores the one section it did not understand is the defect
 * this file exists to close, one level up.
 */
export function parsePatch(text: string): readonly PatchedFile[] {
  const files: PatchedFile[] = [];
  const sections = text.split(/^(?=diff --git )/m).filter((s) => s.startsWith('diff --git '));
  for (const section of sections) {
    const lines = section.split('\n');
    const end = lines.findIndex((l) => l.startsWith('@@ '));
    const header = end === -1 ? lines : lines.slice(0, end);
    const headline = lines[0] ?? '';

    if (header.some((l) => l.startsWith('GIT binary patch'))) {
      throw new RefusedError(
        'unmodelled_patch',
        `${headline.trim()} is a binary hunk; this gate models text hunks only. Teach it the `
        + 'shape rather than letting the section pass unchecked.',
      );
    }
    const minus = header.find((l) => l.startsWith('--- '));
    const plus = header.find((l) => l.startsWith('+++ '));
    if (minus === undefined || plus === undefined) {
      throw new RefusedError(
        'unmodelled_patch',
        `${headline.trim()} carries no ---/+++ pair, so it is a mode-only or pure-rename change. `
        + 'This gate compares content and would report it as matching.',
      );
    }
    const side = (line: string, prefix: string): string | undefined => {
      const raw = line.slice(4).split('\t')[0] ?? '';
      if (raw === '/dev/null') return undefined;
      if (raw.startsWith('"')) {
        throw new RefusedError(
          'unmodelled_patch',
          `${headline.trim()} names a quoted path (${raw}); this gate does not unquote them.`,
        );
      }
      return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    };
    const index = header.find((l) => l.startsWith('index '));
    const blobs = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(index ?? '');
    const from = side(minus, 'a/');
    if (from !== undefined && blobs === null) {
      throw new RefusedError(
        'unmodelled_patch',
        `${headline.trim()} carries no \`index <pre>..<post>\` line. Without the declared `
        + 'pre-image blob this gate cannot tell a corrupt cache from real drift, and would blame '
        + 'the wrong one.',
      );
    }
    files.push({ from, to: side(plus, 'b/'), preBlob: blobs?.[1] });
  }
  return files;
}

/** Blob SHA-1 of each path, in order, computed the way the patch's `index` line
 *  was. One spawn per package rather than per file. */
function blobHashes(root: string, paths: readonly string[]): readonly string[] {
  if (paths.length === 0) return [];
  const proc = Bun.spawnSync(['git', 'hash-object', '--', ...paths], {
    cwd: root,
    env: gitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    throw new RefusedError(
      'pristine_mismatch',
      `git hash-object failed over the pristine tree: ${proc.stderr.toString().trim()}`,
    );
  }
  return proc.stdout.toString().trim().split('\n');
}

/** How one file the patch touches compares against the installed copy. */
export interface FileVerdict {
  readonly path: string;
  readonly state: 'differ' | 'unpatched' | 'missing' | 'unexpected';
  readonly detail: string;
  /** First changed lines, captured while the staging tree still exists. */
  readonly sample: readonly string[];
}

export interface PackageReport {
  readonly pkg: string;
  readonly version: string;
  readonly patch: string;
  /** Set when the check could not be performed; the counts are then zero. */
  readonly refusal: Refusal | undefined;
  readonly compared: number;
  readonly matching: number;
  readonly findings: readonly FileVerdict[];
}

/** `+added/-removed` between the patch's result and what is installed, plus the
 *  first changed lines. The counts alone say how far apart they are; the sample
 *  is what makes the finding actionable without a second command. */
function diffSummary(expected: string, installed: string): string {
  const numstat = Bun.spawnSync(
    ['git', 'diff', '--no-index', '--numstat', '--', expected, installed],
    { env: gitEnv(), stdout: 'pipe', stderr: 'pipe' },
  ).stdout.toString().trim().split('\t');
  const added = numstat[0] ?? '?';
  const removed = numstat[1] ?? '?';
  return `+${added}/-${removed} lines against the patch's result `
    + `(${String(statSync(expected).size)} -> ${String(statSync(installed).size)} bytes)`;
}

/** Up to `limit` changed lines, for orientation. */
function diffSample(expected: string, installed: string, limit: number): readonly string[] {
  const out = Bun.spawnSync(
    ['git', 'diff', '--no-index', '-U0', '--', expected, installed],
    { env: gitEnv(), stdout: 'pipe', stderr: 'pipe' },
  ).stdout.toString().split('\n');
  return out
    .filter((l) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'))
    .slice(0, limit);
}

function sameBytes(left: string, right: string): boolean {
  if (!readFileSync(left).equals(readFileSync(right))) return false;
  // The only mode bit git records. A patch whose sole change to a file is the
  // executable bit would otherwise compare as matching.
  return (statSync(left).mode & 0o111) === (statSync(right).mode & 0o111);
}

/**
 * One package: stage, verify the pre-image, apply, compare.
 *
 * Staging copies only the files the patch names — 37 files across the four
 * patched dependencies rather than 1,935 — so the gate costs a fraction of a
 * second and can sit at the commit tier where the defect is introduced.
 */
export function checkPackage(
  entry: PatchedDependency,
  cache: string,
  modules: string = MODULES,
  root: string = REPO_ROOT,
): PackageReport {
  const base = { pkg: entry.pkg, version: entry.version, patch: entry.patch };
  let work: string | undefined;
  try {
    const pristine = pristineTree(cache, entry.pkg, entry.version);
    const installed = join(modules, entry.pkg);
    if (!existsSync(installed)) {
      throw new RefusedError(
        'not_installed',
        `${installed} does not exist, so there is no installed tree to compare against. `
        + 'Run `bun install`.',
      );
    }
    const files = parsePatch(readFileSync(join(root, entry.patch), 'utf8'));
    if (files.length === 0) {
      throw new RefusedError(
        'unmodelled_patch',
        `${entry.patch} declares no file sections — an empty patch governs nothing and would `
        + 'report a vacuous pass.',
      );
    }

    const preImages = files.map((f) => f.from).filter((p) => p !== undefined);
    const hashes = blobHashes(pristine, preImages);
    const mismatched = preImages.filter((path, i) => {
      const declared = files.find((f) => f.from === path)?.preBlob ?? '';
      return (hashes[i] ?? '').slice(0, declared.length) !== declared;
    });
    if (mismatched.length > 0) {
      throw new RefusedError(
        'pristine_mismatch',
        `${String(mismatched.length)} of ${String(preImages.length)} cached upstream file(s) are `
        + `not the bytes this patch was generated against (${mismatched.join(', ')}). Either the `
        + `cache entry at ${pristine} is corrupt, or the registry republished `
        + `${entry.pkg}@${entry.version} under the same version. Until that is settled this gate `
        + 'cannot tell a bad cache from real drift, so it judges neither.',
      );
    }

    work = scratchDir('patch-parity');
    for (const file of files) {
      if (file.from === undefined) continue;
      const target = join(work, file.from);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(pristine, file.from), target);
    }
    // `gitEnv()` because this runs at the commit tier, where a hook has exported
    // GIT_DIR and GIT_WORK_TREE — both of which outrank `cwd`, and either of
    // which would point `git apply` at the developer's checkout instead of the
    // staging tree.
    const apply = Bun.spawnSync(['git', 'apply', '--whitespace=nowarn', join(root, entry.patch)], {
      cwd: work,
      env: gitEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (apply.exitCode !== 0) {
      throw new RefusedError(
        'apply_failed',
        `the committed patch does not apply to the pristine upstream tree: `
        + apply.stderr.toString().trim(),
      );
    }

    const findings: FileVerdict[] = [];
    let matching = 0;
    for (const file of files) {
      if (file.to === undefined) {
        const stale = join(installed, file.from ?? '');
        if (existsSync(stale)) {
          findings.push({
            path: file.from ?? '',
            state: 'unexpected',
            detail: 'the patch deletes this file and the installed tree still has it',
            sample: [],
          });
          continue;
        }
        matching += 1;
        continue;
      }
      const expected = join(work, file.to);
      const actual = join(installed, file.to);
      if (!existsSync(actual)) {
        findings.push({
          path: file.to,
          state: 'missing',
          detail: 'the patch produces this file and the installed tree does not have it',
          sample: [],
        });
        continue;
      }
      if (sameBytes(expected, actual)) {
        matching += 1;
        continue;
      }
      const pristineFile = file.from === undefined ? undefined : join(pristine, file.from);
      const unpatched = pristineFile !== undefined
        && existsSync(pristineFile)
        && sameBytes(pristineFile, actual);
      findings.push({
        path: file.to,
        state: unpatched ? 'unpatched' : 'differ',
        detail: unpatched
          ? 'the installed bytes are the PRISTINE upstream bytes: this hunk never reached the tree'
          : diffSummary(expected, actual),
        sample: unpatched ? [] : diffSample(expected, actual, 6),
      });
    }
    return { ...base, refusal: undefined, compared: files.length, matching, findings };
  } catch (error) {
    const refusal: Refusal = error instanceof RefusedError
      ? { reason: error.reason, error: error.message }
      : { reason: 'unmodelled_patch', error: error instanceof Error ? error.message : String(error) };
    return { ...base, refusal, compared: 0, matching: 0, findings: [] };
  } finally {
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  }
}

export function judgePatchParity(
  modules: string = MODULES,
  root: string = REPO_ROOT,
): readonly PackageReport[] {
  const cache = bunCacheDir(root);
  return patchedDependencies(root).map((entry) => checkPackage(entry, cache, modules, root));
}

function main(): void {
  const reports = judgePatchParity();
  const measured = assertMeasured('patch-parity', [
    ['patched dependencies', reports.length],
    ['files governed', reports.reduce((n, r) => n + r.compared, 0)],
  ]);

  let failed = false;
  for (const report of reports) {
    const spec = `${report.pkg}@${report.version}`;
    if (report.refusal !== undefined) {
      failed = true;
      console.error(`::error::patch-parity: ${spec} — ${report.refusal.reason}`);
      console.error(finding({
        at: `${spec}  (${report.patch})`,
        invariant: 'the committed patch is judgeable against the installed tree',
        found: `REFUSED (${report.refusal.reason}): ${report.refusal.error}`,
        silently: 'nothing at all — an unjudgeable patch reads as a judged one the moment this '
          + 'gate is allowed to skip it, which is how the whole class stayed invisible.',
        fix: 'settle the reason above; this gate refuses rather than guessing.',
      }));
      continue;
    }
    if (report.findings.length === 0) {
      console.log(`  ${spec.padEnd(24)} ${String(report.matching)}/${String(report.compared)} match`);
      continue;
    }
    failed = true;
    console.error(`::error::patch-parity: ${spec} — ${String(report.findings.length)} file(s) drifted`);
    for (const verdict of report.findings) {
      console.error(finding({
        at: `${spec}  ${verdict.path}`,
        invariant: 'the installed file equals the committed patch applied to the pristine upstream tree',
        found: `${verdict.state.toUpperCase()}: ${verdict.detail}`,
        silently: verdict.state === 'unpatched'
          ? 'a test suite measuring an UNPATCHED dependency while the patch claims otherwise. '
            + 'Green here, red on any machine that installs the patch.'
          : 'a test suite measuring edits no patch describes. Green here, red on every fresh '
            + 'install — the exact shape of the `confinePrincipal` incident.',
        fix: verdict.state === 'unpatched'
          ? 'run `bun install` — the installed tree is stale against the committed patch.'
          : `capture the edits with \`bun patch --commit node_modules/${report.pkg}\` if they are `
            + 'wanted, regenerating the patch LAST so declarations are included. To DISCARD them, '
            + '`bun install` may not be enough: bun keys its patched cache tree on the patch, so a '
            + 'tree an in-place write corrupted is served again for the same patch. Remove '
            + `\`$(bun pm cache)/${report.pkg}@${report.version}@@@*_patch_hash=*\` and reinstall.`,
      }));
      if (verdict.sample.length > 0) {
        console.error('    sample:');
        for (const line of verdict.sample) console.error(`      ${line}`);
      }
    }
    console.error(
      `  ${spec}: ${String(report.matching)}/${String(report.compared)} match, `
      + `${String(report.findings.length)} drifted`,
    );
  }

  if (failed) {
    console.error('\npatch-parity: FAILED — the committed patches do not describe node_modules.');
    process.exit(1);
  }
  console.log(`patch-parity: ok — ${measured}`);
  console.log('patch-parity blind spots:');
  for (const spot of BLIND_SPOTS) console.log(`  - ${spot}`);
}

if (import.meta.main) main();
