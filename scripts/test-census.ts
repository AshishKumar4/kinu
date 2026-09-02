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
 * WHAT IT IS NOW: a gate. `--ratchet` refuses a NEW instance of a ratcheted
 * axis, and it runs in the ladder's commit tier. Every run still prints what it
 * CANNOT see, because a blind spot visible only in red output is invisible
 * exactly when the tree is green.
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
 * this tool counted by hand and got a different number. At `d86cd6672` the
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

import { claims, deployGates, LADDER, packageScripts } from './ladder';
import {
  ANTI_SLOP_ROOT, ANTI_SLOP_RULES, isAntiSlopRuleSuite, isBunDiscoverableSuite, isParseable,
  isProductSource, isPythonSuite, isRunnableSuite, isStylesheet, isTestFile, isVitestEvalSuite,
  readRepositoryFile, readSources, trackedFiles, workspaceScope,
} from './sources';
import {
  classMembers, declaredName, importBindings, isFunctionLike, literalText, moduleSpecifiers,
  parse, stringArguments, type SyntaxNode, walk,
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

/** The axes a ratchet would pin: a NEW instance fails by name. The three left
 *  out are debt a reviewer reads rather than debt a commit adds — a declared
 *  skip is already governed by `skip-ratchet`, and a golden regeneration is a
 *  deliberate act with its own command. */
export const RATCHETED: readonly Category[] = [
  'source_text', 'mirror', 'tautology_suspect', 'private_reach', 'internal_mock',
];

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
  if (node.type === 'MemberExpression') {
    const property = node.computed ? '[…]'
      : node.property.type === 'Identifier' ? `.${node.property.name}` : '.?';
    return `${chainText(node.object)}${property}`;
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
 * carries the table and no function, and counting it as a test reported every
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

/** The repo's own source-reading assertion helpers. Named rather than
 *  re-detected: `packages/test-utils/src/source.ts` exists to make these
 *  non-vacuous, and its own docstring records three tests that had drifted into
 *  asserting against whole files. */
const SOURCE_HELPERS: ReadonlySet<string> = new Set(['memberBody', 'anchor', 'between']);

/**
 * The repository file a path literal names, or `undefined` when it names none.
 *
 * RESOLVED, NEVER PATTERN-MATCHED, and that is a set-equality rule rather than
 * a preference. This used to be a private regex — `(^|\/)(src|scripts)\/…` —
 * which is exactly the shape `gate:set-equality` refuses: a second spelling of
 * "a source file" beside the one in `sources.ts`, free to drift narrower than
 * the set it reports on. Only a path the ENUMERATION holds counts now, and what
 * counts as source is asked of the named predicates — so a path that is not in
 * the tree can no longer be reported as read, which the pattern could.
 *
 * EVERY ANCESTOR, because the literal is rarely the whole path. The two live
 * shapes are `join(import.meta.dir, '..', 'src/user/user-do.ts')` and
 * `` `${root}src/runtime.ts` ``, where the literal is relative to the package
 * root rather than to the suite's own directory, and `join(repositoryRoot,
 * path)`, where it is repo-relative. Resolving against the suite's directory
 * alone lost 20 real findings across six cf-backend suites — measured
 * 2026-09-01 — so the climb is what keeps this as wide as the pattern was.
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
  const candidates = literal.startsWith('.') ? [] : [collapse(literal)];
  for (let depth = parts.length; depth >= 0; depth -= 1) {
    candidates.push(collapse(`${parts.slice(0, depth).join('/')}/${literal}`));
  }
  return candidates.find((path) => tracked.has(path) && !isTestFile(path)
    && (isParseable(path) || isStylesheet(path)));
}

interface LocalFacts {
  /** Functions that assert, transitively — through a helper, or by throwing. */
  readonly asserting: ReadonlySet<string>;
  /** Functions that RETURN source text, transitively: they read a product file
   *  or call something that does. `source('src/cli/routes.ts')` is the shape,
   *  and it is why an assertion on `routes` is an assertion on source. */
  readonly sourceReaders: ReadonlySet<string>;
  /** Variables holding source text, from a source read or a `?raw` import. */
  readonly sourceValues: ReadonlySet<string>;
}

/** Which product file this call reads off disk, or `undefined` when it reads
 *  none. The path is the finding's own detail, so the question "does it read
 *  one" and the answer "which one" are one traversal. */
function productPathRead(
  node: SyntaxNode, from: string, tracked: ReadonlySet<string>,
): string | undefined {
  const r = node.raw;
  if (r.type !== 'CallExpression') return undefined;
  const chain = chainText(r.callee);
  const bare = chain.split('.').pop() ?? '';
  const isFsRead = (FS_READ.test(chain) || (FS_READ.test(bare) && FS_OBJECT.test(chain.split('.')[0] ?? '')))
    || chain === 'Bun.file' || chain === 'readRepositoryFile';
  if (!isFsRead) return undefined;
  let named: string | undefined;
  for (const argument of argumentNodes(node)) {
    walk(argument, (inner) => {
      if (named !== undefined) return;
      const text = literalText(inner);
      if (text === undefined) return;
      named = productFileNamed(text, from, tracked);
    });
    if (named !== undefined) return named;
  }
  return undefined;
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
 * Both are transitive closures over local calls, and both exist because the
 * first draft of this census got them wrong in the same way: it looked for the
 * SHAPE at the call site instead of following the file's own helper. 167
 * assertion-free tests became 15, and the source-text signal moved from "a
 * string that also occurs in src" (a majority-false-positive heuristic) to "the
 * asserted value came out of a file read".
 */
function localFacts(parsed: ParsedFile, tracked: ReadonlySet<string>): LocalFacts {
  interface Fn { readonly direct: boolean; readonly reads: boolean; readonly calls: Set<string> }
  const fns = new Map<string, Fn>();

  walk(parsed.tree, (node) => {
    if (!isFunctionLike(node) && node.raw.type !== 'ArrowFunctionExpression') return;
    const name = functionName(node);
    if (name === undefined) return;
    let direct = false;
    let reads = false;
    const calls = new Set<string>();
    walk(node, (inner) => {
      if (inner.raw.type === 'ThrowStatement') direct = true;
      if (inner.raw.type !== 'CallExpression') return;
      const called = calleeName(inner);
      if (called === undefined) return;
      if (called === 'expect' || called === 'assert' || ASSERTING_IMPORT.test(called)) direct = true;
      if (SOURCE_HELPERS.has(called)
        || productPathRead(inner, parsed.file, tracked) !== undefined) reads = true;
      calls.add(called);
    });
    fns.set(name, { direct, reads, calls });
  });

  const asserting = new Set([...fns].filter(([, f]) => f.direct).map(([name]) => name));
  const sourceReaders = new Set([...fns].filter(([, f]) => f.reads).map(([name]) => name));
  for (let pass = 0; pass < 8; pass += 1) {
    let grew = false;
    for (const [name, fn] of fns) {
      for (const called of fn.calls) {
        if (!asserting.has(name) && asserting.has(called)) { asserting.add(name); grew = true; }
        if (!sourceReaders.has(name) && sourceReaders.has(called)) {
          sourceReaders.add(name);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }

  // Variables holding source text: `const routes = source('src/cli/routes.ts')`,
  // `const src = readFileSync(...)`, and a `?raw` import binding.
  const sourceValues = new Set<string>();
  walk(parsed.tree, (node) => {
    if (node.raw.type === 'ImportDeclaration' && String(node.raw.source.value).includes('?raw')) {
      for (const bound of importBindings(node)) sourceValues.add(bound.local);
      return;
    }
    if (node.raw.type !== 'VariableDeclarator') return;
    const name = declaredName(node);
    const init = node.raw.init;
    if (name === undefined || init === null || init === undefined) return;
    const initNode = nodeAt(node, init.start, init.end);
    if (initNode === undefined) return;
    let fromSource = false;
    walk(initNode, (inner) => {
      const called = calleeName(inner);
      if (called === undefined) return;
      if (SOURCE_HELPERS.has(called) || sourceReaders.has(called)
        || productPathRead(inner, parsed.file, tracked) !== undefined) {
        fromSource = true;
      }
    });
    if (fromSource) sourceValues.add(name);
  });

  return { asserting, sourceReaders, sourceValues };
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
  const at = (node: SyntaxNode, what: string, detail: string): Finding => {
    const line = parsed.lineAt(node.start);
    return { file: parsed.file, line, test: titleAt(spans, line), what, detail };
  };

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
    const read = productPathRead(node, parsed.file, tracked);
    if (read !== undefined) found.push(at(node, 'reads a source file', read));
  });

  for (const expectation of expectations(parsed)) {
    if (expectation.subject === undefined) continue;
    const [actual] = argumentNodes(expectation.subject);
    if (actual === undefined) continue;
    let overSource: string | undefined;
    walk(actual, (inner) => {
      if (overSource !== undefined) return;
      const name = inner.raw.type === 'Identifier' ? inner.raw.name : undefined;
      if (name !== undefined && facts.sourceValues.has(name)) { overSource = name; return; }
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

/** `const NAME = <literal>` declarations at any depth — the shape a mirrored
 *  budget, cap or threshold takes on both sides. Only distinctive values are
 *  returned, because a shared `2` is noise and 1,176 rows of it drowned the 53
 *  real mirrors on this tree. */
function namedValues(parsed: ParsedFile): NamedValue[] {
  const found: NamedValue[] = [];
  walk(parsed.tree, (node) => {
    if (node.raw.type !== 'VariableDeclarator') return;
    const name = declaredName(node);
    const init = node.raw.init;
    if (name === undefined || init === null || init === undefined) return;
    if (init.type !== 'Literal') return;
    const line = parsed.lineAt(node.start);
    const asNumber = v.safeParse(NumberLiteral, init);
    if (asNumber.success) {
      if (distinctiveNumber(asNumber.output.value)) {
        found.push({ name, line, kind: 'number', value: asNumber.output.value });
      }
      return;
    }
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

/** The author's own declaration of a mirror. Deliberately counted: "mirrors the
 *  private 4096 budget; drift fails these tests" IS the finding, and it is the
 *  one form no value comparison reaches when the two numbers are written
 *  differently. */
const MIRROR_COMMENT = /\/[/*][^\n]*\b(mirrors?|mirrored|mirroring|drift fails|kept in step with)\b/iu;

function mirrors(
  parsed: ParsedFile,
  spans: readonly TestSpan[],
  imported: readonly string[],
  sources: ReadonlyMap<string, string>,
): Finding[] {
  const found: Finding[] = [];
  const lines = parsed.text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!MIRROR_COMMENT.test(line)) continue;
    found.push({
      file: parsed.file, line: index + 1, test: titleAt(spans, index + 1),
      what: 'declared mirror',
      detail: line.trim().slice(0, 90),
    });
  }
  if (imported.length === 0) return found;

  const testValues = namedValues(parsed);
  const testArrows = arrowBodies(parsed);
  if (testValues.length === 0 && testArrows.size === 0) return found;

  for (const module of imported) {
    const text = sources.get(module);
    if (text === undefined) continue;
    // No `try` here on purpose: `parse` already refuses loudly and names the
    // file, and a census that silently drops a module it cannot read measures a
    // narrower corpus than it reports — the defect this repository keeps finding
    // in its own gates.
    const parsedModule = parseFile(module, text);

    const byValue = new Map<string, string[]>();
    for (const entry of namedValues(parsedModule)) {
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

/** Bracket access to a member production declares non-public, `as any`,
 *  `as unknown as`, and `Reflect.get`. The first reads a private field without
 *  the compiler objecting; the others call a protected method. */
function privateReaches(
  parsed: ParsedFile,
  spans: readonly TestSpan[],
  nonPublic: ReadonlyMap<string, string>,
): Finding[] {
  const found: Finding[] = [];
  const at = (node: SyntaxNode, what: string, detail: string): Finding => {
    const line = parsed.lineAt(node.start);
    return { file: parsed.file, line, test: titleAt(spans, line), what, detail };
  };

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

/* ── Harness bridges ─────────────────────────────────────────────────── */

/** A `harness*` method on a test helper class that republishes a member the
 *  helper does not declare — so it came from the production base. Each is a door
 *  a test enters through that production has not got. */
export interface Bridge {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  /** Members it forwards to that the helper does not declare. */
  readonly forwards: readonly string[];
  /** Of those, the ones production declares `private`/`protected`, with the
   *  file that declares each — the evidence the bridge crosses a boundary. */
  readonly nonPublic: readonly string[];
}

function bridgesOf(parsed: ParsedFile, nonPublic: ReadonlyMap<string, string>): Bridge[] {
  const found: Bridge[] = [];
  walk(parsed.tree, (node) => {
    if (node.raw.type !== 'MethodDefinition') return;
    const name = declaredName(node);
    if (name === undefined || !name.startsWith('harness')) return;
    const fn = node.children.find(isFunctionLike);
    if (fn === undefined) return;

    const own = new Set<string>();
    let cls: SyntaxNode | undefined = node.parent;
    while (cls !== undefined && cls.raw.type !== 'ClassDeclaration') cls = cls.parent;
    if (cls !== undefined) {
      for (const member of classMembers(cls)) {
        const memberName = declaredName(member);
        if (memberName !== undefined) own.add(memberName);
      }
    }
    const forwards = new Set<string>();
    walk(fn, (inner) => {
      const r = inner.raw;
      if (r.type !== 'MemberExpression' || r.computed) return;
      if (r.object.type !== 'ThisExpression') return;
      if (r.property.type === 'PrivateIdentifier') { forwards.add(`#${r.property.name}`); return; }
      if (r.property.type !== 'Identifier' || own.has(r.property.name)) return;
      forwards.add(r.property.name);
    });
    found.push({
      name,
      file: parsed.file,
      line: parsed.lineAt(node.start),
      forwards: [...forwards].sort(),
      nonPublic: [...forwards].filter((member) => nonPublic.has(member)).sort(),
    });
  });
  return found;
}

/** Calls to a bridge that really crosses the boundary, counted only OUTSIDE the
 *  helper that declares it — inside, they are the bridge's own plumbing. */
function bridgeCalls(
  parsed: ParsedFile,
  spans: readonly TestSpan[],
  bridges: ReadonlyMap<string, Bridge>,
): Finding[] {
  const found: Finding[] = [];
  walk(parsed.tree, (node) => {
    const called = calleeName(node);
    if (called === undefined) return;
    const bridge = bridges.get(called);
    if (bridge === undefined || bridge.file === parsed.file || bridge.nonPublic.length === 0) return;
    const line = parsed.lineAt(node.start);
    found.push({
      file: parsed.file, line, test: titleAt(spans, line),
      what: 'harness bridge to a non-public member',
      detail: `${called}() -> ${bridge.nonPublic.join(', ')} (${bridge.file}:${String(bridge.line)})`,
    });
  });
  return found;
}

/* ── Mocks ───────────────────────────────────────────────────────────── */

const MOCK_REGISTRARS: ReadonlySet<string> = new Set([
  'module', 'mockModule', 'registerSynchronousMock', 'doMock', 'unstable_mockModule',
]);

/** Globals a spy at is a platform seam rather than an internal one. */
const PLATFORM_OBJECTS: ReadonlySet<string> = new Set([
  'console', 'Date', 'Math', 'globalThis', 'global', 'process', 'performance', 'crypto', 'fetch',
  'Response', 'Request', 'WebSocket',
]);

interface MockSplit { readonly internal: Finding[]; readonly external: Finding[] }

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
  localBindings: ReadonlySet<string>,
): MockSplit {
  const internal: Finding[] = [];
  const external: Finding[] = [];
  walk(parsed.tree, (node) => {
    const called = calleeName(node);
    if (called === undefined) return;
    const line = parsed.lineAt(node.start);
    const test = titleAt(spans, line);

    if (MOCK_REGISTRARS.has(called)) {
      for (const id of stringArguments(node)) {
        const ours = id.startsWith('.') || id.startsWith(`${scope}/`) || id.startsWith('@/');
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
    const base = targetText.split('.')[0] ?? '';
    const methodName = method === undefined ? '?' : literalText(method) ?? '?';
    const ours = localBindings.has(base) && !PLATFORM_OBJECTS.has(base);
    (ours ? internal : external).push({
      file: parsed.file, line, test,
      what: ours ? 'spy on an internal object' : 'spy at a platform seam',
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
 * `writeFileSync` argument, because the argument is usually a variable:
 * `scripts/prompt-golden.ts` builds its target with `join(here, '..',
 * 'packages', 'core', 'tests', 'fixtures', 'prompt-golden.json')` and passes the
 * binding, so an argument-only reader found nothing and reported zero goldens on
 * a tree that has one.
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
      if (node.raw.type === 'ThrowStatement') { asserts = true; return; }
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
  if (specifiers.some((s) => s.includes('cli-driver') || s.includes('eval-target'))) return 'e2e';
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
 * `deployGates()` parses deploy.sh's roster. The non-ladder runners come from
 * `package.json`'s scripts table. A second resolver here would be the defect
 * `gate-set-equality` exists to prevent: one set measured, another governed.
 *
 * The one claim that is not a command: the anti-slop aggregator imports its
 * per-rule suites dynamically, so `isAntiSlopRuleSuite` IS the claim. Those
 * files sit outside the census corpus, which the table states rather than hides.
 */
export function runnerClaims(tracked: readonly string[]): RunnerClaim[] {
  const testFiles = new Set(tracked.filter((file) => isTestFile(file) || isPythonSuite(file)));
  const out: RunnerClaim[] = [];
  const add = (name: string, tier: string, source: string, files: readonly string[]): void => {
    const kept = [...new Set(files)].filter((file) => testFiles.has(file)).sort();
    if (kept.length > 0) out.push({ name, tier, source, files: kept });
  };

  for (const gate of LADDER) {
    add(gate.run, gate.tier, 'scripts/ladder.ts LADDER', claims(gate.run, tracked));
  }
  const declared = new Set(LADDER.map((gate) => gate.run));
  for (const run of deployGates()) {
    if (declared.has(run)) continue;
    add(run, 'deploy', 'scripts/deploy.sh roster', claims(run, tracked));
    declared.add(run);
  }
  const scripts = packageScripts();
  const nonLadder: readonly (readonly [string, string])[] = [
    ['test', 'root `bun run test` — the partly disjoint agent-utils/core/compaction set'],
    ['test:cli', 'the full CLI suite runner'],
    ['test:workerd', 'the workerd layer, both roots'],
    ['test:eval', 'the eval tier: bun arm plus the vitest eval suites'],
    ['test:mutation', 'the exploration-policy mutation suite'],
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

const IMPORT_CANDIDATES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

function collapse(path: string): string {
  const stack: string[] = [];
  for (const part of path.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

/**
 * The tracked file a module specifier names, with the candidate-suffix rule
 * `wired.ts` uses — so "the module under test" means the same thing in both.
 *
 * ONE RESOLVER, and it is the reason the golden-fixture reader no longer
 * carries a `packages/[^/]+/src/` pattern of its own: "this script imports
 * product source" is now RESOLVED to a path the enumeration holds and asked of
 * `isProductSource`, rather than matched against the shape a specifier usually
 * has. A specifier that resolves nowhere is not an import of anything.
 */
function resolveSpecifier(
  specifier: string, dir: string, tracked: ReadonlySet<string>, scope: string,
): string | undefined {
  let base: string | undefined;
  if (specifier.startsWith('.')) base = collapse(`${dir}/${specifier}`);
  else if (specifier.startsWith(`${scope}/`)) {
    const rest = specifier.slice(scope.length + 1).split('/');
    base = collapse(`packages/${rest[0] ?? ''}/src/${rest.slice(1).join('/')}`);
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
 * which fixtures a generator writes, which bridges exist, and what the tracked
 * set is. Built once per run.
 */
export interface CensusInputs {
  readonly sources: ReadonlyMap<string, string>;
  readonly nonPublic: ReadonlyMap<string, string>;
  readonly generators: ReadonlyMap<string, string>;
  readonly bridges: ReadonlyMap<string, Bridge>;
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
  const { internal, external } = mocks(parsed, spans, inputs.scope, localNames);

  const findings: Findings = {
    source_text: sourceText(parsed, spans, facts, inputs.tracked),
    mirror: mirrors(parsed, spans, local, inputs.sources),
    tautology_suspect: tautologies(parsed, spans, localNames),
    private_reach: [
      ...privateReaches(parsed, spans, inputs.nonPublic),
      ...bridgeCalls(parsed, spans, inputs.bridges),
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
export function censusInputs(tracked: readonly string[]): CensusInputs {
  const sources = readSources();
  const nonPublic = nonPublicMembers(sources);
  const bridges = new Map<string, Bridge>();
  for (const file of tracked.filter(isCensusFile)) {
    const parsed = parseFile(file, readRepositoryFile(root, file));
    for (const bridge of bridgesOf(parsed, nonPublic)) bridges.set(bridge.name, bridge);
  }
  return {
    sources,
    nonPublic,
    generators: fixtureGenerators(tracked),
    bridges,
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
  const inputs = censusInputs(tracked);

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

  const claimsTable = runnerClaims(tracked);
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
  'mirrors by DERIVATION: a test that recomputes a formula instead of restating its constant '
  + 'is caught only when a NAMED literal value is shared',
  'tautology through a stored value: `expect(actual).toEqual(expected)` where `expected` was '
  + 'produced earlier by the code under test and held in a variable',
  'private reach through destructuring, `Object.entries` over a private map, a public getter '
  + 'over private state, or a cast TypeScript erases',
  'SHAPE GATES are not separated from coupled tests: whether a source-text assertion guards a '
  + 'rule no behavioural test can express is a judgement, and this census reports the reach and '
  + 'leaves the ruling to the reviewer',
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

  p('## Harness bridges');
  p();
  const crossing = census.bridges.filter((bridge) => bridge.nonPublic.length > 0);
  p(`${String(census.bridges.length)} \`harness*\` bridges exist; ${String(crossing.length)} forward `
    + 'to a member production declares `private` or `protected`.');
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

const LockSchema = v.object({
  measured: v.string(),
  entries: v.array(v.object({ key: v.string(), count: v.number() })),
});

export interface RatchetVerdict {
  /** Keys in the tree and absent from the lock — new coupling. */
  readonly added: readonly string[];
  /** Keys whose count GREW: the same test acquired more of the same coupling. */
  readonly grown: readonly string[];
  /** Locked keys that no longer reproduce — the lock needs rewriting. */
  readonly stale: readonly string[];
}

/** The ratcheted findings, keyed and counted. Takes the findings record rather
 *  than a whole census, so the suite can ratchet a measurement it seeded from
 *  text without a Census — and therefore without touching the tree. */
export function ratchetCounts(
  findings: Readonly<Record<Category, readonly Finding[]>>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const category of RATCHETED) {
    for (const finding of findings[category]) {
      const key = ratchetKey(category, finding);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

export function checkRatchet(
  findings: Readonly<Record<Category, readonly Finding[]>>,
  lock: string,
): RatchetVerdict {
  const locked = new Map(
    v.parse(LockSchema, JSON.parse(lock)).entries.map((entry) => [entry.key, entry.count]),
  );
  const today = ratchetCounts(findings);
  const added: string[] = [];
  const grown: string[] = [];
  for (const [key, count] of today) {
    const before = locked.get(key);
    if (before === undefined) added.push(key);
    else if (count > before) grown.push(`${key} (${String(before)} -> ${String(count)})`);
  }
  return {
    added: added.sort(),
    grown: grown.sort(),
    stale: [...locked.keys()].filter((key) => !today.has(key)).sort(),
  };
}

export function lockText(
  findings: Readonly<Record<Category, readonly Finding[]>>,
  measured: string,
): string {
  const entries = [...ratchetCounts(findings)]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, count }));
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
    ['non-public product members', census.bridges.length],
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

  if (argv.includes('--lock')) {
    writeFileSync(LOCK, lockText(census.findings, `${census.tree.sha}: ${measured}`));
    console.log(`test-census: locked ${String(ratchetCounts(census.findings).size)} keys — ${measured}`);
    return 0;
  }
  if (argv.includes('--ratchet')) {
    let lock: string;
    try {
      lock = readFileSync(LOCK, 'utf8');
    } catch {
      console.error('test-census: no lock file. Run `bun scripts/test-census.ts --lock` first.');
      return 1;
    }
    const verdict = checkRatchet(census.findings, lock);
    if (verdict.added.length === 0 && verdict.grown.length === 0 && verdict.stale.length === 0) {
      console.log(`test-census: ratchet ok — ${measured}`);
      for (const spot of census.blindSpots) console.log(`  blind: ${spot}`);
      return 0;
    }
    for (const key of verdict.added) console.error(`test-census: NEW      ${key}`);
    for (const key of verdict.grown) console.error(`test-census: MORE     ${key}`);
    for (const key of verdict.stale) console.error(`test-census: RESOLVED ${key}`);
    console.error('\ntest-census: a new coupled test is debt this ratchet refuses. Enter through the '
      + 'public surface instead, or run `bun scripts/test-census.ts --lock` to record a deliberate '
      + 'exception and say why in the commit.');
    return 1;
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
