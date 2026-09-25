#!/usr/bin/env bun
/**
 * The TEST CENSUS — a read-only measurement of every test file in the corpus,
 * classified along the axes a test review judges by.
 *
 * WHY A CENSUS AND NOT AN OPINION. The review standard, made operational: a test
 * is valid only if a plausible DEFECT turns it red; a test that asserts on the
 * implementation's TEXT is coupled to the implementation and goes red on a
 * refactor instead; a mock of an internal module is coupling; a silent skip is
 * not coverage. Those are measurable properties of a file's syntax, not
 * judgements a reader forms by reading 826 files — and a review needs the
 * numbers before any rewrite list, because "the worst 30" over an unmeasured
 * corpus is "the 30 someone happened to open".
 *
 * WHAT IT IS NOW: a gate. `--ratchet` refuses any instance of a banned axis and
 * a NEW instance of a ratcheted one, and it runs in the ladder's commit tier.
 * `--lock` only shrinks the lock: it refuses to record a key the lock lacks.
 * Every run still prints what it CANNOT see, because a blind spot visible only
 * in red output is invisible exactly when the tree is green.
 *
 * THE ONE RULE THIS TOOL AND `wired.ts` SHARE, stated in both headers in the
 * same words. A constant a test needs is EITHER a public contract — exported
 * from the module that owns it AND read by production, which is exactly what
 * `wired.ts` accepts as reachable — OR it is unnecessary, because the test can
 * observe the behaviour instead. There is no third option, and the two shapes
 * that pretend to be one are a TEST-ONLY EXPORT and a TEST-SIDE MIRROR: the
 * first makes the module's surface bigger for no production reader, which
 * `wired.ts` reports as reached-by-tests-only; the second restates the value
 * beside the module, which this census reports as a mirror. They are the same
 * defect seen from two sides, and neither is the fix for the other. The fix is
 * to assert what the code DOES: a value the module hands out, a path it names
 * in a command, a count it puts in its own message.
 *
 * CORPUS. Read through `sources.ts` like every gate, narrowed by `isTestFile`
 * and `isParseable`, minus `tools/oxlint/anti-slop` — vendored upstream code,
 * out of review scope. One exported predicate, `isCensusFile`, so the set
 * measured and the set reported are one expression. Product text comes from
 * `readSources()`, and a path literal is RESOLVED against the enumeration
 * rather than matched against a pattern of this program's own — `gate:set-equality`
 * governs this file now that the ladder runs it, and it found four own-selector
 * sites here before that.
 *
 * THE DENOMINATOR, RECONCILED against a hand tally, because the first review of
 * this tool counted by hand and got a different number. At `0da431407` the
 * review tallied 62 test files under `scripts/`; this census reads 63 there,
 * and the one file between the two readings is `scripts/test-census.test.ts` —
 * this tool's own suite, which did not exist at that revision. Nothing else
 * under `scripts/` was added, renamed or deleted between them (measured
 * 2026-09-01 by diffing `git ls-tree -r --name-only` at both revisions). The
 * report states its own arithmetic on every run: how many corpus files a runner
 * claims, how many none does, and both halves of that second number by name.
 *
 * PARSING. `syntax.ts` (oxc), the substrate the other static gates use. Every
 * signal is an AST fact about a resolved import, a declared accessibility or a
 * matcher chain. A regex only ever seeds a candidate the tree then confirms.
 *
 * PRECISION IS THE PRODUCT, and each of these was MEASURED on this tree rather
 * than reasoned about. Six false-positive classes were found and closed, and
 * every one of them would have inflated a headline the review then argues from:
 *   - assertion-free: 167 rows before file-local helper resolution. `expectRefused`
 *     holds six `expect`s and the test calling it holds none. Real count: 15.
 *   - mirror: 1,176 rows when a shared literal `2` counted. A mirror is now a
 *     NAMED constant whose distinctive value a module also names. Real count: 53.
 *   - source text: 102 rows from "a string that also occurs in src", which
 *     flagged `expect(cookie).toContain('SameSite=Lax')` — a behavioural
 *     assertion whose string naturally appears in the code that sets it. The
 *     surviving rule needs the ASSERTED VALUE to be source text, resolved
 *     through the file's own reader functions.
 *   - `spyOn(console,'error')` read as an internal mock of `spyOn`, because the
 *     target was taken from `children[0]`, which is the callee.
 *   - `test.each(TABLE)` counted as a test of its own: the factory call carries
 *     no body, so 40 table-driven suites read as assertion-free.
 *   - `x['authorization']` counted as a private reach. A bracket reach is now
 *     confirmed against members production DECLARES `private`/`protected`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Node } from 'oxc-parser';
import * as v from 'valibot';

import { MIN_NODES, unitsOf, type Unit } from './ast-duplication';
import { parseLock, type Plant } from './census-plants';
import { claims, deployGates, LADDER, packageScripts } from './ladder';
import {
  ANTI_SLOP_ROOT, ANTI_SLOP_RULES, isAntiSlopRuleSuite, isBunDiscoverableSuite, isParseable,
  isProductSource, isPythonSuite, isRunnableSuite, isStylesheet, isTestFile, isVitestEvalSuite,
  readRepositoryFile, readSources, trackedFiles, workspaceScope,
} from './sources';
import {
  classMembers, collapsePath, declaredName, importBindings, IMPORT_CANDIDATES, isFunctionLike,
  literalText, moduleSpecifiers, parse, stringArguments, superClassName, type SyntaxNode, walk,
} from './syntax';

const root = new URL('..', import.meta.url).pathname;

const LOCK = `${root}scripts/test-census.lock.json`;

/* ── The corpus ───────────────────────────────────────────────────────── */

/** The census's one narrowing: test code that parses, minus the vendored
 *  anti-slop plugin. Exported so the set measured here and the set a reader is
 *  told about cannot drift apart. */
export const isCensusFile = (file: string): boolean =>
  isTestFile(file) && isParseable(file) && !file.startsWith(ANTI_SLOP_ROOT);

/** How a suite ENTERS the system under test. `support` is not a suite: a helper,
 *  fixture module or probe worker that runs only through an import. */
export type Kind = 'unit' | 'integration' | 'e2e' | 'eval' | 'gate' | 'ui' | 'support';

/** Every defect axis. `public_surface_entry` and `external_seam_mock` are the
 *  GOOD directions, counted separately and never here. */
export const CATEGORIES = [
  'source_text', 'mirror', 'tautology_suspect', 'private_reach', 'internal_mock',
  'assertion_free', 'silent_skip', 'golden_regenerated',
] as const;

export type Category = (typeof CATEGORIES)[number];

/** The axes with no allowance: a finding fails `--ratchet` whatever the lock
 *  holds, and `--lock` refuses to run while one exists. A test that reads product
 *  source, restates product code, reaches a private member or mocks the tree's own
 *  module is rewritten at a public boundary or deleted; there is no deliberate
 *  exception to record. */
export const BANNED: readonly Category[] = ['source_text', 'mirror', 'private_reach', 'internal_mock'];

/** The axis the lock pins, which only shrinks: a NEW instance fails by name. The
 *  three left out of both lists are debt a reviewer reads rather than debt a
 *  commit adds — a declared skip is already governed by `skip-ratchet`, and a
 *  golden regeneration is a deliberate act with its own command. */
export const RATCHETED: readonly Category[] = ['tautology_suspect'];

export interface Finding {
  readonly file: string;
  readonly line: number;
  /** The `test(...)` title this sits inside, or `(file scope)`. This is the
   *  ratchet's identity: a new coupled TEST is a new name, while moving one
   *  twenty lines down is not. */
  readonly test: string;
  readonly what: string;
  readonly detail: string;
}

export interface FileRow {
  readonly file: string;
  readonly package: string;
  readonly kind: Kind;
  readonly runner: string;
  readonly tests: number;
  readonly source_text: number;
  readonly mirror: number;
  readonly tautology_suspect: number;
  readonly private_reach: number;
  readonly internal_mock: number;
  readonly external_seam_mock: number;
  readonly assertion_free: number;
  readonly silent_skip: number;
  readonly golden_regenerated: number;
  readonly public_surface_entry: number;
  /** Every named runner or gate that would execute this file. Empty on a
   *  runnable suite is the never-run finding; empty on `support` is normal. */
  readonly runners: readonly string[];
}

const FILE_SCOPE = '(file scope)';

function packageOf(file: string): string {
  if (file.startsWith('packages/')) return file.split('/')[1] ?? 'packages';

  if (file.startsWith('scripts/')) return 'scripts';

  if (file.startsWith('tests/')) return 'tests';

  return file.split('/')[0] ?? '(root)';
}

/* ── Parsing ─────────────────────────────────────────────────────────── */

interface ParsedFile {
  readonly file: string;
  readonly text: string;
  readonly tree: SyntaxNode;
  readonly lineAt: (offset: number) => number;
}

const parseCache = new Map<string, ParsedFile>();

/** One parse per file for the whole run. Parsing IS the cost here: the census
 *  asks eight questions of every test file and three of every module one
 *  imports. */
function parseFile(file: string, text: string): ParsedFile {
  const cached = parseCache.get(file);

  if (cached !== undefined && cached.text === text) return cached;
  const { root: tree, lineAt } = parse(file, text);
  const parsed: ParsedFile = { file, text, tree, lineAt };
  parseCache.set(file, parsed);

  return parsed;
}

/** `a.b.c` as text, for reading a matcher chain, a mock target or a callee. */
function chainText(node: Node | null | undefined): string {
  if (node === null || node === undefined) return '';

  if (node.type === 'Identifier') return node.name;

  if (node.type === 'ThisExpression') return 'this';

  if (node.type === 'MetaProperty') return `${node.meta.name}.${node.property.name}`;

  if (node.type === 'MemberExpression') {
    const named = node.property.type === 'Identifier' ? `.${node.property.name}` : '.?';

    return `${chainText(node.object)}${node.computed ? '[…]' : named}`;
  }

  if (node.type === 'CallExpression') return `${chainText(node.callee)}()`;

  if (node.type === 'AwaitExpression') return chainText(node.argument);

  return '?';
}

/** The callee's plain identifier name, or a member call's property name. */
function calleeName(node: SyntaxNode): string | undefined {
  const r = node.raw;

  if (r.type !== 'CallExpression') return undefined;

  if (r.callee.type === 'Identifier') return r.callee.name;

  if (r.callee.type === 'MemberExpression' && !r.callee.computed
    && r.callee.property.type === 'Identifier') return r.callee.property.name;

  return undefined;
}

/**
 * Argument nodes of a call, by position.
 *
 * `node.children` also holds the CALLEE, and taking `children[0]` as the first
 * argument is how `spyOn(console, 'error')` came to be reported as an internal
 * mock of `spyOn` itself.
 */
function argumentNodes(node: SyntaxNode): SyntaxNode[] {
  const r = node.raw;

  if (r.type !== 'CallExpression' && r.type !== 'NewExpression') return [];
  const starts = new Set(r.arguments.map((argument) => argument.start));

  return node.children.filter((child) => starts.has(child.start));
}

/** True when a call is handed a function to run — how a real `test(...)` is
 *  told from the `test.each(TABLE)` FACTORY that returns one. */
function hasFunctionArgument(node: SyntaxNode): boolean {
  return argumentNodes(node).some((argument) =>
    argument.raw.type === 'ArrowFunctionExpression' || argument.raw.type === 'FunctionExpression');
}

/** The exact node at a span, so `expect(a).toBe(b)` and its own `expect(a)`
 *  subcall are told apart — they share a start offset, and matching on start
 *  alone returned the whole expectation as its own subject. */
function nodeAt(node: SyntaxNode, start: number, end: number): SyntaxNode | undefined {
  let hit: SyntaxNode | undefined;
  walk(node, (candidate) => {
    if (hit === undefined && candidate.start === start && candidate.end === end) hit = candidate;
  });

  return hit;
}

/* ── Test spans ──────────────────────────────────────────────────────── */

interface TestSpan {
  readonly node: SyntaxNode;
  readonly title: string;
  readonly line: number;
  readonly modifier: string | undefined;
  readonly endLine: number;
}

const TEST_CALLS: ReadonlySet<string> = new Set(['test', 'it']);

const TEST_MODIFIERS: ReadonlySet<string> = new Set([
  'skip', 'todo', 'only', 'skipIf', 'todoIf', 'failing', 'each', 'concurrent', 'if',
]);

/**
 * Every `test(...)`/`it(...)` call, with its title, its modifier and the line
 * range it covers — the range is what attributes a finding to the test it sits
 * in, which is the ratchet's unit.
 *
 * A test must be handed a BODY. `test.each(TABLE)` is a factory whose call
 * carries the table and no function, and counting it as a test reports every
 * table-driven suite in cf-backend as assertion-free. `test.todo('name')` is the
 * one bodyless form that is really a test, and it is a finding by definition.
 */
function testSpans(parsed: ParsedFile): TestSpan[] {
  const spans: TestSpan[] = [];
  walk(parsed.tree, (node) => {
    const r = node.raw;

    if (r.type !== 'CallExpression') return;
    const callee = r.callee;
    let base: string | undefined;
    let modifier: string | undefined;

    if (callee.type === 'Identifier') {
      base = callee.name;
    } else if (callee.type === 'MemberExpression' && !callee.computed
      && callee.property.type === 'Identifier') {
      modifier = callee.property.name;
      base = callee.object.type === 'Identifier' ? callee.object.name : undefined;
    } else if (callee.type === 'CallExpression' && callee.callee.type === 'MemberExpression'
      && !callee.callee.computed && callee.callee.property.type === 'Identifier'
      && callee.callee.object.type === 'Identifier') {
      // `test.each(TABLE)('title', body)` / `test.skipIf(cond)('title', body)`.
      modifier = callee.callee.property.name;
      base = callee.callee.object.name;
    }

    if (base === undefined || !TEST_CALLS.has(base)) return;

    if (modifier !== undefined && !TEST_MODIFIERS.has(modifier)) return;
    const bodyless = modifier === 'todo';

    if (!bodyless && !hasFunctionArgument(node)) return;
    spans.push({
      node,
      title: stringArguments(node)[0] ?? '(untitled)',
      line: parsed.lineAt(node.start),
      modifier,
      endLine: parsed.lineAt(node.end),
    });
  });

  return spans;
}

/** Records a finding at a node of one parsed file, under the test its line
 *  falls inside. */
function finderIn(parsed: ParsedFile, spans: readonly TestSpan[]) {
  return (node: SyntaxNode, what: string, detail: string): Finding => {
    const line = parsed.lineAt(node.start);

    return { file: parsed.file, line, test: titleAt(spans, line), what, detail };
  };
}

/** The innermost test a line belongs to. `(file scope)` for module-level code:
 *  a shared helper, a fixture constant, a `beforeAll`. */
function titleAt(spans: readonly TestSpan[], line: number): string {
  let best: TestSpan | undefined;

  for (const span of spans) {
    if (line < span.line || line > span.endLine) continue;

    if (best === undefined || (span.endLine - span.line) < (best.endLine - best.line)) best = span;
  }

  return best?.title ?? FILE_SCOPE;
}

