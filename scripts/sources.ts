/**
 * The ONE enumeration of this repository, and the named predicates that narrow
 * it. Every gate reads its corpus from here.
 *
 * This was `readSources` inside `ast-duplication.ts`, which made three gates
 * import a fourth gate to find out which files exist — the wrong direction, and
 * it briefly looked like one broken function in the duplication gate had taken
 * `reachability` and `do-init-gate` down with it. Walking the repo is not the
 * duplication gate's job, and it is not the parser's either: `syntax.ts` stays a
 * pure parser seam so that nothing which merely wants `declaredName` transitively
 * depends on shelling out to git.
 *
 * THE REASON IT IS ALSO THE ONLY PLACE ALLOWED TO DECLARE A PATH PATTERN is a
 * defect that appeared fifteen times in one evening across six subsystems, four
 * of those times inside the advice about the other eleven. Its shape: a gate
 * measured one set and governed another. `capability-parity` scanned `packages`
 * while `bun run lint` scanned the repo, and the gap held three real sites.
 * `no-ambient-git-in-tests` matched `.test.` while the eval tier is `.eval.`.
 * Then that gate's own DENOMINATOR counted test files with a private copy of the
 * pattern it had just widened, so it would have certified 463 files while
 * governing 646. `dead-code.ts` carried a byte-identical second copy of
 * `PRODUCT_SOURCE`. `ladder.ts` counted its denominator with a third spelling.
 * Every one of them was introduced by someone closing the previous one.
 *
 * So: `trackedFiles` is the only enumeration, the predicates below are the only
 * narrowings, and a gate needing a smaller set imports one of them instead of
 * writing a pattern. `scripts/gate-set-equality.ts` asserts that over the gate
 * programs `ladder.ts` and `deploy.sh` actually invoke — because a rule that
 * lives only in a docstring is the rule that failed fifteen times.
 *
 * `git ls-files` rather than a directory crawl, because a gate should see what
 * git sees: a build artefact, a scratch file or an ignored vendor tree is not
 * code anyone maintains, and every one of them would arrive as a finding.
 * `--others --exclude-standard` because a brand-new file is the one most likely
 * to violate — `secret-scan.ts` was tracked-only, so a credential in a new file
 * was invisible until it was already in history and the scan fired too late to
 * matter. `.gitignore` still applies, which is what keeps `external/`'s
 * reference clones out.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  TEST_FILE, TEST_SUFFIX,
} from '../tools/oxlint/anti-slop/rules/no-ambient-git-in-tests.ts';
import {
  RAW_NODE_MODULE,
} from '../tools/oxlint/anti-slop/rules/require-runtime-import-extension.ts';

const root = new URL('..', import.meta.url).pathname;

/** Backend and core product code. */
const PRODUCT_SOURCE = /^packages\/[^/]+\/src\/.+\.tsx?$/;

/** What `syntax.ts` can parse. A `tests/` directory holds Python and fixture
 *  data too, and handing one of those to the parser is a crash rather than a
 *  finding. */
const PARSEABLE = /\.[cm]?[jt]sx?$/;

/** Text a human wrote: source, config, docs, and the formats a key is normally
 *  pasted into. One set for every content gate — a private key is no less
 *  committed for being in a `.md` than in a `.ts`. */
const TEXT_SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|ya?ml|toml|sh|env|pem|key)$/;

let enumerated: readonly string[] | undefined;

/**
 * Every file in this repository a gate may hold to a standard: tracked, PLUS new
 * files `.gitignore` does not cover, MINUS anything no longer on disk.
 *
 * `execFileSync` and not `Bun.spawnSync`, deliberately: it THROWS on a non-zero
 * exit. An enumeration that fails quietly hands every caller an empty corpus,
 * and an empty corpus reports a clean tree — so the zero check below is an error
 * rather than a warning. A gate that cannot fail is a gate that cannot measure.
 */
export function trackedFiles(): readonly string[] {
  if (enumerated !== undefined) return enumerated;
  const listed = execFileSync(
    'git',
    ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const files = listed.split('\0').filter((f) => f.length > 0 && existsSync(root + f));
  if (files.length === 0) throw new Error('sources: git ls-files enumerated no file');
  enumerated = files;
  return files;
}

/** Product source: the files a gate holds to the standard. Test code is out —
 *  duplicated test fixtures are a different and much cheaper problem than
 *  duplicated logic. */
export const isProductSource = (file: string): boolean =>
  PRODUCT_SOURCE.test(file) && !TEST_FILE.test(file) && !file.endsWith('.d.ts');

/** Test code, by the SAME pattern `no-ambient-git-in-tests` governs it with.
 *  Both arms: a `.test.` / `.eval.` / `.spec.` basename, and anything under a
 *  `tests/` directory — the second arm is how a package's `tests/helpers/`
 *  repo-builder counts as a test caller despite carrying no suffix. */
export const isTestFile = (file: string): boolean => TEST_FILE.test(file);

/** `packages/test-utils` — production-shaped code whose only consumers are
 *  suites. `dead-code` needs this narrower than `isProductSource`: every export
 *  there is legitimately test-only, so the whole package would arrive as
 *  findings. Exported so that narrowing is a named import rather than a second
 *  path prefix living inside a gate. */
export const isTestScaffold = (file: string): boolean => file.startsWith('packages/test-utils/');

/** The strictly narrower set a test RUNNER selects: the basename arm alone. The
 *  ladder's denominator, because `bun test` executes suffixed files and never
 *  the helpers beside them — derived from `TEST_SUFFIX`, one named arm of the
 *  rule's own pattern, rather than from a fourth spelling of it. */
export const isRunnableSuite = (file: string): boolean => TEST_SUFFIX.test(file);

/** Parseable by `syntax.ts`. */
export const isParseable = (file: string): boolean => PARSEABLE.test(file);

/** Loaded by raw `node --experimental-strip-types` rather than by Bun or a
 *  bundler, and therefore the one set whose imports must carry an explicit
 *  `.ts` — Node's ESM resolver takes a complete path and resolves neither an
 *  extensionless specifier nor a directory index. Derived from the rule's own
 *  pattern for the same reason `isTestFile` is: the set a gate measures and the
 *  set the lint governs have to be one expression.
 *  `tools/oxlint/anti-slop/import-extension.gate.test.ts` asserts this matches
 *  the transitive closure of the `node` entrypoints, so it cannot drift wider
 *  than what raw Node actually loads. */
export const isRawNodeModule = (file: string): boolean => RAW_NODE_MODULE.test(file);

/** Text a content gate can read — what `secret-scan` scans. Wider than
 *  `isParseable` on purpose: a credential in a `.md` or a `.pem` is no less
 *  committed than one in a `.ts`. */
export const isTextSource = (file: string): boolean => TEXT_SOURCE.test(file);

/** `file -> text` for every enumerated file the predicate accepts. The one place
 *  a gate's corpus is materialised, so "which files did you read" and "which
 *  files do you govern" are the same expression. */
export function readMatching(predicate: (file: string) => boolean): Map<string, string> {
  const files = trackedFiles().filter(predicate);
  return new Map(files.map((f) => [f, readFileSync(root + f, 'utf8')]));
}

/** Product source: the files a gate holds to the standard. */
export function readSources(): Map<string, string> {
  return readMatching(isProductSource);
}

/** Colocated and `tests/` suites, which `readSources` deliberately omits. A gate
 *  that reports "reachable" needs these separately from product code, so that
 *  "only its own test calls this" is sayable rather than invisible. */
export function readTests(): Map<string, string> {
  return readMatching((file) => isTestFile(file) && isParseable(file));
}
