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
 * matter. Ignore rules narrow ONLY those untracked additions (that is what keeps
 * `external/`'s reference clones out); a TRACKED file is in every corpus
 * unconditionally, because tracked is what git ships. The 2026-08-18 incident:
 * a merge from a pre-scrub branch re-added a gitignored transcript as a TRACKED
 * file carrying two live tokens, and with no working-tree copy the old
 * enumeration — which dropped any listed path missing from disk — handed every
 * gate a corpus without it, so `secret-scan` exited 0 while `git ls-files`
 * showed the leak. Tracked-and-ignored at once is itself an anomaly (someone
 * gitignored a file without untracking it, or a merge re-added an ignored
 * path), so enumeration names each such path in a warning.
 */

import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileSink, Subprocess } from 'bun';
import { gitEnv } from '../packages/test-utils/src/git.ts';
import {
  TEST_FILE, TEST_SUFFIX,
} from '../tools/oxlint/anti-slop/rules/no-ambient-git-in-tests.ts';
import {
  RAW_NODE_MODULE,
} from '../tools/oxlint/anti-slop/rules/require-runtime-import-extension.ts';
import * as v from 'valibot';

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

/** A document: prose a person wrote for a reader. The narrowest set in this
 *  module, and the only one whose members make claims in ENGLISH rather than in
 *  code — which is why document checks need it separately from `isTextSource`. */
const DOCUMENT = /\.md$/;

/** A package manifest, at the root or in a workspace. */
const MANIFEST = /(?:^|\/)package\.json$/;

/** A resolved dependency graph, written by an installer rather than by a
 *  person. Every package name in the tree appears in one. */