/* ── Local function facts ────────────────────────────────────────────── */

/** A name that asserts by convention when called: `assertWorkspaceResolution`,
 *  `expectRefused`, `requireAdmitted`, `assertMeasured`. */
const ASSERTING_IMPORT = /^(assert|expect|must|require|verify)[A-Z_]/u;

/** A filesystem read of TEXT. `vfs.readFile` is not one of these: it reads a
 *  workspace file inside the system under test, and counting it reported two
 *  executor tests as reading their own source. */
const FS_READ = /^(readFileSync|readFile)$/u;

const FS_OBJECT = /^(fs|fsp|promises|node:fs)$/u;

/** The source-reading assertion helpers `packages/test-utils/src/source.ts`
 *  exported until its last caller moved to behaviour tests (2026-09-23). Named,
 *  so a helper brought back under the same name is a finding at once. */
const SOURCE_HELPERS: ReadonlySet<string> = new Set(['memberBody', 'anchor', 'between']);

/**
 * The repository file a path literal names, or `undefined` when it names none.
 *
 * RESOLVED, NEVER PATTERN-MATCHED, and that is a set-equality rule rather than
 * a preference. A private regex — `(^|\/)(src|scripts)\/…` — is exactly the
 * shape `gate:set-equality` refuses: a second spelling of "a source file"
 * beside the one in `sources.ts`, free to drift narrower than the set it
 * reports on. Only a path the ENUMERATION holds counts, and what counts as
 * source is asked of the named predicates — so a path that is not in the tree
 * cannot be reported as read, which a pattern match would allow.
 *
 * EVERY ANCESTOR, because the literal is rarely the whole path. The two live
 * shapes are `join(import.meta.dir, '..', 'src/user/user-do.ts')` and
 * `` `${root}src/runtime.ts` ``, where the literal is relative to the package
 * root rather than to the suite's own directory, and `join(repositoryRoot,
 * path)`, where it is repo-relative. Resolving against the suite's directory
 * alone lost 20 real findings across six cf-backend suites — measured
 * 2026-09-01 — so the climb is what keeps this as wide as a pattern match.
 *
 * `isParseable` OR `isStylesheet`, AND NOT `isTestFile`, rather than
 * `isProductSource`: this census's own gate reads `scripts/ladder.ts`, and a
 * test reading a gate program off disk is the same coupling as one reading a
 * package's `src`. `unit-public-shell.test.ts` asserts the font order inside
 * the shipped `src/index.css`, which is the same coupling again over a file
 * `isTextSource` deliberately excludes. A test reading ANOTHER TEST is not —
 * that is a fixture, and the suites that check a fixture's own text are doing
 * something else.
 */
function productFileNamed(
  literal: string, from: string, tracked: ReadonlySet<string>,
): string | undefined {
  const parts = from.split('/');
  parts.pop();
  const candidates = literal.startsWith('.') ? [] : [collapsePath(literal)];

  for (let depth = parts.length; depth >= 0; depth -= 1) {
    candidates.push(collapsePath(`${parts.slice(0, depth).join('/')}/${literal}`));
  }

  return candidates.find((path) => tracked.has(path) && !isTestFile(path)
    && (isParseable(path) || isStylesheet(path)));
}

/** Every directory holding product source, for a listing that walks one. */
const productDirsOf = new WeakMap<ReadonlySet<string>, ReadonlySet<string>>();

/**
 * The product directory a CLIMBING path names: `join(import.meta.dir, '..',
 * 'src')` handed to a tree walker, or `'../..'` as the root of a scan. Only a
 * path that climbs out of the suite's own directory counts, because a
 * directory a test builds for itself (`join(tmp, 'src')`) shares the names.
 */
function productDirNamed(
  path: string, from: string, tracked: ReadonlySet<string>,
): string | undefined {
  if (!path.startsWith('..')) return undefined;
  let dirs = productDirsOf.get(tracked);

  if (dirs === undefined) {
    const built = new Set<string>();

    for (const file of tracked) {
      if (isTestFile(file) || !(isParseable(file) || isStylesheet(file))) continue;
      const parts = file.split('/');

      for (let depth = parts.length - 1; depth >= 0; depth -= 1) built.add(parts.slice(0, depth).join('/'));
    }

    dirs = built;
    productDirsOf.set(tracked, dirs);
  }

  const dir = collapsePath(`${from.split('/').slice(0, -1).join('/')}/${path}`);

  return dirs.has(dir) ? `${dir === '' ? '.' : dir}/` : undefined;
}

/** What a file's own code knows about paths into the product before any read. */
interface PathScope {
  /** Local functions that list a directory and read what they find: a tree walker. */
  readonly treeReaders: ReadonlySet<string>;
  /** `const root = join(import.meta.dir, '..', '..')`: variables naming a product path. */
  readonly pathValues: ReadonlyMap<string, string>;
  /** The same variables as the file spells them, relative to the suite: what a later
   *  `join(root, 'src', 'x.ts')` builds on. */
  readonly spelledPaths: ReadonlyMap<string, string>;
}

const NO_PATHS: PathScope = { treeReaders: new Set(), pathValues: new Map(), spelledPaths: new Map() };

interface LocalFacts {
  /** Functions that assert, transitively — through a helper, or by throwing. */
  readonly asserting: ReadonlySet<string>;
  /** Functions that RETURN source text, transitively: they read a product file
   *  or call something that does. `source('src/cli/routes.ts')` is the shape,
   *  and it is why an assertion on `routes` is an assertion on source. */
  readonly sourceReaders: ReadonlySet<string>;
  /** Whether a reference resolves to a binding holding source text: a source
   *  read, a `?raw` import, or a value derived from one. */
  readonly isSourceRef: (reference: SyntaxNode) => boolean;
  /** Whether a read sits in a mutation harness: a function that writes what it
   *  read out as a module and hands back no text. The mutant is executed, so what
   *  is asserted is behaviour. */
  readonly copiesSource: (read: SyntaxNode) => boolean;
  readonly paths: PathScope;
}

/** Calls that write a file: a mutation harness's copy of the module it mutates. */
const FILE_WRITES = new Set(['writeFileSync', 'writeFile', 'write']);

/** What a function hands back: each `return` argument of its own body, or an
 *  arrow's expression body. A nested function's returns are its own. */
function returnsOf(fn: SyntaxNode): SyntaxNode[] {
  const body = fn.raw.type === 'MethodDefinition' ? fn.children.find(isFunctionLike) ?? fn : fn;
  const { raw } = body;

  if (raw.type === 'ArrowFunctionExpression' && raw.expression) {
    const expression = nodeAt(body, raw.body.start, raw.body.end);

    return expression === undefined ? [] : [expression];
  }

  const found: SyntaxNode[] = [];

  const visit = (node: SyntaxNode): void => {
    for (const child of node.children) {
      if (isFunctionLike(child)) continue;

      if (child.raw.type === 'ReturnStatement' && child.raw.argument) {
        const argument = nodeAt(child, child.raw.argument.start, child.raw.argument.end);

        if (argument !== undefined) found.push(argument);
      }

      visit(child);
    }
  };

  visit(body);

  return found;
}

const FS_LIST = /^(readdirSync|readdir)$/u;

function isFsCall(chain: string, pattern: RegExp): boolean {
  const bare = chain.split('.').pop() ?? '';

  return pattern.test(chain) || (pattern.test(bare) && FS_OBJECT.test(chain.split('.')[0] ?? ''));
}

/**
 * The product file or directory a path expression names, if any, resolved by `named`. A path
 * whose every segment is known is judged as that one path; one with a computed segment (a
 * reader's parameter) is judged by the product path it is built on.
 */
function productPathNamed(
  argument: SyntaxNode, paths: PathScope, named: (path: string) => string | undefined,
): string | undefined {
  const joined = joinedSegments(argument, paths);

  if (joined !== undefined) return named(joined);
  let found: string | undefined;
  walk(argument, (inner) => {
    if (found !== undefined) return;

    if (inner.raw.type === 'Identifier' && !isPropertyName(inner)) {
      found = paths.pathValues.get(inner.raw.name);

      return;
    }

    const text = literalText(inner);

    if (text !== undefined) found = named(text);
  });

  return found;
}

/** Which product file (or, for a listing, directory) this call reads off
 *  disk, or `undefined` when it reads none. The path is the finding's own
 *  detail, so the question "does it read one" and the answer "which one" are
 *  one traversal. */
function productPathRead(
  node: SyntaxNode, from: string, tracked: ReadonlySet<string>, paths: PathScope = NO_PATHS,
): string | undefined {
  const r = node.raw;

  if (r.type !== 'CallExpression') return undefined;
  const chain = chainText(r.callee);
  const isFsRead = isFsCall(chain, FS_READ) || chain === 'Bun.file' || chain === 'readRepositoryFile';
  const isListing = isFsCall(chain, FS_LIST) || paths.treeReaders.has(chain);

  if (!isFsRead && !isListing) return undefined;

  const named = (path: string): string | undefined => productFileNamed(path, from, tracked)
    ?? (isListing ? productDirNamed(path, from, tracked) : undefined);

  for (const argument of argumentNodes(node)) {
    const found = productPathNamed(argument, paths, named);

    if (found !== undefined) return found;
  }

  return undefined;
}

/** Tree walkers and product path variables, read before any read is judged. */
function pathScope(parsed: ParsedFile, tracked: ReadonlySet<string>): PathScope {
  const treeReaders = new Set<string>();
  const pathValues = new Map<string, string>();
  const spelledPaths = new Map<string, string>();
  const scope: PathScope = { treeReaders, pathValues, spelledPaths };

  walk(parsed.tree, (node) => {
    if (isFunctionLike(node) || node.raw.type === 'ArrowFunctionExpression') {
      const name = functionName(node);
      let lists = false;
      let reads = false;
      walk(node, (inner) => {
        if (inner.raw.type !== 'CallExpression') return;
        const chain = chainText(inner.raw.callee);

        if (isFsCall(chain, FS_LIST)) lists = true;

        if (isFsCall(chain, FS_READ) || chain === 'Bun.file') reads = true;
      });

      if (name !== undefined && lists && reads) treeReaders.add(name);

      return;
    }

    if (node.raw.type !== 'VariableDeclarator') return;
    const name = declaredName(node);
    const init = node.raw.init;

    if (name === undefined || init === null || init === undefined) return;
    const initNode = nodeAt(node, init.start, init.end);
    // Declarations are met in source order, so `LANDING = resolve(ROOT, ...)` builds on `ROOT`.
    const joined = initNode === undefined ? undefined : joinedSegments(initNode, scope);

    const named = joined === undefined ? undefined
      : productFileNamed(joined, parsed.file, tracked) ?? productDirNamed(joined, parsed.file, tracked);

    if (named === undefined || joined === undefined) return;
    pathValues.set(name, named);
    spelledPaths.set(name, joined);
  });

  return scope;
}

/** The suite's own directory, where a relative climb starts. */
const SUITE_DIR = new Set(['import.meta.dir', 'import.meta.dirname', '__dirname']);

/**
 * The path a path-building expression spells, relative to the suite, when every segment is
 * known: `join(import.meta.dir, '..', 'src', 'actor-agent.ts')`, `join(import.meta.dir, '..')`,
 * `new URL('../', import.meta.url)` (bare, through `.pathname`, or handed to `fileURLToPath`), and
 * a join on a variable already known to name a product path. No single segment of
 * `join(import.meta.dir, '..', 'src', 'x.ts')` names a file, so reading them one at a time missed
 * 8 whole-file reads in `unit-turn-pipeline-correctness.test.ts` alone, and a root held in a
 * variable (`const root = join(import.meta.dir, '..')`) hid every `source('src/x.ts')` helper built
 * on it (measured 2026-09-23).
 *
 * Only a path anchored where resolution starts: the suite's directory, a literal, or a known
 * product path. `join(tmp, 'src', 'budget.ts')` is a file the test wrote, and its segments name a
 * product path by coincidence.
 */
function joinedSegments(node: SyntaxNode, paths: PathScope = NO_PATHS): string | undefined {
  const r = node.raw;

  if (r.type === 'MemberExpression' && !r.computed && chainText(r.property) === 'pathname') {
    const url = nodeAt(node, r.object.start, r.object.end);

    return url === undefined ? undefined : joinedSegments(url, paths);
  }

  if (r.type === 'NewExpression' && chainText(r.callee) === 'URL') {
    const [relative, base] = argumentNodes(node);

    return relative !== undefined && base !== undefined && chainText(base.raw) === 'import.meta.url'
      ? literalText(relative) : undefined;
  }

  if (r.type !== 'CallExpression') return undefined;
  const name = chainText(r.callee).split('.').pop();

  if (name === 'fileURLToPath') {
    const [url] = argumentNodes(node);

    return url === undefined ? undefined : joinedSegments(url, paths);
  }

  if (name !== 'join' && name !== 'resolve') return undefined;
  const [base, ...rest] = argumentNodes(node);

  if (base === undefined) return undefined;
  const known = base.raw.type === 'Identifier' ? paths.spelledPaths.get(base.raw.name) : undefined;
  // The suite's directory is where a relative path already starts, so it adds no segment.
  const head = SUITE_DIR.has(chainText(base.raw)) ? [] : [known ?? literalText(base)];
  const segments = [...head, ...rest.map((argument) => literalText(argument))];

  // A computed segment leaves the file unknown; the caller judges the product path it is built on.
  if (segments.length === 0 || segments.some((segment) => segment === undefined)) return undefined;

  // A lone literal is read as itself by the caller.
  if (segments.length === 1 && head.length === 1 && known === undefined) return undefined;

  return segments.join('/');
}

/** Where a function's name comes from: its own declaration, or the binding an
 *  arrow is assigned to. */
function functionName(node: SyntaxNode): string | undefined {
  const own = declaredName(node);

  if (own !== undefined) return own;
  const parent = node.parent;

  if (parent === undefined) return undefined;
  const type = parent.raw.type;

  if (type === 'VariableDeclarator' || type === 'PropertyDefinition' || type === 'Property') {
    return declaredName(parent);
  }

  return undefined;
}

/**
 * Which of a file's own functions assert, and which return source text.
 *
 * Both are transitive closures over local calls, because looking for the SHAPE
 * at the call site instead of following the file's own helper gets both wrong in
 * the same way: it counts 167 assertion-free tests where the closure finds 15,
 * and it reduces the source-text signal to "a string that also occurs in src" (a
 * majority-false-positive heuristic) rather than "the asserted value came out of
 * a file read".
 */
function localFacts(parsed: ParsedFile, tracked: ReadonlySet<string>): LocalFacts {
  interface Fn {
    readonly node: SyntaxNode;
    readonly direct: boolean;
    readonly reads: boolean;
    readonly writes: boolean;
    readonly calls: Set<string>;
    readonly returns: readonly SyntaxNode[];
  }

  const paths = pathScope(parsed, tracked);
  const fns = new Map<string, Fn>();

  walk(parsed.tree, (node) => {
    if (!isFunctionLike(node) && node.raw.type !== 'ArrowFunctionExpression') return;
    const name = functionName(node);

    if (name === undefined) return;
    let direct = false;
    let reads = false;
    let writes = false;
    const calls = new Set<string>();
    walk(node, (inner) => {
      if (inner.raw.type === 'ThrowStatement') direct = true;

      if (inner.raw.type !== 'CallExpression') return;
      const called = calleeName(inner);

      if (called === undefined) return;

      if (called === 'expect' || called === 'assert' || ASSERTING_IMPORT.test(called)) direct = true;

      if (SOURCE_HELPERS.has(called)
        || productPathRead(inner, parsed.file, tracked, paths) !== undefined) reads = true;

      if (FILE_WRITES.has(called)) writes = true;
      calls.add(called);
    });
    fns.set(name, { node, direct, reads, writes, calls, returns: returnsOf(node) });
  });

  const asserting = new Set([...fns].filter(([, f]) => f.direct).map(([name]) => name));
  // Grown below with the values, since each feeds the other.
  const sourceReaders = new Set<string>();

  for (let pass = 0; pass < 8; pass += 1) {
    let grew = false;

    for (const [name, fn] of fns) {
      for (const called of fn.calls) {
        if (!asserting.has(name) && asserting.has(called)) { asserting.add(name); grew = true; }
      }
    }

    if (!grew) break;
  }

  // Variables holding source text: `const routes = source('src/cli/routes.ts')`,
  // `const src = readFileSync(...)`, a `?raw` import binding, and anything
  // DERIVED from one: `const run = loop.slice(loop.indexOf('runTurn('))` is the
  // same file text, and missing it hid 274 of the tree's 425 source_text
  // findings (measured 2026-09-23). Resolved per binding, not per name: a
  // `source` read in one test says nothing about another test's `source`.
  const bindings = bindingsOf(parsed);
  const sourceValues = new Set<SyntaxNode>();
  const declarators: { readonly node: SyntaxNode; readonly init: SyntaxNode }[] = [];
  walk(parsed.tree, (node) => {
    if (node.raw.type === 'ImportDeclaration' && String(node.raw.source.value).includes('?raw')) {
      sourceValues.add(node);

      return;
    }

    if (node.raw.type !== 'VariableDeclarator') return;
    const init = node.raw.init;

    if (declaredName(node) === undefined || init === null || init === undefined) return;
    const initNode = nodeAt(node, init.start, init.end);

    if (initNode !== undefined) declarators.push({ node, init: initNode });
  });

  const isSourceRef = (reference: SyntaxNode): boolean => {
    const bound = bindings.resolve(reference);

    return bound !== undefined && sourceValues.has(bound);
  };

  /** A mutation harness: it writes what it read out as a module and hands back no text. */
  const isHarness = (fn: Fn): boolean => fn.writes && !fn.returns.some((returned) => holdsSource(returned));

  /** A read, a reader's call, or a reference to a value holding source text. */
  const holdsSource = (node: SyntaxNode): boolean => {
    let found = false;
    walk(node, (inner) => {
      if (found) return;

      if (inner.raw.type === 'Identifier' && !isPropertyName(inner) && isSourceRef(inner)) {
        found = true;

        return;
      }

      const called = calleeName(inner);

      if (called === undefined) return;

      if (SOURCE_HELPERS.has(called) || sourceReaders.has(called)
        || productPathRead(inner, parsed.file, tracked, paths) !== undefined) {
        found = true;
      }
    });

    return found;
  };

  for (let grew = true; grew;) {
    grew = false;

    for (const { node, init } of declarators) {
      if (sourceValues.has(node) || !holdsSource(init)) continue;
      sourceValues.add(node);
      grew = true;
    }

    for (const [name, fn] of fns) {
      if (sourceReaders.has(name) || isHarness(fn)) continue;

      if (fn.reads || [...fn.calls].some((called) => sourceReaders.has(called))) {
        sourceReaders.add(name);
        grew = true;
      }
    }
  }

  const harnesses = [...fns.values()].filter(isHarness);

  const copiesSource = (read: SyntaxNode): boolean =>
    harnesses.some((fn) => fn.node.start <= read.start && read.end <= fn.node.end);

  return { asserting, sourceReaders, isSourceRef, copiesSource, paths };
}

/** A non-computed member property is a NAME, never a variable reference:
 *  `agent.beforeTurn(turn)` reads no `beforeTurn` binding. */
function isPropertyName(node: SyntaxNode): boolean {
  const parent = node.parent?.raw;

  return parent?.type === 'MemberExpression' && !parent.computed
    && parent.property.start === node.start && parent.property.end === node.end;
}

/** Where each name in a file is bound, per function scope (block scope is read as its function's). */
interface Bindings {
  /** The declaration a reference resolves to: its nearest enclosing binding of that name. */
  resolve(reference: SyntaxNode): SyntaxNode | undefined;
}

function isScope(node: SyntaxNode): boolean {
  return isFunctionLike(node) || node.raw.type === 'ArrowFunctionExpression' || node.parent === undefined;
}

/** Every name a binding pattern introduces: `x`, `{ rt, db: store }`, `[first, ...rest]`, `x = 1`. */
function patternNames(pattern: Node | null | undefined): string[] {
  if (pattern === null || pattern === undefined) return [];

  if (pattern.type === 'Identifier') return [pattern.name];

  if (pattern.type === 'AssignmentPattern') return patternNames(pattern.left);

  if (pattern.type === 'RestElement') return patternNames(pattern.argument);

  if (pattern.type === 'ArrayPattern') return pattern.elements.flatMap((element) => patternNames(element));

  if (pattern.type === 'ObjectPattern') {
    return pattern.properties.flatMap((property) => patternNames(property.type === 'RestElement' ? property : property.value));
  }

  return [];
}

function bindingsOf(parsed: ParsedFile): Bindings {
  const byScope = new Map<SyntaxNode, Map<string, SyntaxNode>>();

  const declare = (scope: SyntaxNode, name: string, node: SyntaxNode): void => {
    const names = byScope.get(scope) ?? new Map<string, SyntaxNode>();
    names.set(name, node);
    byScope.set(scope, names);
  };

  const enclosing = (node: SyntaxNode): SyntaxNode => {
    let up = node.parent;

    while (up !== undefined && !isScope(up)) up = up.parent;

    return up ?? parsed.tree;
  };

  walk(parsed.tree, (node) => {
    const r = node.raw;

    if (r.type === 'VariableDeclarator' || r.type === 'ImportDeclaration') {
      const names = r.type === 'ImportDeclaration' ? importBindings(node).map((bound) => bound.local) : patternNames(r.id);

      for (const name of names) declare(enclosing(node), name, node);

      return;
    }

    if ((r.type === 'FunctionDeclaration' || r.type === 'ClassDeclaration') && r.id !== null) {
      declare(enclosing(node), r.id.name, node);
    }

    if (!isFunctionLike(node) && r.type !== 'ArrowFunctionExpression') return;
    const params = 'params' in r ? r.params : [];

    for (const param of params) for (const name of patternNames(param)) declare(node, name, node);
  });

  return {
    resolve(reference) {
      if (reference.raw.type !== 'Identifier') return undefined;
      const name = reference.raw.name;

      for (let up = reference.parent; up !== undefined; up = up.parent) {
        const bound = byScope.get(up)?.get(name);

        if (bound !== undefined) return bound;
      }

      return undefined;
    },
  };
}

/* ── Expectations ────────────────────────────────────────────────────── */

interface Expectation {
  /** The whole matcher call: `expect(a).not.toBe(b)`. */
  readonly call: SyntaxNode;
  readonly matcher: string;
  /** Modifiers between `expect()` and the matcher: `not`, `rejects`, `resolves`. */
  readonly modifiers: readonly string[];
  /** The `expect(...)` call, whose argument is the ACTUAL side. */
  readonly subject: SyntaxNode | undefined;
}

/** Every `expect(actual).<mods>.<matcher>(expected)`, read off the member chain
 *  rather than off text, so `expect(x).not.toThrow()` and
 *  `expect(p).rejects.toThrow()` are one shape with two modifier lists. */
function expectations(parsed: ParsedFile): Expectation[] {
  const found: Expectation[] = [];
  walk(parsed.tree, (node) => {
    const r = node.raw;

    if (r.type !== 'CallExpression' || r.callee.type !== 'MemberExpression') return;

    if (r.callee.computed || r.callee.property.type !== 'Identifier') return;
    const matcher = r.callee.property.name;
    const modifiers: string[] = [];
    let object: Node = r.callee.object;

    while (object.type === 'MemberExpression' && !object.computed
      && object.property.type === 'Identifier') {
      modifiers.unshift(object.property.name);
      object = object.object;
    }

    if (object.type !== 'CallExpression' || object.callee.type !== 'Identifier'
      || object.callee.name !== 'expect') return;
    found.push({
      call: node, matcher, modifiers, subject: nodeAt(node, object.start, object.end),
    });
  });

  return found;
}

/* ── source_text ─────────────────────────────────────────────────────── */

/**
 * Assertions about the implementation's TEXT, in the forms this tree uses: a
 * filesystem read of a product path, one of the source helpers, a `?raw`
 * import, and an expectation whose SUBJECT is one of those values.
 *
 * The last is the load-bearing one, and it replaced a heuristic that produced
 * 102 findings of which most were behavioural: `expect(cookie).toContain(
 * 'SameSite=Lax')` shares a string with the code that sets the cookie, and that
 * sharing is the assertion working, not coupling. Coupling is asserting over the
 * FILE.
 */
function sourceText(
  parsed: ParsedFile,
  spans: readonly TestSpan[],
  facts: LocalFacts,
  tracked: ReadonlySet<string>,
): Finding[] {
  const found: Finding[] = [];
  const at = finderIn(parsed, spans);

  walk(parsed.tree, (node) => {
    const r = node.raw;

    if (r.type === 'ImportDeclaration' && String(r.source.value).includes('?raw')) {
      found.push(at(node, 'raw source import', String(r.source.value)));

      return;
    }

    if (r.type !== 'CallExpression') return;
    const called = calleeName(node);

    if (called !== undefined && SOURCE_HELPERS.has(called)) {
      found.push(at(node, `${called}() over source text`, (stringArguments(node)[0] ?? '').slice(0, 70)));

      return;
    }

    const read = productPathRead(node, parsed.file, tracked, facts.paths);

    if (read !== undefined && !facts.copiesSource(node)) found.push(at(node, 'reads a source file', read));
  });

  for (const expectation of expectations(parsed)) {
    if (expectation.subject === undefined) continue;
    const [actual] = argumentNodes(expectation.subject);

    if (actual === undefined) continue;
    let overSource: string | undefined;
    walk(actual, (inner) => {
      if (overSource !== undefined) return;
      // A method name is not a read of a source binding that happens to share it.
      const name = inner.raw.type === 'Identifier' && !isPropertyName(inner) ? inner.raw.name : undefined;

      if (name !== undefined && facts.isSourceRef(inner)) {
        overSource = name;

        return;
      }

      const called = calleeName(inner);

      if (called !== undefined && (SOURCE_HELPERS.has(called) || facts.sourceReaders.has(called))) {
        overSource = `${called}()`;
      }
    });

    if (overSource === undefined) continue;

    const expected = argumentNodes(expectation.call).map((argument) => literalText(argument))
      .find((text) => text !== undefined) ?? '';

    found.push(at(
      expectation.call,
      `expect(<source text>).${[...expectation.modifiers, expectation.matcher].join('.')}`,
      `over ${overSource}: ${expected.replace(/\s+/gu, ' ').slice(0, 60)}`,
    ));
  }

  return found;
}

/* ── tautology_suspect ───────────────────────────────────────────────── */

/** Matchers that assert presence or "it ran" and nothing about the value. A
 *  `toThrow('a specific message')` is NOT one of these — the argument is the
 *  assertion — so weakness is decided per call site, not per matcher name. */
function isWeak(expectation: Expectation): boolean {
  const { matcher, modifiers } = expectation;

  if (matcher === 'toBeDefined' || matcher === 'toBeTruthy') return true;

  if (matcher === 'toThrow' || matcher === 'toThrowError') {
    if (modifiers.includes('not')) return true;

    return argumentNodes(expectation.call).length === 0;
  }

  return false;
}

/**
 * Two shapes that read as coverage and cannot fail on the defect the test names:
 *   - a test whose EVERY assertion is weak. A function returning the wrong value
 *     passes `toBeDefined`, `toBeTruthy` and a bare `toThrow` alike.
 *   - an expectation whose EXPECTED side calls the same imported function the
 *     ACTUAL side calls: `expect(build(a)).toEqual(build(b))` asserts that the
 *     implementation agrees with itself. A determinism check has this shape
 *     legitimately, which is why the finding names the function and leaves the
 *     ruling to the reviewer.
 */
function tautologies(
  parsed: ParsedFile,
  spans: readonly TestSpan[],
  localNames: ReadonlySet<string>,
): Finding[] {
  const found: Finding[] = [];
  const all = expectations(parsed);

  for (const span of spans) {
    const mine = all.filter((e) => e.call.start >= span.node.start && e.call.end <= span.node.end);

    if (mine.length === 0 || !mine.every(isWeak)) continue;
    found.push({
      file: parsed.file, line: span.line, test: span.title,
      what: 'weak-only test',
      detail: `every assertion is ${[...new Set(mine.map((e) => `${e.modifiers.join('.')}${e.modifiers.length > 0 ? '.' : ''}${e.matcher}`))].join('/')} (${String(mine.length)})`,
    });
  }

  for (const expectation of all) {
    if (expectation.subject === undefined) continue;
    const [actual] = argumentNodes(expectation.subject);

    if (actual === undefined) continue;
    const left = calledLocalNames(actual, localNames);

    if (left.size === 0) continue;
    const right = new Set<string>();

    for (const argument of argumentNodes(expectation.call)) {
      for (const name of calledLocalNames(argument, localNames)) right.add(name);
    }

    const shared = [...left].filter((name) => right.has(name));

    if (shared.length === 0) continue;
    const line = parsed.lineAt(expectation.call.start);
    found.push({
      file: parsed.file, line, test: titleAt(spans, line),
      what: 'expected side computed by the code under test',
      detail: `both sides call ${shared.join(', ')}`,
    });
  }

  return found;
}

/** Names of functions imported from a LOCAL module that this node calls. */
function calledLocalNames(node: SyntaxNode, localNames: ReadonlySet<string>): Set<string> {
  const names = new Set<string>();
  walk(node, (inner) => {
    const called = calleeName(inner);

    if (called !== undefined && localNames.has(called)) names.add(called);
  });

  return names;
}

/* ── mirror ──────────────────────────────────────────────────────────── */

/** Values shared by accident all day: small counts, HTTP statuses, years. A
 *  mirror is only a finding when the shared value is distinctive — `4096`,
 *  `1_800_000`, a SQL fragment. */
const HTTP_STATUS: ReadonlySet<number> = new Set([
  200, 201, 202, 204, 301, 302, 304, 400, 401, 403, 404, 405, 409, 410, 413, 422, 429,
  500, 501, 502, 503, 504,
]);