const LOCKFILE = /(?:^|\/)(?:bun\.lock|bun\.lockb|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;

/** A stylesheet. Outside `TEXT_SOURCE` deliberately — a `.css` holds no prose
 *  claim and no pasted credential — but it does name packages. */
const STYLESHEET = /\.css$/;

/**
 * What `bun test` ITSELF selects, measured rather than assumed: a directory
 * holding `a.test.ts`, `c.spec.ts`, `d_test.ts`, `e_spec.ts`, `g.test.tsx`,
 * `b.eval.ts` and `f.eval.tsx` runs FIVE files under bun 1.4.0, and the two
 * `.eval.` ones are not among them.
 *
 * Strictly narrower than `TEST_SUFFIX`, and the gap is load bearing. The
 * ladder's denominator is `isRunnableSuite`, which counts `.eval.` because the
 * lint rule governs those files too — so `bun test ./tests/` was CREDITED with
 * the four `tests/evals/*.eval.ts` suites bun cannot see, and `ladder.test.ts`
 * asserted that exact wrong set by equality. Four live eval suites read as
 * covered by a bun gate at the ci tier while only the eval tier's vitest arms
 * ever ran them.
 */
const BUN_DISCOVERED = /(?:\.|_)(?:test|spec)\.[jt]sx?$/;

/**
 * A Python suite, by the basename pattern `unittest discover -p 'test_*.py'`
 * selects with.
 *
 * Its own pattern because `TEST_SUFFIX` is a JS/TS basename rule and cannot
 * reach another language: before this existed the 77 tests under
 * `bench/tests/`, `bench/harbor/tests/` and `bench/clbench/tests/` were outside
 * every gate's denominator, so "every test file is claimed by some runner" was
 * a statement about TypeScript alone and three Python suites ran in no
 * pipeline at all.
 */
const PYTHON_SUITE = /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$/;

let enumerated: readonly string[] | undefined;

export interface Enumeration {
  /** Every file a gate governs: all tracked paths, plus untracked additions the
   *  ignore rules do not cover. */
  files: readonly string[];
  /** Tracked paths an ignore rule also matches. Each is an anomaly: ignore rules
   *  exist to exclude untracked noise, never to hide something git ships. */
  trackedIgnored: readonly string[];
}

/**
 * Enumerate one repository. Tracked-ness is authoritative: a tracked path stays
 * in the corpus whether or not an ignore rule matches it and whether or not a
 * working-tree copy exists — its index blob is what a push publishes, and
 * `readRepositoryFile` still reads that blob when the disk copy is gone. Only
 * untracked additions are narrowed by ignore rules and by presence on disk.
 *
 * `execFileSync` and not `Bun.spawnSync`, deliberately: it THROWS on a non-zero
 * exit. An enumeration that fails quietly hands every caller an empty corpus,
 * and an empty corpus reports a clean tree — so the zero check below is an error
 * rather than a warning. A gate that cannot fail is a gate that cannot measure.
 */
export function enumerateRepository(repoRoot: string): Enumeration {
  const list = (...flags: readonly string[]): string[] =>
    execFileSync('git', ['-C', repoRoot, 'ls-files', '-z', ...flags], {
      env: gitEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    }).split('\0').filter((f) => f.length > 0);
  const tracked = list('--cached');
  const additions = list('--others', '--exclude-standard')
    .filter((f) => existsSync(join(repoRoot, f)));
  const trackedIgnored = list('--cached', '--ignored', '--exclude-standard');
  for (const f of trackedIgnored) {
    console.error(`sources: WARNING: ${f} is tracked AND gitignored — ignore rules never hide `
      + 'a tracked file from a gate; either `git rm --cached` it or drop the ignore rule');
  }
  const files = [...tracked, ...additions].sort();
  if (files.length === 0) throw new Error('sources: git ls-files enumerated no file');
  return { files, trackedIgnored };
}

/** Every file in this repository a gate may hold to a standard, memoised over
 *  the repository this module sits in. */
export function trackedFiles(): readonly string[] {
  if (enumerated === undefined) enumerated = enumerateRepository(root).files;
  return enumerated;
}

const PackageNameSchema = v.object({ name: v.optional(v.string()) });

let scope: string | undefined;

/** The npm scope every workspace package is published under (`@name`, no
 *  trailing slash), read from the manifests rather than written down.
 *
 *  Two gate programs and `scripts/setup-worktree.sh` rebuild
 *  `node_modules/<scope>` so it points at the tree under test, and a literal
 *  scope in any of them is this module's own defect shape: a name measured in
 *  one spelling and governed in another. It is worse here than elsewhere,
 *  because a stale scope directory does not fail — it resolves to a REAL
 *  checkout, so the suite passes while measuring a tree nobody edited. That has
 *  already cost a bench run, the harbor adapter and a week of worktrees.
 *  Derived, it cannot drift across a rename, and a workspace whose packages
 *  disagree is an error rather than whichever name got read first. */
export function workspaceScope(): string {
  if (scope !== undefined) return scope;
  const found = new Set<string>();
  for (const file of trackedFiles()) {
    if (!/^packages\/[^/]+\/package\.json$/.test(file)) continue;
    const { name } = v.parse(PackageNameSchema, JSON.parse(readRepositoryFile(root, file)));
    if (name === undefined || !name.startsWith('@')) continue;
    found.add(name.slice(0, name.indexOf('/')));
  }
  if (found.size !== 1) {
    throw new Error('sources: expected exactly one workspace scope across packages/*/package.json, '
      + `found ${found.size === 0 ? 'none' : [...found].sort().join(', ')}`);
  }
  [scope] = found;
  return scope;
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

/**
 * The half of {@link isRunnableSuite} a `bun test` invocation can actually
 * select. What a bun gate is allowed to be CREDITED with, rather than what a
 * path prefix would sweep up.
 */
export const isBunDiscoverableSuite = (file: string): boolean => BUN_DISCOVERED.test(file);

/**
 * The other half, by construction rather than by a second list: a runnable
 * suite no `bun test` invocation can reach. Today that is exactly the
 * `tests/evals/*.eval.ts` family the eval tier runs under vitest.
 *
 * A COMPLEMENT so the partition is TOTAL. A third naming convention — a
 * `.eval.tsx`, or a `.eval.ts` outside `tests/evals/` — cannot appear in
 * neither set and slip past both runners' claims; it lands here and the ladder
 * demands a gate for it by name.
 */
export const isVitestEvalSuite = (file: string): boolean =>
  isRunnableSuite(file) && !isBunDiscoverableSuite(file);

/** A Python suite `unittest discover` selects. The ladder's Python denominator,
 *  so `bun scripts/python-suites.ts` is measured against the files on disk
 *  rather than against the discovery roots someone remembered to name. */
export const isPythonSuite = (file: string): boolean => PYTHON_SUITE.test(file);

/** Where the anti-slop plugin lives, and where its per-rule suites live. */
export const ANTI_SLOP_ROOT = 'tools/oxlint/anti-slop/';
export const ANTI_SLOP_RULES = `${ANTI_SLOP_ROOT}rules/`;

/**
 * A suite under the anti-slop plugin. Bun cannot run any of them — oxlint's
 * RuleTester needs Node's raw transfer — so `bunfig.toml` excludes the whole
 * directory and `bun run test:anti-slop` is the runner.
 *
 * The ladder's denominator for that runner, and it needs to be TOTAL rather than
 * a directory excuse: the ladder used to exempt this prefix outright, which
 * claimed every future file under it on the strength of one witness. Measured
 * 2026-08-30, the 41 suites here are the disjoint union of 12 named on the
 * `test:anti-slop` command line and 29 the aggregator discovers — and a new
 * top-level `tools/oxlint/anti-slop/foo.test.ts` would have been claimed by the
 * prefix and executed by neither.
 */
export const isAntiSlopSuite = (file: string): boolean =>
  file.startsWith(ANTI_SLOP_ROOT) && isRunnableSuite(file);

/** The per-rule suites `rules.test.ts` aggregates by dynamic import. Exported
 *  so the aggregator and the ladder ask the same question: the aggregator held
 *  its own `startsWith` copy, which is the second spelling this module exists to
 *  prevent. */
export const isAntiSlopRuleSuite = (file: string): boolean =>
  file.startsWith(ANTI_SLOP_RULES) && isRunnableSuite(file);

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

/** Prose a person wrote for a reader — the set document checks hold to the
 *  code. Narrower than `isTextSource` because the claim shapes differ: a `.md`
 *  states a count in words and names a symbol in a code span, and a `.json`
 *  states neither. */
export const isDocument = (file: string): boolean => DOCUMENT.test(file);

/**
 * A package MANIFEST. The census of declared dependencies reads these, and a
 * gate asking "who uses this package" must know which of its own bytes are the
 * DECLARATION rather than a use: `"clsx": "^2.1.1"` under `dependencies` is
 * what is being questioned, while `"lint": "oxlint ."` under `scripts` is a
 * genuine reference and the only one `oxlint` has.
 */
export const isManifest = (file: string): boolean => MANIFEST.test(file);

/** A dependency LOCKFILE. It names every package in the resolved graph by
 *  construction, so reading one while asking who USES a package answers yes for
 *  all of them — the lock's mention of `clsx` is the installation, not a use. */
export const isLockfile = (file: string): boolean => LOCKFILE.test(file);

/** A stylesheet. Its own package references are at-rules — this tree's
 *  `@import "@cloudflare/kumo/styles/tailwind"` resolves a package the build
 *  needs — and `.css` is outside {@link isTextSource}, so a dependency census
 *  that read only text sources would report a CSS-only package as unused. */
export const isStylesheet = (file: string): boolean => STYLESHEET.test(file);

/**
 * A seeded bench defect patch. The corpus `gate:bench-corpus` governs, narrowed
 * here rather than by a `readdirSync` inside the gate: an untracked `.patch`
 * dropped into that directory is not part of the corpus, and a second walk could
 * silently pick one up while `tasks.jsonl` and every scored run ignore it.
 */
export const isBenchDefectPatch = (file: string): boolean =>
  file.startsWith('tests/bench/patches/') && file.endsWith('.patch');

/** One file's text, from `repoRoot`. The working tree when a copy exists; the
 *  INDEX blob when it does not — a tracked file deleted (or never checked out)
 *  locally still ships on push, so a content gate must still read those exact
 *  bytes rather than silently narrowing its corpus. */
export function readRepositoryFile(repoRoot: string, file: string): string {
  const onDisk = join(repoRoot, file);
  if (existsSync(onDisk)) return readFileSync(onDisk, 'utf8');
  return execFileSync('git', ['-C', repoRoot, 'cat-file', 'blob', `:${file}`], {
    env: gitEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
}

/** `file -> text` for every enumerated file the predicate accepts. The one place
 *  a gate's corpus is materialised, so "which files did you read" and "which
 *  files do you govern" are the same expression. */
export function readMatching(predicate: (file: string) => boolean): Map<string, string> {
  const files = trackedFiles().filter(predicate);
  return new Map(files.map((f) => [f, readRepositoryFile(root, f)]));
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

/* ── Historical corpus ─────────────────────────────────────────────────── */

/**
 * The live enumeration above is what a push ships. This corpus is what locally
 * stored refs still remember after a working tree and index have been scrubbed.
 * It is deliberately here, beside the only live-file enumerator: each answers
 * one version of "what does this repository contain".
 */
export type HistoryRefClass = string;

/** One object/path association reachable from local refs. `path` is empty for
 * commits and root trees; they stay in the denominator but cannot produce a
 * content finding. */
export interface HistoryObject {
  readonly oid: string;
  readonly path: string;
  readonly refClasses: readonly HistoryRefClass[];
}

export interface HistoryBlob {
  readonly type: string;
  readonly size: number;
  /** Present only for a blob at or below the caller's explicit size cap. */
  readonly bytes: Uint8Array | undefined;
}

const HISTORY_OID = /^[0-9a-f]{40,64}$/;

/** Every named local ref. A ref name cannot contain a newline, so git's
 * line-oriented format remains an unambiguous input boundary. */
export function listHistoryRefs(repoRoot: string): readonly string[] {
  const output = execFileSync('git', ['-C', repoRoot, 'for-each-ref', '--format=%(refname)'], {
    env: gitEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const refs = output.split('\n').filter((ref) => ref.startsWith('refs/'));
  if (refs.length === 0) throw new Error('sources: git for-each-ref enumerated no local refs');
  return refs;
}

/** The compact ref class a finding may report without dumping hundreds of ref
 * names. Remote classes retain their remote because those are separate places
 * a remediation must reach. */
export function refClassOf(ref: string): HistoryRefClass {
  const parts = ref.split('/');
  return parts[1] === 'remotes' && parts.length > 3
    ? ['refs', 'remotes', parts[2]!].join('/')
    : parts.slice(0, 2).join('/');
}

interface HistoryRecord {
  oid: string;
  path: string;
}

function objectRecords(output: Buffer): HistoryRecord[] {
  const records: HistoryRecord[] = [];
  let pending: HistoryRecord | undefined;
  for (const record of output.toString('utf8').split('\0')) {
    if (record === '') continue;
    if (HISTORY_OID.test(record)) {
      if (pending !== undefined) records.push(pending);
      pending = { oid: record, path: '' };
      continue;
    }
    if (record.startsWith('path=') && pending !== undefined) {
      pending.path = record.slice('path='.length);
      continue;
    }
    throw new Error('sources: git rev-list returned an invalid object record');
  }
  if (pending !== undefined) records.push(pending);
  return records;
}

/**
 * Every object/path association reachable from `refs`, with all of the compact
 * classes through which that association is reachable. `-z` keeps a newline in
 * a historical filename from becoming a second object record.
 */
export function historyObjects(repoRoot: string, refs: readonly string[]): readonly HistoryObject[] {
  const byClass = new Map<HistoryRefClass, string[]>();
  for (const ref of refs) {
    const current = refClassOf(ref);
    const grouped = byClass.get(current);
    if (grouped === undefined) byClass.set(current, [ref]);
    else grouped.push(ref);
  }
  const pairs = new Map<string, { oid: string; path: string; refClasses: Set<HistoryRefClass> }>();
  for (const [current, classRefs] of byClass) {
    const output = execFileSync('git', ['-C', repoRoot, 'rev-list', '--objects', '-z', '--stdin'], {
      env: gitEnv(),
      input: `${classRefs.join('\n')}\n`,
      maxBuffer: 512 * 1024 * 1024,
    });
    for (const record of objectRecords(Buffer.from(output))) {
      const key = `${record.oid}\0${record.path}`;
      const existing = pairs.get(key);
      if (existing === undefined) {
        pairs.set(key, { ...record, refClasses: new Set([current]) });
      } else {
        existing.refClasses.add(current);
      }
    }
  }
  if (pairs.size === 0) throw new Error('sources: git rev-list enumerated no history object');
  return [...pairs.values()]
    .map(({ oid, path, refClasses }) => ({ oid, path, refClasses: [...refClasses].sort() }))
    .sort((left, right) => left.path.localeCompare(right.path) || left.oid.localeCompare(right.oid));
}

/** A NUL byte is the binary boundary used by the historical scanner. */
export function isScannableBytes(bytes: Uint8Array): boolean {
  return !bytes.includes(0);
}

/** Decode lossy by design: all secret shapes are ASCII, and malformed UTF-8
 * must not hide an ASCII credential beside it. */
export function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder('utf8', { fatal: false }).decode(bytes);
}

class BufferedHistoryBytes {
  private readonly chunks: Buffer[] = [];
  private available = 0;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  private async fill(): Promise<void> {
    while (true) {
      const next = await this.reader.read();
      if (next.done || next.value === undefined) {
        throw new Error('sources: git cat-file --batch closed before its response');
      }
      if (next.value.byteLength === 0) continue;
      this.chunks.push(Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength));
      this.available += next.value.byteLength;
      return;
    }
  }

  private async ensure(bytes: number): Promise<void> {
    while (this.available < bytes) await this.fill();
  }

  private indexOf(byte: number): number {
    let offset = 0;
    for (const chunk of this.chunks) {
      const index = chunk.indexOf(byte);
      if (index !== -1) return offset + index;
      offset += chunk.byteLength;
    }
    return -1;
  }

  async line(): Promise<Buffer> {
    let index = this.indexOf(10);
    while (index === -1) {
      await this.fill();
      index = this.indexOf(10);
    }
    return this.take(index + 1);
  }

  async take(bytes: number): Promise<Buffer> {
    if (bytes === 0) return Buffer.alloc(0);
    await this.ensure(bytes);
    const first = this.chunks[0]!;
    if (first.byteLength >= bytes) {
      const result = first.subarray(0, bytes);
      this.available -= bytes;
      if (first.byteLength === bytes) this.chunks.shift();
      else this.chunks[0] = first.subarray(bytes);
      return result;
    }
    const result = Buffer.allocUnsafe(bytes);
    let offset = 0;
    let remaining = bytes;
    while (remaining > 0) {
      const chunk = this.chunks[0]!;
      const count = Math.min(chunk.byteLength, remaining);
      chunk.copy(result, offset, 0, count);
      offset += count;
      remaining -= count;
      this.available -= count;
      if (count === chunk.byteLength) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(count);
    }
    return result;
  }

  async discard(bytes: number): Promise<void> {
    while (bytes > 0) {
      await this.ensure(1);
      const chunk = this.chunks[0]!;
      const count = Math.min(chunk.byteLength, bytes);
      this.available -= count;
      bytes -= count;
      if (count === chunk.byteLength) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(count);
    }
  }
}

async function consumeHistoryTerminator(bytes: BufferedHistoryBytes): Promise<void> {
  if ((await bytes.take(1))[0] !== 10) {
    throw new Error('sources: git cat-file --batch omitted an object separator');
  }
}

/**
 * Read historical objects through ONE persistent `git cat-file --batch`
 * process. The visitor receives every denominator object; content is withheld
 * only when it is not a blob or it exceeds the caller's explicit cap.
 */
export async function readHistoryObjects(
  repoRoot: string,
  objects: readonly HistoryObject[],
  maxBlobBytes: number,
  visit: (object: HistoryObject, blob: HistoryBlob) => void | Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(maxBlobBytes) || maxBlobBytes < 0) {
    throw new Error('sources: invalid historical blob size cap');
  }
  const child: Subprocess<'pipe', 'pipe', 'ignore'> = Bun.spawn(
    ['git', '-C', repoRoot, 'cat-file', '--batch'],
    { env: gitEnv(), stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' },
  );
  const stdin: FileSink = child.stdin;
  const bytes = new BufferedHistoryBytes(child.stdout.getReader());
  try {
    for (const object of objects) {
      await stdin.write(`${object.oid}\n`);
      await stdin.flush();
      const header = (await bytes.line()).toString('ascii');
      const match = /^([0-9a-f]{40,64}) ([a-z]+) (\d+)\n$/.exec(header);
      if (match === null || !Number.isSafeInteger(Number(match[3]))) {
        throw new Error('sources: git cat-file --batch returned an invalid object header');
      }
      const type = match[2]!;
      const size = Number(match[3]);
      if (type !== 'blob' || size > maxBlobBytes) {
        await bytes.discard(size);
        await consumeHistoryTerminator(bytes);
        await visit(object, { type, size, bytes: undefined });
        continue;
      }
      const content = await bytes.take(size);
      await consumeHistoryTerminator(bytes);
      await visit(object, { type, size, bytes: content });
    }
    await stdin.end();
    if (await child.exited !== 0) throw new Error('sources: git cat-file --batch failed');
  } catch (error) {
    child.kill();
    await child.exited;
    throw error;
  }
}