/** A number distinctive enough that sharing it is a fact rather than a
 *  coincidence. */
function distinctiveNumber(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const magnitude = Math.abs(value);

  if (magnitude < 32) return false;

  if (HTTP_STATUS.has(magnitude)) return false;

  return !(Number.isInteger(magnitude) && magnitude >= 1900 && magnitude <= 2100);
}

/** A string distinctive enough for the same reason: long, and not one lowercase
 *  word. `'kinu-prompt-marker'` is a fact; `'alpha'` is a fixture name. */
const distinctiveString = (value: string): boolean =>
  value.length >= 6 && /[^a-z]/u.test(value);

/** A named literal, with its kind decided WHERE THE LITERAL IS READ. oxc gives a
 *  string and a number literal the same node type and differing `value`, so the
 *  kind is a fact about the parser's output — parsed once at this boundary, the
 *  same way `syntax.ts` decodes its own literals, so no comparison downstream has
 *  to re-derive it. */
interface NamedValue {
  readonly name: string;
  readonly line: number;
  readonly kind: 'number' | 'string';
  readonly value: string | number;
}

const NumberLiteral = v.object({ value: v.number() });

const StringLiteral = v.object({ value: v.string() });

/** A numeric constant expression's value: `5 * 60 * 1000` is `300_000`. Anything that is not
 *  literal arithmetic is `undefined`. */
function foldedNumber(node: Node): number | undefined {
  if (node.type === 'Literal') {
    const literal = v.safeParse(NumberLiteral, node);

    return literal.success ? literal.output.value : undefined;
  }

  if (node.type === 'ParenthesizedExpression') return foldedNumber(node.expression);

  if (node.type === 'UnaryExpression' && node.operator === '-') {
    const inner = foldedNumber(node.argument);

    return inner === undefined ? undefined : -inner;
  }

  if (node.type !== 'BinaryExpression' || node.left.type === 'PrivateIdentifier') return undefined;
  const left = foldedNumber(node.left);
  const right = foldedNumber(node.right);

  if (left === undefined || right === undefined) return undefined;

  if (node.operator === '+') return left + right;

  if (node.operator === '-') return left - right;

  if (node.operator === '*') return left * right;

  if (node.operator === '/') return left / right;

  return node.operator === '**' ? left ** right : undefined;
}

/** Names a module exports: `export const X`, and `export { X }` over a local binding. */
function exportedNames(parsed: ParsedFile): Set<string> {
  const names = new Set<string>();
  walk(parsed.tree, (node) => {
    const r = node.raw;

    if (r.type !== 'ExportNamedDeclaration') return;

    if (r.declaration?.type === 'VariableDeclaration') {
      for (const declarator of r.declaration.declarations) for (const name of patternNames(declarator.id)) names.add(name);
    }

    if (r.source !== null) return;

    for (const specifier of r.specifiers) if (specifier.local.type === 'Identifier') names.add(specifier.local.name);
  });

  return names;
}

/** `const NAME = <literal>` declarations at any depth, a numeric constant expression folded — the
 *  shape a mirrored budget, cap or threshold takes on both sides. Only distinctive values are
 *  returned, because a shared `2` is noise and 1,176 rows of it drowned the 53 real mirrors on
 *  this tree. `only` narrows a module to the names a test could import instead. */
function namedValues(parsed: ParsedFile, only?: ReadonlySet<string>): NamedValue[] {
  const found: NamedValue[] = [];
  walk(parsed.tree, (node) => {
    if (node.raw.type !== 'VariableDeclarator') return;
    const name = declaredName(node);
    const init = node.raw.init;

    if (name === undefined || init === null || init === undefined || (only !== undefined && !only.has(name))) return;
    const line = parsed.lineAt(node.start);
    const folded = foldedNumber(init);

    if (folded !== undefined) {
      if (distinctiveNumber(folded)) found.push({ name, line, kind: 'number', value: folded });

      return;
    }

    if (init.type !== 'Literal') return;

    const asString = v.safeParse(StringLiteral, init);

    if (asString.success && distinctiveString(asString.output.value)) {
      found.push({ name, line, kind: 'string', value: asString.output.value });
    }
  });

  return found;
}

/** One-expression arrow bodies by the name they are bound to — the second
 *  mirror shape: a test-local reimplementation of a module's own one-liner,
 *  which agrees with it by construction and cannot catch it being wrong. */
function arrowBodies(parsed: ParsedFile): Map<string, string> {
  const bodies = new Map<string, string>();
  walk(parsed.tree, (node) => {
    if (node.raw.type !== 'ArrowFunctionExpression') return;
    const name = functionName(node);

    if (name === undefined || node.raw.body.type === 'BlockStatement') return;

    const body = parsed.text.slice(node.raw.body.start, node.raw.body.end)
      .replace(/\s+/gu, ' ').trim();

    if (body.length >= 16) bodies.set(name, body);
  });

  return bodies;
}

/** Product function bodies at `ast-duplication.ts`'s floor, by fingerprint: node kinds with
 *  identifiers reduced to their order of first use and literal text kept. The first body in path
 *  order stands for a fingerprint several product files share. */
export function productUnitsOf(sources: ReadonlyMap<string, string>): Map<string, Unit> {
  const units = new Map<string, Unit>();

  for (const file of [...sources.keys()].sort()) {
    const text = sources.get(file) ?? '';
    const parsed = parseFile(file, text);

    for (const unit of unitsOf(file, { root: parsed.tree, lineAt: parsed.lineAt })) {
      if (unit.size >= MIN_NODES && !units.has(unit.hash)) units.set(unit.hash, unit);
    }
  }

  return units;
}

/**
 * The third mirror shape, and the one a comment used to stand for: a test function whose body is a
 * product function's with the names changed. It agrees with the product by construction, so it
 * cannot catch the product being wrong, and it keeps agreeing with the old code after the product
 * moves. Any product file counts, imported or not: a probe that re-implements an adapter it never
 * imports is the common case. A body nested in a matched body is the same copy, reported once.
 */
function mirroredFunctions(
  parsed: ParsedFile,
  spans: readonly TestSpan[],
  productUnits: ReadonlyMap<string, Unit>,
): Finding[] {
  const matched = unitsOf(parsed.file, { root: parsed.tree, lineAt: parsed.lineAt })
    .flatMap((unit) => {
      const original = productUnits.get(unit.hash);

      return unit.size >= MIN_NODES && original !== undefined ? [{ unit, original }] : [];
    });

  return matched
    .filter(({ unit }) => !matched.some(({ unit: outer }) =>
      outer !== unit && outer.start <= unit.start && outer.end >= unit.end))
    .map(({ unit, original }) => ({
      file: parsed.file, line: unit.line, test: titleAt(spans, unit.line),
      what: 'mirrored function',
      detail: `${unit.name} restates ${original.file}:${String(original.line)} ${original.name}`,
    }));
}

function mirrors(
  parsed: ParsedFile,
  spans: readonly TestSpan[],
  imported: readonly string[],
  inputs: Pick<CensusInputs, 'sources' | 'productUnits'>,
): Finding[] {
  const found = mirroredFunctions(parsed, spans, inputs.productUnits);

  if (imported.length === 0) return found;

  const testValues = namedValues(parsed);
  const testArrows = arrowBodies(parsed);

  if (testValues.length === 0 && testArrows.size === 0) return found;

  for (const module of imported) {
    const text = inputs.sources.get(module);

    if (text === undefined) continue;
    // No `try` here on purpose: `parse` already refuses loudly and names the
    // file, and a census that silently drops a module it cannot read measures a
    // narrower corpus than it reports — the defect this repository keeps finding
    // in its own gates.
    const parsedModule = parseFile(module, text);

    const byValue = new Map<string, string[]>();

    // Only an exported constant: the test could import it instead. A value the module keeps to
    // itself (an endpoint, a header) is a contract the test states from outside, and asserting
    // what the code did against it is the behaviour test.
    for (const entry of namedValues(parsedModule, exportedNames(parsedModule))) {
      const key = `${entry.kind}:${String(entry.value)}`;
      const names = byValue.get(key) ?? [];
      names.push(entry.name);
      byValue.set(key, names);
    }

    for (const entry of testValues) {
      const names = byValue.get(`${entry.kind}:${String(entry.value)}`);

      if (names === undefined) continue;
      found.push({
        file: parsed.file, line: entry.line, test: titleAt(spans, entry.line),
        what: 'mirrored constant',
        detail: `${entry.name} = ${JSON.stringify(entry.value)} duplicates ${names.join('/')} in ${module}`,
      });
    }

    const moduleBodies = new Set(arrowBodies(parsedModule).values());

    for (const [name, body] of testArrows) {
      if (!moduleBodies.has(body)) continue;
      found.push({
        file: parsed.file, line: 0, test: FILE_SCOPE,
        what: 'mirrored body',
        detail: `${name} duplicates a one-line body in ${module}: ${body.slice(0, 60)}`,
      });
    }
  }

  return found;
}

/* ── private_reach ───────────────────────────────────────────────────── */

/** Members production DECLARES non-public, by file. `x['settleTurn']` is a
 *  private reach when `settleTurn` is declared `private` somewhere in product
 *  source, and a dictionary lookup when it is not — which is the difference
 *  between 30 findings and the 8 that are real. */
export function nonPublicMembers(sources: ReadonlyMap<string, string>): Map<string, string> {
  const owners = new Map<string, string>();

  for (const [file, text] of sources) {
    if (!/\b(private|protected)\s|#[A-Za-z_]/u.test(text)) continue;
    // Parsed without a tolerance: `parse` names the file it cannot read, and a
    // dropped module here would silently shrink the set of members the census
    // can call non-public, turning private reaches into dictionary lookups.
    const parsed = parseFile(file, text);
    walk(parsed.tree, (node) => {
      if (node.raw.type !== 'ClassDeclaration' && node.raw.type !== 'ClassExpression') return;

      for (const member of classMembers(node)) {
        const r = member.raw;
        const accessibility = 'accessibility' in r ? r.accessibility : undefined;
        const isPrivateName = 'key' in r && r.key !== null && r.key.type === 'PrivateIdentifier';

        if (accessibility !== 'private' && accessibility !== 'protected' && !isPrivateName) continue;
        const name = declaredName(member);

        if (name !== undefined && !owners.has(name)) owners.set(name, file);
      }
    });
  }

  return owners;
}

/**
 * The same declarations, keyed by the CLASS that makes them, plus each class's
 * base — so "non-public" can be asked of one inheritance chain instead of the
 * whole tree.
 *
 * {@link nonPublicMembers} is keyed by member name alone, which is right for a
 * bracket reach (`x['settleTurn']` names no class) and wrong for a harness
 * bridge, which knows exactly which class it extends. Measured: eight ratchet
 * keys said `harnessDrivingUserMessage() -> messages` crossed a boundary. It
 * does not. `this.messages` on `HarnessOrchestratorAgent` is `AIChatAgent`'s
 * PUBLIC field, declared in `node_modules/agents` and not in product source at
 * all; the name was marked non-public because an unrelated core class,
 * `orchestrator/actor-session.ts`'s `ActorSession`, declares
 * `private readonly messages`. One name, two classes, and the census reported
 * the wrong one — the same collision shape `gate:wired`'s parameter table had.
 */
export interface ClassMembers {
  /** `Class#member` production declares non-public -> the file declaring it. */
  readonly nonPublic: ReadonlyMap<string, string>;
  /** `Class#member` production declares public: a test class overriding one of these adds no door. */
  readonly declaredPublic: ReadonlySet<string>;
  /** `Class -> the class it extends`, for walking a helper's chain. */
  readonly base: ReadonlyMap<string, string>;
}

export function classNonPublicMembers(sources: ReadonlyMap<string, string>): ClassMembers {
  const nonPublic = new Map<string, string>();
  const declaredPublic = new Set<string>();
  const base = new Map<string, string>();

  for (const [file, text] of sources) {
    const parsed = parseFile(file, text);
    walk(parsed.tree, (node) => {
      if (node.raw.type !== 'ClassDeclaration' && node.raw.type !== 'ClassExpression') return;
      const owner = declaredName(node);

      if (owner === undefined) return;
      const parent = superClassName(node);

      if (parent !== undefined) base.set(owner, parent);

      for (const member of classMembers(node)) {
        const name = declaredName(member);

        if (name === undefined) continue;

        if (isNonPublicMember(member)) nonPublic.set(`${owner}#${name}`, file);
        else declaredPublic.add(`${owner}#${name}`);
      }
    });
  }

  return { nonPublic, declaredPublic, base };
}

/** `private`, `protected` or a `#name`: a member a caller outside the class cannot reach. */
function isNonPublicMember(member: SyntaxNode): boolean {
  const r = member.raw;
  const accessibility = 'accessibility' in r ? r.accessibility : undefined;
  const isPrivateName = 'key' in r && r.key !== null && r.key.type === 'PrivateIdentifier';

  return accessibility === 'private' || accessibility === 'protected' || isPrivateName;
}

/** Bracket access to a member production declares non-public, `as any`,
 *  `as unknown as`, and `Reflect.get`. The first reads a private field without
 *  the compiler objecting; the others call a protected method. */
function privateReaches(
  parsed: ParsedFile,
  spans: readonly TestSpan[],
  nonPublic: ReadonlyMap<string, string>,
): Finding[] {
  const found: Finding[] = [];
  const at = finderIn(parsed, spans);

  walk(parsed.tree, (node) => {
    const r = node.raw;

    if (r.type === 'MemberExpression' && r.computed && r.property.type === 'Literal') {
      const key = v.safeParse(StringLiteral, r.property);

      if (!key.success) return;
      const owner = nonPublic.get(key.output.value);

      if (owner !== undefined) {
        found.push(at(node, 'bracket reach to a non-public member',
          `${chainText(r.object)}['${key.output.value}'] — declared non-public in ${owner}`));
      }

      return;
    }

    if (r.type === 'TSAsExpression') {
      if (r.typeAnnotation.type === 'TSAnyKeyword') {
        found.push(at(node, 'as any', chainText(r.expression).slice(0, 60)));
      } else if (r.expression.type === 'TSAsExpression'
        && r.expression.typeAnnotation.type === 'TSUnknownKeyword') {
        found.push(at(node, 'as unknown as', chainText(r.expression.expression).slice(0, 60)));
      }

      return;
    }

    if (r.type === 'CallExpression' && chainText(r.callee) === 'Reflect.get') {
      found.push(at(node, 'Reflect.get', stringArguments(node).join(', ').slice(0, 60)));
    }
  });

  return found;
}

/* ── Test-helper bridges ─────────────────────────────────────────────── */

/**
 * A public member of a test-side class, whatever it is called, that republishes
 * a member its production base declares non-public: directly, through another
 * member of the same class, or by widening a protected member to public on
 * override. Each is a door a test enters through that production has not got.
 *
 * The name is not the signal. This detector once matched `harness*` names only,
 * and measured on b2c60d09f (2026-09-23) that left 21 bridges unseen, 190 reaches
 * across 35 files: `observeRuntime()` alone reached the protected runtime 80
 * times. A member that overrides a PUBLIC production member adds no door, so
 * `getModel()` on a harness that scripts its model is not one.
 */
export interface Bridge {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  /** Members of the production chain it reaches, directly or through its own class. */
  readonly forwards: readonly string[];
  /** Of those, the ones production declares `private`/`protected`: the evidence
   *  the bridge crosses a boundary. */
  readonly nonPublic: readonly string[];
}

/** The classes above `cls`, nearest first, as far as product source declares them. */
function baseChain(cls: SyntaxNode, classes: ClassMembers): string[] {
  const chain: string[] = [];
  let up = superClassName(cls);

  for (let hop = 0; up !== undefined && hop < 16; hop += 1) {
    chain.push(up);
    up = classes.base.get(up);
  }

  return chain;
}

/** `this.x` and `super.x` names a member body reads, and the `#x` names it reads. */
function selfReferences(fn: SyntaxNode): Set<string> {
  const names = new Set<string>();
  walk(fn, (inner) => {
    const r = inner.raw;

    if (r.type !== 'MemberExpression' || r.computed) return;

    if (r.object.type !== 'ThisExpression' && r.object.type !== 'Super') return;

    if (r.property.type === 'PrivateIdentifier') names.add(`#${r.property.name}`);
    else if (r.property.type === 'Identifier') names.add(r.property.name);
  });

  return names;
}

/** Every public member of every class in one test file whose base chain product source declares. */
export function bridgesOf(file: string, text: string, classes: ClassMembers): Bridge[] {
  const parsed = parseFile(file, text);
  const found: Bridge[] = [];
  walk(parsed.tree, (cls) => {
    if (cls.raw.type !== 'ClassDeclaration' && cls.raw.type !== 'ClassExpression') return;
    const chain = baseChain(cls, classes);

    if (chain.length === 0) return;

    const inChain = (member: string, table: ReadonlySet<string> | ReadonlyMap<string, string>): boolean =>
      chain.some((owner) => table.has(`${owner}#${member}`));

    const members = new Map<string, { readonly node: SyntaxNode; readonly reads: Set<string> }>();

    for (const member of classMembers(cls)) {
      const name = declaredName(member);
      const raw = member.raw;

      const fn = raw.type === 'PropertyDefinition'
        ? member.children.find((child) => child.raw === raw.value && isFunctionLike(child))
        : member.children.find(isFunctionLike);

      if (name === undefined || name === 'constructor' || fn === undefined) continue;
      members.set(name, { node: member, reads: selfReferences(fn) });
    }

    const reached = (name: string, seen: Set<string>): Set<string> => {
      const out = new Set<string>();

      for (const read of members.get(name)?.reads ?? []) {
        out.add(read);

        if (read === name || !members.has(read) || seen.has(read)) continue;
        seen.add(read);

        for (const deeper of reached(read, seen)) out.add(deeper);
      }

      return out;
    };

    for (const [name, { node }] of members) {
      if (isNonPublicMember(node) || inChain(name, classes.declaredPublic)) continue;
      const forwards = reached(name, new Set([name]));

      // An override that widens a protected member to public is itself the door.
      if (inChain(name, classes.nonPublic)) forwards.add(name);
      found.push({
        name,
        file: parsed.file,
        line: parsed.lineAt(node.start),
        forwards: [...forwards].sort(),
        nonPublic: [...forwards].filter((member) => inChain(member, classes.nonPublic)).sort(),
      });
    }
  });

  return found;
}

/** Reaches of a bridge that really crosses the boundary, a call or a getter
 *  read, counted only OUTSIDE the file that declares it: inside, they are the
 *  helper's own plumbing, which the blind spots measure. */
function bridgeReaches(
  parsed: ParsedFile,
  spans: readonly TestSpan[],
  bridges: ReadonlyMap<string, Bridge>,
): Finding[] {
  const found: Finding[] = [];
  walk(parsed.tree, (node) => {
    const r = node.raw;

    if (r.type !== 'MemberExpression' || r.computed || r.property.type !== 'Identifier') return;
    const bridge = bridges.get(r.property.name);

    if (bridge === undefined || bridge.file === parsed.file || bridge.nonPublic.length === 0) return;
    const line = parsed.lineAt(node.start);
    found.push({
      file: parsed.file, line, test: titleAt(spans, line),
      what: 'harness bridge to a non-public member',
      detail: `${bridge.name} -> ${bridge.nonPublic.join(', ')} (${bridge.file}:${String(bridge.line)})`,
    });
  });

  return found;
}

/* ── Mocks ───────────────────────────────────────────────────────────── */

const MOCK_REGISTRARS: ReadonlySet<string> = new Set([
  'module', 'mockModule', 'registerSynchronousMock', 'doMock', 'unstable_mockModule',
]);

interface MockSplit { readonly internal: Finding[]; readonly external: Finding[] }

/** Where a spied object comes from: the platform (a global or a bare package), the test itself (a
 *  literal, a class or function it declares), or our code (anything else, a parameter included). */
type Origin = 'platform' | 'test' | 'ours';

const CONSTRUCTED = new Set(['ObjectExpression', 'ArrayExpression', 'ArrowFunctionExpression', 'FunctionExpression',
  'ClassExpression', 'Literal', 'TemplateLiteral', 'ThisExpression']);

/**
 * The origin of an expression, followed through the file's bindings: a member or a call answers
 * for its object or callee, a variable for what it was initialised or first assigned with, an
 * import for its specifier. `const { rt } = createTestRuntime(); spyOn(rt.craftStore, 'get')` is
 * ours because `createTestRuntime` is imported from our code.
 */
interface OriginScope {
  readonly bindings: Bindings;
  /** The first value assigned to each binding declared without one. */
  readonly assigned: ReadonlyMap<SyntaxNode, SyntaxNode>;
  /** Whether an import specifier names our code. */
  readonly ours: (specifier: string) => boolean;
}

function originOf(node: SyntaxNode, scope: OriginScope, seen: Set<SyntaxNode> = new Set()): Origin {
  const r = node.raw;

  const child = (inner: Node | null | undefined): Origin => {
    const at = inner === null || inner === undefined ? undefined : nodeAt(node, inner.start, inner.end);

    return at === undefined ? 'ours' : originOf(at, scope, seen);
  };

  if (CONSTRUCTED.has(r.type)) return 'test';

  if (r.type === 'MemberExpression') return child(r.object);

  if (r.type === 'CallExpression' || r.type === 'NewExpression') return child(r.callee);

  if (r.type === 'TSAsExpression' || r.type === 'TSNonNullExpression' || r.type === 'TSSatisfiesExpression'
    || r.type === 'ParenthesizedExpression' || r.type === 'ChainExpression' || r.type === 'TSTypeAssertion') {
    return child(r.expression);
  }

  if (r.type === 'AwaitExpression') return child(r.argument);

  if (r.type !== 'Identifier') return 'ours';
  const bound = scope.bindings.resolve(node);

  if (bound === undefined) return 'platform';

  if (seen.has(bound)) return 'ours';
  seen.add(bound);
  const b = bound.raw;

  if (b.type === 'ImportDeclaration') return scope.ours(String(b.source.value)) ? 'ours' : 'platform';

  if ((b.type === 'FunctionDeclaration' || b.type === 'ClassDeclaration') && b.id?.name === r.name) return 'test';

  if (b.type === 'VariableDeclarator') {
    const init = b.init ?? undefined;
    const from = init === undefined ? scope.assigned.get(bound) : nodeAt(bound, init.start, init.end);

    return from === undefined ? 'ours' : originOf(from, scope, seen);
  }

  return 'ours';
}

/** The first value assigned to each `let` declared without one, keyed by its declarator. */
function firstAssignments(parsed: ParsedFile, bindings: Bindings): Map<SyntaxNode, SyntaxNode> {
  const assigned = new Map<SyntaxNode, SyntaxNode>();
  walk(parsed.tree, (node) => {
    const r = node.raw;

    if (r.type !== 'AssignmentExpression' || r.left.type !== 'Identifier') return;
    const target = nodeAt(node, r.left.start, r.left.end);
    const value = nodeAt(node, r.right.start, r.right.end);
    const bound = target === undefined ? undefined : bindings.resolve(target);

    if (bound !== undefined && value !== undefined && !assigned.has(bound)) assigned.set(bound, value);
  });

  return assigned;
}

/**
 * Where a test replaces something, and whether that something is a REAL
 * EXTERNAL SEAM. The boundary is the module the replaced thing comes from:
 * `cloudflare:*`, `agents`, `partyserver`, `@cloudflare/sandbox`, `node:*` and
 * any bare package are the platform and its SDKs; a relative path or a
 * workspace-scope path is our own code, and replacing that is coupling.
 *
 * A `spyOn` target is resolved through the file's own LOCAL imports for the same
 * reason: `spyOn(fs, 'renameSync')` with `fs` from `node:fs` is a platform seam,
 * `spyOn(store, 'write')` with `store` from `../src/store` is coupling, and the
 * two are indistinguishable from the call site alone. Measured: passing every
 * import binding instead of the local ones reported the pc-agent daemon suite's
 * node-filesystem spy as an internal mock.
 */
function mocks(
  parsed: ParsedFile,
  spans: readonly TestSpan[],
  scope: string,
): MockSplit {
  const internal: Finding[] = [];
  const external: Finding[] = [];
  const bindings = bindingsOf(parsed);
  const isOurs = (id: string): boolean => id.startsWith('.') || id.startsWith(`${scope}/`) || id.startsWith('@/');
  const origins: OriginScope = { bindings, assigned: firstAssignments(parsed, bindings), ours: isOurs };
  walk(parsed.tree, (node) => {
    const called = calleeName(node);

    if (called === undefined) return;
    const line = parsed.lineAt(node.start);
    const test = titleAt(spans, line);

    if (MOCK_REGISTRARS.has(called)) {
      for (const id of stringArguments(node)) {
        const ours = isOurs(id);
        (ours ? internal : external).push({
          file: parsed.file, line, test,
          what: ours ? 'internal module mock' : 'external seam mock',
          detail: `${called}('${id}')`,
        });
      }

      return;
    }

    if (called !== 'spyOn') return;
    const [target, method] = argumentNodes(node);
    const targetText = target === undefined ? '?' : chainText(target.raw);
    const methodName = method === undefined ? '?' : literalText(method) ?? '?';
    const origin = target === undefined ? 'ours' : originOf(target, origins);

    if (origin === 'test') return;
    (origin === 'ours' ? internal : external).push({
      file: parsed.file, line, test,
      what: origin === 'ours' ? 'spy on an internal object' : 'spy at a platform seam',
      detail: `spyOn(${targetText}, '${methodName}')`,
    });
  });

  return { internal, external };
}

/* ── golden_regenerated ──────────────────────────────────────────────── */

/**
 * Fixture files a tracked script WRITES by running the implementation, keyed by
 * basename.
 *
 * A generator is identified by three properties of its own code — it writes a
 * file, it imports product source, and it names a `fixtures` path part — never
 * by a naming convention. The third is load-bearing: without it,
 * `scripts/tui-capture.ts` writing a scratch `config.json` claimed every test
 * that reads its own `config.json`, which was 59 findings and no truth.
 *
 * The destination is read from EVERY literal in the file rather than from the
 * `writeFileSync` argument, because the argument is usually a variable: a
 * generator that builds its target with `join(here, '..', 'packages', '<pkg>',
 * 'tests', 'fixtures', '<name>.json')` and passes the binding is invisible to an
 * argument-only reader, which is how this reported zero goldens on a tree that
 * had one.
 */
export function fixtureGenerators(tracked: readonly string[]): Map<string, string> {
  const generators = new Map<string, string>();
  const trackedSet = new Set(tracked);
  const scope = workspaceScope();

  for (const file of tracked) {
    if (!file.startsWith('scripts/') || !isParseable(file) || isTestFile(file)) continue;
    const text = readRepositoryFile(root, file);

    if (!/writeFileSync|Bun\.write/u.test(text)) continue;
    const parsed = parseFile(file, text);

    const specifiers = new Set<string>();
    const literals: string[] = [];
    walk(parsed.tree, (node) => {
      for (const specifier of moduleSpecifiers(node)) specifiers.add(specifier);
      const literal = literalText(node);

      if (literal !== undefined) literals.push(literal);
    });

    // RESOLVED, then asked. `isProductSource` over the file a specifier really
    // names, rather than a `src` path pattern this program owns: a
    // specifier that resolves nowhere imports nothing, and the set of product
    // files has one definition in `sources.ts`.
    const importsProduct = [...specifiers].some((specifier) => {
      const target = resolveSpecifier(specifier, 'scripts', trackedSet, scope);

      return target !== undefined && isProductSource(target);
    });

    if (!importsProduct) continue;

    if (!literals.some((literal) => literal === 'fixtures' || literal.includes('fixtures/'))) continue;

    for (const literal of literals) {
      const basename = literal.split('/').at(-1) ?? '';

      if (!/^[\w.-]+\.(json|jsonl|ndjson|txt|md|snap|csv)$/u.test(basename)) continue;
      generators.set(basename, file);
    }
  }

  return generators;
}

/** A fixture the test READS whose bytes a generator writes by running the
 *  implementation. Rule 5: comparing to it proves the implementation equals
 *  itself, unless something independently derives the expected value. */
function goldenReads(
  parsed: ParsedFile,
  spans: readonly TestSpan[],
  generators: ReadonlyMap<string, string>,
): Finding[] {
  const found: Finding[] = [];
  walk(parsed.tree, (node) => {
    const text = literalText(node);

    if (text === undefined) return;
    const generator = generators.get(text.split('/').at(-1) ?? text);

    if (generator === undefined) return;
    const line = parsed.lineAt(node.start);
    found.push({
      file: parsed.file, line, test: titleAt(spans, line),
      what: 'reads a generated fixture',
      detail: `${text} is written by ${generator}`,
    });
  });

  return found;
}

/* ── silent_skip / assertion_free ────────────────────────────────────── */

const SKIP_MODIFIERS: ReadonlySet<string> = new Set(['skip', 'todo', 'skipIf', 'todoIf', 'failing']);

/**
 * A declared skip (`test.skip`, `test.todo`, `test.skipIf`) and an UNDECLARED one
 * (`if (!creds) return` at the top of a test body). Both are "this test proved
 * nothing while the exit code said otherwise"; only the first is visible to
 * `gate:skip-ratchet`, which is what makes the second the finding that matters.
 *
 * Two narrowings, both measured. The return must be BARE: `if (!stream) { return
 * { response: … } }` inside a test-local fake is a stub answering, not a test
 * bailing out, and counting those put 99 rows here where 22 belong. And the guard
 * must be a DIRECT statement of the test's own body, for the same reason — a
 * dispatch inside `fakeSpawn(args => …)` is the fake's control flow.
 */
function silentSkips(parsed: ParsedFile, spans: readonly TestSpan[]): Finding[] {
  const found: Finding[] = [];

  for (const span of spans) {
    if (span.modifier !== undefined && SKIP_MODIFIERS.has(span.modifier)) {
      found.push({
        file: parsed.file, line: span.line, test: span.title,
        what: `declared test.${span.modifier}`,
        detail: 'a skip the runner reports — governed by gate:skip-ratchet',
      });
    }

    // A guard AFTER an assertion is TypeScript narrowing, not a skip:
    // `expect(out.ok).toBe(true); if (!out.ok) return;` has already asserted the
    // thing it then narrows. A credential skip sits before any assertion, which
    // is what separates the two without reading intent.
    let asserted = false;

    for (const statement of testBodyStatements(span)) {
      const r = statement.raw;

      if (!asserted) {
        walk(statement, (inner) => {
          if (calleeName(inner) === 'expect') asserted = true;
        });
      }

      if (asserted) continue;

      if (r.type !== 'IfStatement' || r.alternate !== null) continue;
      const negated = r.test.type === 'UnaryExpression' && r.test.operator === '!';

      const nullish = r.test.type === 'BinaryExpression'
        && (r.test.operator === '===' || r.test.operator === '==')
        && (chainText(r.test.right) === 'undefined' || chainText(r.test.right) === 'null');

      if (!negated && !nullish) continue;
      const body = r.consequent;

      const only = body.type === 'BlockStatement' && body.body.length === 1
        ? body.body[0] : body;

      if (only?.type !== 'ReturnStatement' || only.argument !== null) continue;
      found.push({
        file: parsed.file, line: parsed.lineAt(statement.start), test: span.title,
        what: 'silent return guard',
        detail: `if (${chainText(r.test)}) return — a skip that never declares itself`,
      });
    }
  }

  return found;
}

/** The statements of a test's own callback body. A guard nested inside a fake,
 *  a loop or a callback belongs to that construct, not to the test. */
function testBodyStatements(span: TestSpan): SyntaxNode[] {
  const body = argumentNodes(span.node).find((argument) =>
    argument.raw.type === 'ArrowFunctionExpression' || argument.raw.type === 'FunctionExpression');

  if (body === undefined) return [];
  const block = body.children.find((child) => child.raw.type === 'BlockStatement');

  return block === undefined ? [] : [...block.children];
}

/** Waits that fail by REJECTING rather than by asserting a value. A puppeteer
 *  `waitForFunction` is a real check, and it is a different kind: AGENTS.md's own
 *  rule is that a longer wait on a condition that will never appear takes twice
 *  as long to lie, so these are reported under their own name rather than as
 *  assertions or as nothing. */
const WAIT_CALL = /^waitFor|^waitUntil$|^waitForFunction$|^waitForSelector$/u;

/** A test with no reachable assertion: no inline `expect`/`assert`, no `throw`,
 *  no call to a file-local asserting helper, no call to an imported
 *  assert-shaped name. A wait-only test is reported separately by name. */
function assertionFree(
  parsed: ParsedFile,
  spans: readonly TestSpan[],
  asserting: ReadonlySet<string>,
): Finding[] {
  const found: Finding[] = [];

  for (const span of spans) {
    if (span.modifier === 'todo') {
      found.push({
        file: parsed.file, line: span.line, test: span.title,
        what: 'test.todo', detail: 'a test that does not exist yet',
      });
      continue;
    }

    let asserts = false;
    let waits = false;
    walk(span.node, (node) => {
      if (node.raw.type === 'ThrowStatement') {
        asserts = true;

        return;
      }

      const called = calleeName(node);

      if (called === undefined) return;

      if (called === 'expect' || called === 'assert' || ASSERTING_IMPORT.test(called)
        || asserting.has(called)) asserts = true;

      if (WAIT_CALL.test(called)) waits = true;
    });

    if (asserts) continue;
    found.push({
      file: parsed.file, line: span.line, test: span.title,
      what: waits ? 'asserts only by waiting' : 'assertion-free test',
      detail: waits
        ? 'the only failure mode is a wait timing out, which names no expected value'
        : 'no expect, no throw, no call to an asserting helper',
    });
  }

  return found;
}

/* ── public_surface_entry ────────────────────────────────────────────── */

/** The entry forms that count as PUBLIC: an HTTP request through a shipped
 *  handler, a WS/RPC client, CLI argv, and the package's own exported API. One
 *  per form per file — the question is whether a public path is used at all. */
function publicEntries(
  parsed: ParsedFile,
  specifiers: readonly string[],
  scope: string,
): Finding[] {
  const found: Finding[] = [];
  const seen = new Set<string>();

  const push = (node: SyntaxNode, what: string, detail: string): void => {
    if (seen.has(what)) return;
    seen.add(what);
    found.push({
      file: parsed.file, line: parsed.lineAt(node.start), test: FILE_SCOPE, what, detail,
    });
  };

  walk(parsed.tree, (node) => {
    const r = node.raw;

    if (r.type === 'NewExpression') {
      const constructed = chainText(r.callee);

      if (constructed === 'WebSocket') push(node, 'WS entry', 'new WebSocket(...)');

      if (constructed === 'Request') push(node, 'HTTP entry', 'new Request(...)');

      return;
    }

    if (r.type !== 'CallExpression') return;
    const called = calleeName(node);

    if (called === undefined) return;
    const chain = chainText(r.callee);

    if (/^handle[A-Z]\w*Request$|^handleRequest$/u.test(called)) push(node, 'HTTP entry', `${called}()`);

    if (called === 'request' && /app|worker|server|handler|client/iu.test(chain)) {
      push(node, 'HTTP entry', `${chain}()`);
    }

    if (called === 'fetch' && r.callee.type === 'MemberExpression') {
      push(node, 'HTTP entry', `${chain}()`);
    }

    if (/^runCli$|^runCommand$|^execCli$/u.test(called)) push(node, 'CLI entry', `${called}()`);

    if (called.startsWith('spawn')) {
      // The argv is usually an ARRAY literal, so every literal in the call is
      // read rather than only its direct string arguments.
      const literals: string[] = [];
      walk(node, (inner) => {
        const literal = literalText(inner);

        if (literal !== undefined) literals.push(literal);
      });
      const argv = literals.join(' ');

      if (/cli\/bin|(^|\s)kinu(\s|$)/u.test(argv)) {
        push(node, 'CLI spawn entry', argv.slice(0, 70));
      }
    }

    if (/^callRpc$|^rpc$|^callable$/u.test(called)) push(node, 'RPC entry', `${chain}()`);
  });

  const publicImport = specifiers.find((specifier) =>
    new RegExp(`^${scope}/[a-z-]+$`, 'u').test(specifier)
    || specifier.endsWith('/src/index') || /^\.\.\/src$/u.test(specifier));

  if (publicImport !== undefined) {
    found.push({
      file: parsed.file, line: 1, test: FILE_SCOPE,
      what: 'package API entry', detail: `imports ${publicImport}`,
    });
  }

  return found;
}

/* ── kind and runner ─────────────────────────────────────────────────── */

const BROWSER_IMPORT = /puppeteer|playwright/u;

function kindOf(file: string, specifiers: readonly string[], runner: string): Kind {
  if (!isRunnableSuite(file)) return 'support';

  if (specifiers.some((specifier) => BROWSER_IMPORT.test(specifier))) return 'ui';

  if (runner === 'vitest-evals') return 'eval';

  if (file.startsWith('scripts/')) return 'gate';

  if (runner === 'vitest-workerd') return 'integration';
  const base = (file.split('/').pop() ?? '').replace(/\.(test|eval|spec)\.tsx?$/u, '');

  if (file.startsWith('tests/')) {
    return base.startsWith('e2e') || base.includes('lifecycle') || base.includes('live')
      ? 'e2e' : 'integration';
  }

  if (file.includes('/tests/e2e/') || base.startsWith('e2e') || base.startsWith('smoke')) return 'e2e';

  if (base.startsWith('integration') || base.startsWith('contract')
    || base.startsWith('conformance')) return 'integration';

  return 'unit';
}

/** Which runner executes a file, by the splits `ladder.ts` and `bunfig.toml`
 *  already draw. */
function runnerOf(file: string): string {
  if (!isRunnableSuite(file)) return 'imported only';

  if (isVitestEvalSuite(file)) return 'vitest-evals';

  if (/\/tests\/workerd\//u.test(file)) return 'vitest-workerd';

  if (isPythonSuite(file)) return 'python';

  if (isBunDiscoverableSuite(file)) return 'bun';

  return 'no runner shape claims it';
}

/* ── Runner claims: the never-run table ──────────────────────────────── */

export interface RunnerClaim {
  readonly name: string;
  readonly tier: string;
  readonly source: string;
  readonly files: readonly string[];
}

/**
 * Which runner or tier claims which test file, and therefore which files NO
 * runner claims.
 *
 * Every claim is RESOLVED, never listed. `ladder.ts`'s own `claims()` answers
 * for each gate command — it follows `bun run` bodies, expands globs, and
 * narrows by bunfig's `pathIgnorePatterns` and by bun's own matcher — and
 * `deployGates()` is the ladder's deploy plan. The non-ladder runners come from
 * `package.json`'s scripts table. A second resolver here would be the defect
 * `gate-set-equality` exists to prevent: one set measured, another governed.
 *
 * The one claim that is not a command: the anti-slop aggregator imports its
 * per-rule suites dynamically, so `isAntiSlopRuleSuite` IS the claim. Those
 * files sit outside the census corpus, which the table states rather than hides.
 */
const LADDER_SOURCE = 'scripts/ladder.ts LADDER';

const DEPLOY_SOURCE = 'scripts/deploy.sh roster';

export function runnerClaims(tracked: readonly string[]): RunnerClaim[] {
  const testFiles = new Set(tracked.filter((file) => isTestFile(file) || isPythonSuite(file)));
  const out: RunnerClaim[] = [];

  const add = (name: string, tier: string, source: string, files: readonly string[]): void => {
    const kept = [...new Set(files)].filter((file) => testFiles.has(file)).sort();

    if (kept.length > 0) out.push({ name, tier, source, files: kept });
  };

  for (const gate of LADDER) {
    add(gate.run, gate.tier, LADDER_SOURCE, claims(gate.run, tracked));
  }

  const declared = new Set(LADDER.map((gate) => gate.run));

  for (const run of deployGates()) {
    if (declared.has(run)) continue;
    add(run, 'deploy', DEPLOY_SOURCE, claims(run, tracked));
    declared.add(run);
  }

  const scripts = packageScripts();

  const nonLadder: readonly (readonly [string, string])[] = [
    ['test', 'root `bun run test` — the partly disjoint agent-utils/core/compaction set'],
    ['test:cli', 'the full CLI suite runner'],
    ['test:workerd', 'the workerd layer, both roots'],
    ['test:live', 'the live tier: the end-to-end suites under tests/live'],
    ['evals', 'the eval suite: every task under evals/tasks, on the deployment'],
    ['test:anti-slop', 'the vendored plugin suites, under Node'],
  ];

  for (const [key, source] of nonLadder) {
    if (scripts[key] === undefined) continue;
    const command = `bun run ${key}`;

    if (declared.has(command)) continue;
    add(command, 'named runner', source, claims(command, tracked));
    declared.add(command);
  }

  // `scripts/test.sh` names its four directories WITHOUT a trailing slash, and
  // `claims()` resolves a bare directory to nothing — only `dir/` sweeps the
  // paths under it. Bun runs both spellings identically, so the claim is
  // resolved in the form the resolver understands and the divergence is stated
  // here rather than silently producing a zero.
  add('bash scripts/test.sh', 'developer default',
    'scripts/test.sh:36-40 — four directories, resolved with the trailing slash claims() needs; '
    + 'the bare spelling test.sh uses would resolve to nothing',
    claims('bun test packages/core/tests/ packages/cf-backend/tests/ packages/cli-backend/tests/ '
      + 'packages/cli/tests/', tracked));
  add('tools/oxlint/anti-slop rules.test.ts', 'aggregator',
    'dynamic import inside the aggregator (isAntiSlopRuleSuite)',
    tracked.filter(isAntiSlopRuleSuite));

  return out;
}

/**
 * The ladder's own gate tests: every `scripts/` suite a ladder or deploy row runs, resolved through
 * {@link runnerClaims}. `scripts/` holds the gate programs, so these suites' subject is the tree.
 */
export function gateTests(runners: readonly RunnerClaim[]): Set<string> {
  const gates = runners.filter((claim) => claim.source === LADDER_SOURCE || claim.source === DEPLOY_SOURCE);

  return new Set(gates.flatMap((claim) => claim.files).filter((file) => file.startsWith('scripts/')));
}

/* ── The census ──────────────────────────────────────────────────────── */

/**
 * The findings, one list per axis. Written as a named contract rather than a
 * `Record<Category, …>` so the compiler knows exactly which keys exist: a
 * dictionary type would accept a misspelled category and lose the evidence that
 * every axis is present.
 */
export interface Findings {
  source_text: Finding[];
  mirror: Finding[];
  tautology_suspect: Finding[];
  private_reach: Finding[];
  internal_mock: Finding[];
  assertion_free: Finding[];
  silent_skip: Finding[];
  golden_regenerated: Finding[];
}

/** One package's counters. Named for the same reason: a reader of the JSON gets
 *  the whole shape, and a new axis is a compile error here rather than a column
 *  that silently reads zero. */
export interface PackageCounts {
  files: number;
  suites: number;
  tests: number;
  unit: number;
  integration: number;
  e2e: number;
  eval: number;
  gate: number;
  ui: number;
  support: number;
  source_text: number;
  mirror: number;
  tautology_suspect: number;
  private_reach: number;
  internal_mock: number;
  assertion_free: number;
  silent_skip: number;
  golden_regenerated: number;
  external_seam_mock: number;
  public_surface_entry: number;
  never_run: number;
}

export interface Census {
  readonly generatedAt: string;
  readonly tree: {
    readonly sha: string;
    readonly files: number;
    readonly suites: number;
    readonly support: number;
    readonly tests: number;
    /** Member names product source declares non-public: what a private reach is judged against. */
    readonly productNonPublic: number;
    /** Product function bodies at the mirror floor: what a mirrored function is judged against. */
    readonly productFunctions: number;
  };
  readonly files: readonly FileRow[];
  readonly findings: Findings;
  readonly publicSurface: readonly Finding[];
  readonly externalSeam: readonly Finding[];
  readonly bridges: readonly Bridge[];
  readonly runnerClaims: readonly RunnerClaim[];
  /**
   * Every corpus file NO listed runner claims — the honest denominator behind
   * the `never run` column.
   *
   * SUPPORT INCLUDED, because a file nothing runs is a file nothing runs. The
   * column counts only the runnable half, which is why it read 0 for every
   * package on a tree where 50 support modules were claimed by nothing: the
   * split was invisible and the report printed a bare count of 63 support
   * modules without saying that 13 of them ARE claimed, by the workerd and CLI
   * runners whose directory globs sweep them up. Both halves are named now.
   */
  readonly unclaimed: readonly string[];
  /** Runnable suites no named runner executes. The never-run set, and the
   *  runnable half of {@link Census.unclaimed}. */
  readonly neverRun: readonly string[];
  /** Support modules, which run only through an import. Not a finding. */
  readonly supportOnly: readonly string[];
  readonly perPackage: Readonly<Record<string, PackageCounts>>;
  readonly blindSpots: readonly string[];
}

/**
 * The tracked file a module specifier names, with the candidate-suffix rule
 * `wired.ts` uses — so "the module under test" means the same thing in both.
 * The suffix list and the collapse live in `syntax.ts`: one spelling shared by
 * every resolver, rather than one per gate.
 *
 * A specifier that resolves nowhere is not an import of anything, and "this
 * script imports product source" is RESOLVED to a path the enumeration holds
 * and asked of `isProductSource`, rather than matched against the shape a
 * specifier usually has.
 */
function resolveSpecifier(
  specifier: string, dir: string, tracked: ReadonlySet<string>, scope: string,
): string | undefined {
  let base: string | undefined;

  if (specifier.startsWith('.')) base = collapsePath(`${dir}/${specifier}`);
  else if (specifier.startsWith(`${scope}/`)) {
    const rest = specifier.slice(scope.length + 1).split('/');
    base = collapsePath(`packages/${rest[0] ?? ''}/src/${rest.slice(1).join('/')}`);
  }

  if (base === undefined) return undefined;
  const at = base;

  return IMPORT_CANDIDATES.map((suffix) => at + suffix).find((path) => tracked.has(path));
}

interface Imports {
  /** Specifiers resolved into tracked product files. */
  readonly local: string[];
  /** Every specifier the file names. */
  readonly specifiers: string[];
  /** Names bound from a LOCAL module: the tautology check's vocabulary, and the
   *  test for whether a spy target is our code or the platform's. */
  readonly localNames: Set<string>;
}

/** Resolve a test file's imports with the same candidate-suffix rule `wired.ts`
 *  uses, so "the module under test" means the same thing in both. */
function resolveImports(parsed: ParsedFile, tracked: ReadonlySet<string>, scope: string): Imports {
  const specifiers: string[] = [];
  const local: string[] = [];
  const localNames = new Set<string>();
  const dir = parsed.file.slice(0, parsed.file.lastIndexOf('/'));

  for (const statement of parsed.tree.children) {
    const named = moduleSpecifiers(statement);

    for (const specifier of named) specifiers.push(specifier);
    const [specifier] = named;

    if (specifier === undefined) continue;
    const bound = importBindings(statement);

    const target = resolveSpecifier(specifier, dir, tracked, scope);

    if (target === undefined) continue;
    local.push(target);

    for (const binding of bound) localNames.add(binding.local);
  }

  return { local: [...new Set(local)], specifiers, localNames };
}

/**
 * Everything a single file's measurement needs that comes from OUTSIDE that
 * file: which values production names, which members it declares non-public,
 * which function bodies it holds, which fixtures a generator writes, which
 * bridges exist, and what the tracked set is. Built once per run.
 */
export interface CensusInputs {
  /** A gate program's own test: its subject is the tree, so reading source is its input, not a coupling. */
  readonly gateTests: ReadonlySet<string>;
  readonly sources: ReadonlyMap<string, string>;
  readonly nonPublic: ReadonlyMap<string, string>;
  readonly generators: ReadonlyMap<string, string>;
  readonly bridges: ReadonlyMap<string, Bridge>;
  readonly productUnits: ReadonlyMap<string, Unit>;
  readonly tracked: ReadonlySet<string>;
  readonly scope: string;
}

export interface Measured {
  readonly row: FileRow;
  readonly findings: Findings;
  readonly publicSurface: readonly Finding[];
  readonly externalSeam: readonly Finding[];
}

/**
 * One file's whole classification.
 *
 * The seam the suite drives, and the reason it is a seam: a fixture proving the
 * ratchet goes red must never be WRITTEN INTO THE TREE. `gate-set-equality.test.ts`
 * makes the same argument for the same reason — a red demonstration that seeds a
 * real file changes what every other gate measures while it runs.
 */
export function measureFile(file: string, text: string, inputs: CensusInputs): Measured {
  const parsed = parseFile(file, text);
  const { local, specifiers, localNames } = resolveImports(parsed, inputs.tracked, inputs.scope);
  const spans = testSpans(parsed);
  const facts = localFacts(parsed, inputs.tracked);
  const { internal, external } = mocks(parsed, spans, inputs.scope);

  const findings: Findings = {
    source_text: inputs.gateTests.has(file) ? [] : sourceText(parsed, spans, facts, inputs.tracked),
    mirror: mirrors(parsed, spans, local, inputs),
    tautology_suspect: tautologies(parsed, spans, localNames),
    private_reach: [
      ...privateReaches(parsed, spans, inputs.nonPublic),
      ...bridgeReaches(parsed, spans, inputs.bridges),
    ],
    internal_mock: internal,
    assertion_free: assertionFree(parsed, spans, facts.asserting),
    silent_skip: silentSkips(parsed, spans),
    golden_regenerated: goldenReads(parsed, spans, inputs.generators),
  };

  const publicSurface = publicEntries(parsed, specifiers, inputs.scope);
  const runner = runnerOf(file);

  return {
    findings,
    publicSurface,
    externalSeam: external,
    row: {
      file,
      package: packageOf(file),
      kind: kindOf(file, specifiers, runner),
      runner,
      tests: spans.length,
      source_text: findings.source_text.length,
      mirror: findings.mirror.length,
      tautology_suspect: findings.tautology_suspect.length,
      private_reach: findings.private_reach.length,
      internal_mock: internal.length,
      external_seam_mock: external.length,
      assertion_free: findings.assertion_free.length,
      silent_skip: findings.silent_skip.length,
      golden_regenerated: findings.golden_regenerated.length,
      public_surface_entry: publicSurface.length,
      runners: [],
    },
  };
}

/**
 * The outside-the-file inputs, read from the tree once.
 *
 * `readSources()` supplies the product corpus rather than a path pattern here,
 * and the change closed a real defect as well as a set-equality one. The
 * private regex was `^packages/[^/]+/src/.+\.[jt]sx?$` minus `.d.ts`, which
 * reads 870 files where `isProductSource` reads 863 — measured 2026-09-01. The
 * seven it added were six COLOCATED SUITES inside `src/`
 * (`evolution/gepa/*` suites, `scaffold/ui-stream.test.ts`,
 * `skills/skills.test.ts`) plus `packages/pc-agent/src/index.js`. The six made
 * a constant shared by two TESTS read as a production mirror, and made a
 * `private` member declared in a test class widen the non-public dictionary
 * every bracket reach is confirmed against. The `.js` daemon is reached by
 * `require()` rather than by `import`, which `resolveImports` never resolved,
 * so no finding on this tree depended on any of the seven.
 */
export function censusInputs(tracked: readonly string[], runners: readonly RunnerClaim[]): CensusInputs {
  const sources = readSources();
  const nonPublic = nonPublicMembers(sources);
  const classes = classNonPublicMembers(sources);
  const bridges = new Map<string, Bridge>();

  for (const file of tracked.filter(isCensusFile)) {
    // One name, two helper classes: the crossing one is the door a call may open.
    for (const bridge of bridgesOf(file, readRepositoryFile(root, file), classes)) {
      if (bridge.nonPublic.length > 0 || !bridges.has(bridge.name)) bridges.set(bridge.name, bridge);
    }
  }

  return {
    gateTests: gateTests(runners),
    sources,
    nonPublic,
    generators: fixtureGenerators(tracked),
    bridges,
    productUnits: productUnitsOf(sources),
    tracked: new Set(tracked),
    scope: workspaceScope(),
  };
}

/** An empty findings record, so a caller can merge measurements. */
export function noFindings(): Findings {
  return {
    source_text: [], mirror: [], tautology_suspect: [], private_reach: [], internal_mock: [],
    assertion_free: [], silent_skip: [], golden_regenerated: [],
  };
}

export function runCensus(): Census {
  const tracked = trackedFiles();
  const corpus = tracked.filter(isCensusFile);
  const claimsTable = runnerClaims(tracked);
  const inputs = censusInputs(tracked, claimsTable);

  const findings = noFindings();
  const publicSurface: Finding[] = [];
  const externalSeam: Finding[] = [];
  const rows: FileRow[] = [];
  let totalTests = 0;

  for (const file of corpus) {
    const measured = measureFile(file, readRepositoryFile(root, file), inputs);

    for (const category of CATEGORIES) findings[category].push(...measured.findings[category]);
    publicSurface.push(...measured.publicSurface);
    externalSeam.push(...measured.externalSeam);
    totalTests += measured.row.tests;
    rows.push(measured.row);
  }

  const claimedBy = new Map<string, string[]>();

  for (const claim of claimsTable) {
    for (const file of claim.files) {
      const names = claimedBy.get(file) ?? [];
      names.push(claim.name);
      claimedBy.set(file, names);
    }
  }

  const joined: FileRow[] = rows.map((row) => ({ ...row, runners: claimedBy.get(row.file) ?? [] }));

  // THE DENOMINATOR IS THE WHOLE CORPUS, then split. `unclaimed` answers "what
  // does no listed runner run"; `neverRun` narrows it to the runnable half,
  // which is what the per-package column counts.
  const unclaimed = joined.filter((row) => row.runners.length === 0).map((row) => row.file);

  const neverRun = joined
    .filter((row) => row.kind !== 'support' && row.runners.length === 0)
    .map((row) => row.file);

  const supportOnly = joined.filter((row) => row.kind === 'support').map((row) => row.file);

  const perPackage = new Map<string, PackageCounts>();

  for (const row of joined) {
    const bucket = perPackage.get(row.package) ?? blankCounts();
    perPackage.set(row.package, bucket);
    bucket.files += 1;
    bucket.tests += row.tests;
    bucket[row.kind] += 1;

    if (row.kind !== 'support') bucket.suites += 1;

    for (const category of CATEGORIES) bucket[category] += row[category];
    bucket.external_seam_mock += row.external_seam_mock;
    bucket.public_surface_entry += row.public_surface_entry;

    if (row.kind !== 'support' && row.runners.length === 0) bucket.never_run += 1;
  }

  const sha = Bun.spawnSync(['git', '-C', root, 'rev-parse', '--short', 'HEAD']).stdout
    .toString().trim();

  return {
    generatedAt: new Date().toISOString(),
    tree: {
      sha,
      files: joined.length,
      suites: joined.filter((row) => row.kind !== 'support').length,
      support: supportOnly.length,
      tests: totalTests,
      productNonPublic: inputs.nonPublic.size,
      productFunctions: inputs.productUnits.size,
    },
    files: joined,
    findings,
    publicSurface,
    externalSeam,
    bridges: [...inputs.bridges.values()].sort((a, b) => a.name.localeCompare(b.name)),
    runnerClaims: claimsTable,
    neverRun,
    supportOnly,
    perPackage: Object.fromEntries(perPackage),
    blindSpots: BLIND_SPOTS,
    unclaimed,
  };
}

/** A package's counters at zero. The shape is the contract, so a new axis is a
 *  compile error here rather than a column that quietly reads zero. */
function blankCounts(): PackageCounts {
  return {
    files: 0, suites: 0, tests: 0, unit: 0, integration: 0, e2e: 0, eval: 0, gate: 0, ui: 0,
    support: 0, source_text: 0, mirror: 0, tautology_suspect: 0, private_reach: 0,
    internal_mock: 0, assertion_free: 0, silent_skip: 0, golden_regenerated: 0,
    external_seam_mock: 0, public_surface_entry: 0, never_run: 0,
  };
}

/* ── Blind spots ─────────────────────────────────────────────────────── */

/** What this census CANNOT see, printed on the success path. Each line is a
 *  measured limitation of the reader above, not a caveat in general. */
export const BLIND_SPOTS: readonly string[] = [
  'dynamic string assembly: a specifier, path or asserted string built by concatenation, '
  + '`join`, or a template with an expression is invisible to every literal comparison here',
  'tests generated at runtime: a `for (const case of CASES) test(...)` loop counts ONE test '
  + 'per `test(` call site, so a 40-row table reads as one test',
  'a mutation harness is trusted to execute what it copies: a function that writes a product '
  + 'file out and returns no text is not a reader, so text written out and read back is not traced',
  'mirrors by DERIVATION: a test that recomputes a formula instead of restating its constant '
  + 'is caught only when a NAMED literal value is shared',
  'a mirrored function is matched by structure with names in first-use order, so a copy that '
  + 'reorders statements, changes a literal, or renames a local that shares a property\'s name '
  + `(\`salt\` beside \`opts.salt\`) reads as other code; a copy under ${String(MIN_NODES)} nodes is not compared`,
  'a spy whose target is a call on a platform global, `spyOn(Object.getPrototypeOf(X.prototype), m)`, '
  + 'reads as a platform seam whatever X is; and a constant a module keeps unexported is not a mirror '
  + 'when a test restates it, since the test cannot import it and states it as an outside contract',
  'a MOCK ECHO: a test asserting the value a stand-in was scripted to return, passed through '
  + 'unchanged, is not detected; an external seam mock is allowed, and what flows out of it is not traced',
  'tautology through a stored value: `expect(actual).toEqual(expected)` where `expected` was '
  + 'produced earlier by the code under test and held in a variable',
  'private reach through destructuring, `Object.entries` over a private map, a public getter '
  + 'over private state, or a cast TypeScript erases',
  'a SHAPE GATE written as a product suite: a `scripts/` suite a ladder row runs is exempt from '
  + 'source_text, since the tree is its subject; a product suite that pins code shape is reported, '
  + 'and whether it guards a rule no behavioural test can express is left to the reviewer',
  'whether an external seam mock is FAITHFUL: `devbox/tests/support/devbox-harness.ts` '
  + 're-implements a container, and a stand-in that diverges from the SDK passes checks the real '
  + 'SDK fails',
  'the vendored anti-slop plugin is out of census scope, so its suites appear in the runner '
  + 'table and in no category row',
  'a silent skip AFTER the first assertion in a test: the guard-versus-narrowing rule reads '
  + 'position, so `expect(...); if (!creds) return;` is invisible. Measured tradeoff: reading '
  + 'every guard reported 32 rows of which 30 were TypeScript narrowing after an assertion',
  'a member NAME collision: a bracket reach is confirmed against every non-public member name in '
  + 'product source, repo-wide, so `wrapped[\'run\']` over a tool dictionary matches the private '
  + '`run` of release/engine.ts. One of five false positives in a hand-checked sample of 20',
  'a one-line DELEGATION counted as a mirrored body: `exec: (c) => shell.exec(c)` in a harness '
  + 'duplicates the module\'s own line without duplicating any decision',
  'a runner claim resolves a COMMAND, so a suite executed by a CI step no gate declares, or by '
  + 'a human, reads as never-run',
  'a test asserting over an INSTALLED DEPENDENCY\'s shipped text: a source read is RESOLVED '
  + 'against the enumeration, and `node_modules` is not tracked, so the two '
  + '`unit-nimbus-patched-artifacts.test.ts` cases reading `@nimbus-sh/*` are silent here. '
  + 'Deliberate — a refactor of this repository cannot turn them red, which is what the axis '
  + 'measures — and stated because the private path pattern this resolution replaced did count '
  + 'them, so the number moved',
  'REJECTED HEURISTIC, recorded because its absence is a blind spot: "an asserted string that '
  + 'also occurs verbatim in an imported module" produced 102 findings on this tree and most were '
  + 'behavioural (`expect(cookie).toContain(\'SameSite=Lax\')`), so source_text now requires the '
  + 'asserted VALUE to come from a file read. A test that hard-codes a source string without '
  + 'reading the file is therefore invisible here',
];

/* ── Output ──────────────────────────────────────────────────────────── */

function offenders(findings: readonly Finding[], limit: number): [string, number][] {
  const byFile = new Map<string, number>();

  for (const finding of findings) byFile.set(finding.file, (byFile.get(finding.file) ?? 0) + 1);

  return [...byFile.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

export function markdown(census: Census): string {
  const out: string[] = [];
  const p = (line = ''): void => { out.push(line); };

  p('# Test census');
  p();
  p(`Measured ${census.generatedAt} at \`${census.tree.sha}\`: ${String(census.tree.files)} test `
    + `files (${String(census.tree.suites)} suites, ${String(census.tree.support)} imported-only `
    + `support modules), ${String(census.tree.tests)} \`test(...)\` call sites. Read-only — nothing `
    + 'here fails.');
  p();
  p('## Category totals');
  p();
  p('| Category | Files | Findings |');
  p('|---|---:|---:|');

  for (const category of CATEGORIES) {
    const rows = census.findings[category];
    p(`| \`${category}\` | ${String(new Set(rows.map((r) => r.file)).size)} | ${String(rows.length)} |`);
  }

  p(`| \`public_surface_entry\` (good) | ${String(new Set(census.publicSurface.map((r) => r.file)).size)} | ${String(census.publicSurface.length)} |`);
  p(`| \`external_seam_mock\` (good) | ${String(new Set(census.externalSeam.map((r) => r.file)).size)} | ${String(census.externalSeam.length)} |`);
  p();

  p('## Per package');
  p();

  const head = ['Package', 'Files', 'Suites', 'Tests', 'unit', 'int', 'e2e', 'eval', 'gate', 'ui',
    ...CATEGORIES, 'public', 'never run'];

  p(`| ${head.join(' | ')} |`);
  p(`|${head.map(() => '---').join('|')}|`);
  const KINDS: readonly Kind[] = ['unit', 'integration', 'e2e', 'eval', 'gate', 'ui'];

  for (const pkg of Object.keys(census.perPackage).sort()) {
    const bucket = census.perPackage[pkg];

    if (bucket === undefined) continue;
    const kinds = KINDS.map((kind) => String(bucket[kind])).join(' | ');
    p(`| ${pkg} | ${String(bucket.files)} | ${String(bucket.suites)} | `
      + `${String(bucket.tests)} | ${kinds} | ${CATEGORIES.map((c) => String(bucket[c])).join(' | ')} `
      + `| ${String(bucket.public_surface_entry)} | ${String(bucket.never_run)} |`);
  }

  p();

  p('## Who runs what — and what nothing runs');
  p();
  p('| Runner / gate | Tier | Test files claimed | Resolved from |');
  p('|---|---|---:|---|');

  for (const claim of census.runnerClaims) {
    p(`| \`${claim.name}\` | ${claim.tier} | ${String(claim.files.length)} | ${claim.source} |`);
  }

  p();

  // THE DENOMINATOR, STATED. Every claim above is a count of files one command
  // reaches; this is the arithmetic that turns those counts into "and therefore
  // nothing runs these". It exists because the `never run` column read 0 for
  // every package while this table listed every package as claimed, and a
  // reader had no way to tell a genuinely covered corpus from a column that
  // measured the wrong half.
  const claimed = census.files.length - census.unclaimed.length;
  const unclaimedSuites = census.neverRun;
  const unclaimedSupport = census.unclaimed.filter((file) => !unclaimedSuites.includes(file));
  const aggregated = census.runnerClaims.find((claim) => claim.tier === 'aggregator');
  p(`Of ${String(census.files.length)} census files, `
    + `**${String(claimed)}** are claimed by at least one runner above and `
    + `**${String(census.unclaimed.length)}** by none: `
    + `${String(unclaimedSuites.length)} runnable suite(s) — what the \`never run\` column counts — `
    + `and ${String(unclaimedSupport.length)} of the ${String(census.supportOnly.length)} `
    + 'imported-only support modules. The other '
    + `${String(census.supportOnly.length - unclaimedSupport.length)} support modules ARE claimed, `
    + 'by runners whose directory globs sweep them up.');
  p();

  if (aggregated !== undefined) {
    p(`Outside this corpus by contract: the ${String(aggregated.files.length)} `
      + `\`${ANTI_SLOP_RULES}*\` suites, which run only through the aggregator's dynamic import.`);
    p();
  }

  p('### Never run by any named runner');
  p();

  if (unclaimedSuites.length === 0) {
    p('None: every runnable suite in the census corpus is claimed by at least one runner or gate.');
  } else {
    for (const file of unclaimedSuites) p(`- \`${file}\``);
  }

  p();
  p(`### Imported-only support modules no runner claims (${String(unclaimedSupport.length)} `
    + `of ${String(census.supportOnly.length)})`);
  p();
  p('Not a finding on its own: a helper, fixture module or probe worker runs through an import, so '
    + 'no runner claims it by name. Named rather than counted because a support module carrying '
    + 'its OWN assertions is a test nobody schedules, and a count cannot tell you which one.');
  p();

  for (const file of unclaimedSupport) p(`- \`${file}\``);
  p();

  p('## Test-helper bridges');
  p();
  const crossing = census.bridges.filter((bridge) => bridge.nonPublic.length > 0);
  p(`${String(census.bridges.length)} public members of test classes over a product base exist; `
    + `${String(crossing.length)} reach a member production declares \`private\` or \`protected\`.`);
  p();

  if (crossing.length > 0) {
    p('| Bridge | Declared at | Non-public members it reaches |');
    p('|---|---|---|');

    for (const bridge of crossing) {
      p(`| \`${bridge.name}\` | ${bridge.file}:${String(bridge.line)} | `
        + `${bridge.nonPublic.map((member) => `\`${member}\``).join(', ')} |`);
    }

    p();
  }

  p('## Top offenders, per category');
  p();

  for (const category of CATEGORIES) {
    const rows = census.findings[category];

    if (rows.length === 0) { p(`### ${category} — none`); p(); continue; }

    p(`### ${category} — ${String(rows.length)} findings across `
      + `${String(new Set(rows.map((r) => r.file)).size)} files`);
    p();

    for (const [file, count] of offenders(rows, 15)) p(`- ${file} — ${String(count)}`);
    p();
    p('Examples:');
    p();

    for (const row of rows.slice(0, 8)) {
      p(`- \`${row.file}:${String(row.line)}\` [${row.test}] ${row.what} — ${row.detail}`);
    }

    p();
  }

  p('## The full per-file table');
  p();
  const cols = ['File', 'Kind', 'Runner', 'Tests', 'Runners', ...CATEGORIES, 'public'];
  p(`| ${cols.join(' | ')} |`);
  p(`|${cols.map(() => '---').join('|')}|`);

  for (const row of census.files) {
    p(`| ${row.file} | ${row.kind} | ${row.runner} | ${String(row.tests)} | `
      + `${String(row.runners.length)} | ${CATEGORIES.map((c) => String(row[c])).join(' | ')} | `
      + `${String(row.public_surface_entry)} |`);
  }

  p();
  p('## What this census cannot see');
  p();

  for (const spot of census.blindSpots) p(`- ${spot}`);
  p();

  return out.join('\n');
}

/* ── Ratchet ─────────────────────────────────────────────────────────── */

/**
 * The ratchet key: category, file, TEST TITLE and finding shape — never a line
 * number. A new coupled test fails the check by name; moving one twenty lines
 * down does not, because a lock that churns on every refactor is a lock nobody
 * reads and therefore a gate nobody trusts.
 */
export const ratchetKey = (category: Category, finding: Finding): string =>
  `${category} :: ${finding.file} :: ${finding.test} :: ${finding.what}`;


export interface RatchetVerdict {
  /** Findings in a banned category, the lock notwithstanding. */
  readonly banned: readonly string[];
  /** Keys in the tree and absent from the lock — new coupling. */
  readonly added: readonly string[];
  /** Keys whose count GREW: the same test acquired more of the same coupling. */
  readonly grown: readonly string[];
  /** Locked keys that no longer reproduce — the lock needs rewriting. */
  readonly stale: readonly string[];
  /** Locked keys that name no plant: a suspect nothing has shown can fail. */
  readonly unproven: readonly string[];
}

/** The findings of `categories`, keyed and counted. Takes the findings record
 *  rather than a whole census, so the suite can ratchet a measurement it seeded
 *  from text without a Census — and therefore without touching the tree. */
function keyCounts(
  findings: Readonly<Record<Category, readonly Finding[]>>,
  categories: readonly Category[],
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const category of categories) {
    for (const finding of findings[category]) {
      const key = ratchetKey(category, finding);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return counts;
}

export const ratchetCounts = (findings: Readonly<Record<Category, readonly Finding[]>>): Map<string, number> =>
  keyCounts(findings, RATCHETED);

/** Every banned finding, by key: what `--lock` refuses over and `--ratchet` fails on. */
export const bannedKeys = (findings: Readonly<Record<Category, readonly Finding[]>>): string[] =>
  [...keyCounts(findings, BANNED).keys()].sort();

export function checkRatchet(
  findings: Readonly<Record<Category, readonly Finding[]>>,
  lock: string,
): RatchetVerdict {
  const entries = parseLock(lock).entries;
  const locked = new Map(entries.map((entry) => [entry.key, entry.count]));

  const today = ratchetCounts(findings);
  const added: string[] = [];
  const grown: string[] = [];

  for (const [key, count] of today) {
    const before = locked.get(key);

    if (before === undefined) added.push(key);
    else if (count > before) grown.push(`${key} (${String(before)} -> ${String(count)})`);
  }

  return {
    banned: bannedKeys(findings),
    added: added.sort(),
    grown: grown.sort(),
    stale: [...locked.keys()].filter((key) => !today.has(key)).sort(),
    unproven: entries.filter((entry) => (entry.plants ?? []).length === 0).map((entry) => entry.key).sort(),
  };
}

/** The lock over `findings`, each entry keeping the plants `plants` holds for its key. */
export function lockText(
  findings: Readonly<Record<Category, readonly Finding[]>>,
  measured: string,
  plants: ReadonlyMap<string, readonly Plant[]> = new Map(),
): string {
  const entries = [...ratchetCounts(findings)]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, count, ...(plants.has(key) && { plants: plants.get(key) }) }));

  return `${JSON.stringify({ measured, entries }, null, 2)}\n`;
}

/** Two measurements merged, so a seeded file can be ratcheted BESIDE the live
 *  tree rather than instead of it. */
export function mergeFindings(
  parts: readonly Readonly<Record<Category, readonly Finding[]>>[],
): Findings {
  const merged = noFindings();

  for (const part of parts) {
    for (const category of CATEGORIES) merged[category].push(...part[category]);
  }

  return merged;
}

/* ── CLI ─────────────────────────────────────────────────────────────── */

/** A census that measured nothing reports a clean corpus. Every run states what
 *  it read and dies if any of it is zero — the rule `gate-ratchet`'s
 *  `assertMeasured` states for the inventory gates, applied here. */
function assertMeasured(census: Census): string {
  const counts: readonly (readonly [string, number])[] = [
    ['test files', census.tree.files],
    ['runnable suites', census.tree.suites],
    ['tests', census.tree.tests],
    ['runners', census.runnerClaims.length],
    ['non-public product members', census.tree.productNonPublic],
    ['product function bodies', census.tree.productFunctions],
  ];

  const empty = counts.filter(([, count]) => count <= 0).map(([label]) => label);

  if (empty.length > 0) {
    throw new Error(`test-census: measured nothing (${empty.join(', ')} is zero) — `
      + 'a census that reads nothing reports a clean corpus');
  }

  return counts.map(([label, count]) => `${String(count)} ${label}`).join(', ');
}

function main(argv: readonly string[]): number {
  const census = runCensus();
  const measured = assertMeasured(census);

  const banned = bannedKeys(census.findings);

  for (const key of banned) console.error(`test-census: BANNED   ${key}`);

  if (banned.length > 0) {
    console.error('\ntest-census: a test that reads product source, restates product code, reaches a '
      + 'private member or mocks an internal module has no allowance. Rewrite it at a public boundary, '
      + 'or delete it and state the failure it could not catch; no lock records one.');
  }

  if (argv.includes('--lock') || argv.includes('--ratchet')) {
    const lock = readFileSync(LOCK, 'utf8');
    const verdict = checkRatchet(census.findings, lock);

    for (const key of verdict.added) console.error(`test-census: NEW      ${key}`);

    for (const key of verdict.grown) console.error(`test-census: MORE     ${key}`);

    if (verdict.added.length > 0 || verdict.grown.length > 0) {
      console.error('\ntest-census: a new tautology suspect is debt no lock records. '
        + 'Assert a value computed apart from the code under test, or delete the test and state the '
        + 'failure it could not catch; the lock only shrinks.');
    }

    if (banned.length > 0 || verdict.added.length > 0 || verdict.grown.length > 0) return 1;

    if (argv.includes('--lock')) {
      const plants = new Map(parseLock(lock).entries.map((entry) => [entry.key, entry.plants ?? []]));
      writeFileSync(LOCK, lockText(census.findings, `${census.tree.sha}: ${measured}`, plants));
      console.log(`test-census: locked ${String(ratchetCounts(census.findings).size)} keys — ${measured}`);

      return 0;
    }

    for (const key of verdict.stale) console.error(`test-census: RESOLVED ${key}`);

    if (verdict.stale.length > 0) {
      console.error('\ntest-census: run `bun scripts/test-census.ts --lock` to drop the resolved keys.');

      return 1;
    }

    for (const key of verdict.unproven) console.error(`test-census: UNPROVEN ${key}`);

    if (verdict.unproven.length > 0) {
      console.error('\ntest-census: a locked suspect names the plant that turns it red, or it is fixed; '
        + '`bun scripts/census-plants.ts` runs every plant.');

      return 1;
    }

    console.log(`test-census: ratchet ok — ${measured}`);

    for (const spot of census.blindSpots) console.log(`  blind: ${spot}`);

    return 0;
  }

  const json = JSON.stringify(census, null, 2);

  if (argv.includes('--json')) {
    console.log(json);

    return 0;
  }

  console.log(markdown(census));
  console.error(`test-census: ${measured}`);

  if (argv.includes('--write')) {
    const here = dirname(fileURLToPath(import.meta.url));
    const out = resolve(here, '..', 'bench-artifacts', 'test-census');
    mkdirSync(out, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    writeFileSync(join(out, `${date}.json`), `${json}\n`);
    writeFileSync(join(out, `${date}.md`), `${markdown(census)}\n`);
    console.error(`test-census: wrote bench-artifacts/test-census/${date}.{json,md}`);
  }

  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
