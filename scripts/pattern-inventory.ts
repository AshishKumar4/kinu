import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import * as v from 'valibot';
import { isParseable, isPatternSource, readMatching, trackedFiles } from './sources';
import { declaredName, literalString, literalText, memberCalleeName, ownerName, parse, regexPattern, type SyntaxNode, walk } from './syntax';

export const PATTERN_CATEGORIES = {
  lexical: 'NECESSARY: recognizes or transforms a regular-language token, text fragment, or output format.',
  composition: 'NECESSARY: constructs a runtime pattern from other patterns or caller search input.',
  code: 'CANDIDATE: extracts programming-language structure. Review against the available AST parser.',
  scanner: 'CANDIDATE: a named scanner combines iteration with string slicing. Review its input grammar.',
  shell: 'NECESSARY: a shell pattern command selects or transforms command output. Structured inputs need review.',
};

export type PatternCategory = keyof typeof PATTERN_CATEGORIES;

export interface PatternSite {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
  readonly owner: string;
  readonly source: string;
  readonly category: PatternCategory;
}

/** Escapes that match a class, a boundary, a property or a back-reference: no fixed character. */
const SET_ESCAPES = new Set(['d', 'D', 'w', 'W', 's', 'S', 'b', 'B', 'p', 'P', 'k']);

/**
 * The literal text a regex source requires, as runs cut at every token that is
 * not one fixed character. A token walk over the ECMAScript Pattern grammar:
 * a class `[…]`, a group opener (`(`, `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`,
 * `(?<name>`), `)`, `|`, `^`, `$` and `.` cut a run; a quantifier (`*`, `+`,
 * `?`, `{n}`, `{n,}`, `{n,m}`) cuts it and takes back the character it repeats;
 * `\d \w \s \b \p{…} \k<…> \1` cut it; `\n \t \xHH \uHHHH` and an identity
 * escape are one character. So `(?<name>…)` is a group, not markup.
 */
export function patternLiteralRuns(pattern: string): string[] {
  const runs: string[] = [];
  let run = '';

  for (let at = 0; at < pattern.length;) {
    const token = patternToken(pattern, at);

    if (token.literal !== undefined) {
      run += token.literal;
    } else {
      if (token.repeats) run = run.slice(0, -1);

      if (run !== '') runs.push(run);
      run = '';
    }

    at = token.end;
  }

  if (run !== '') runs.push(run);

  return runs;
}

/** One pattern token at `at`: its end, and the character it matches when it is exactly one. */
interface PatternToken {
  readonly end: number;
  readonly literal?: string;
  /** A quantifier: the character before it is not required. */
  readonly repeats?: true;
}

function patternToken(pattern: string, at: number): PatternToken {
  const char = pattern[at] ?? '';
  const next = pattern[at + 1] ?? '';

  if (char === '\\') return escapeToken(pattern, at);

  if (char === '[') return { end: classEnd(pattern, at) };

  if (char === '(') {
    if (next !== '?') return { end: at + 1 };

    const lookbehind = pattern[at + 3] === '=' || pattern[at + 3] === '!';

    if (pattern[at + 2] === '<' && !lookbehind) return { end: pattern.indexOf('>', at) + 1 };

    return { end: at + (pattern[at + 2] === '<' ? 4 : 3) };
  }

  let close = at + 1;

  while (char === '{' && '0123456789,'.includes(pattern[close] ?? '|')) close += 1;

  if (char === '*' || char === '+' || char === '?' || (char === '{' && close > at + 1 && pattern[close] === '}')) {
    const end = (char === '{' ? close : at) + 1;

    return { end: end + (pattern[end] === '?' ? 1 : 0), repeats: true };
  }

  return char === ')' || char === '|' || char === '^' || char === '$' || char === '.' ? { end: at + 1 } : { end: at + 1, literal: char };
}

/** Past the `]` closing the class at `at`; a leading `]` (or `^]`) is a member. */
function classEnd(pattern: string, at: number): number {
  let end = at + (pattern[at + 1] === '^' ? 2 : 1);
  end += pattern[end] === ']' ? 1 : 0;

  while (end < pattern.length && pattern[end] !== ']') end += pattern[end] === '\\' ? 2 : 1;

  return end + 1;
}

function escapeToken(pattern: string, at: number): PatternToken {
  const next = pattern[at + 1] ?? '';

  if (next === 'k') return { end: pattern.indexOf('>', at) + 1 || pattern.length };

  if ((next === 'p' || next === 'P') && pattern[at + 2] === '{') return { end: pattern.indexOf('}', at) + 1 || pattern.length };

  if (SET_ESCAPES.has(next) || (next >= '1' && next <= '9')) return { end: at + 2 };

  if (next === 'x' || next === 'u') {
    const braced = next === 'u' && pattern[at + 2] === '{';
    const end = braced ? pattern.indexOf('}', at) : at + (next === 'x' ? 4 : 6);
    const code = Number.parseInt(pattern.slice(at + (braced ? 3 : 2), end), 16) || 0;

    return { end: braced ? end + 1 : end, literal: String.fromCodePoint(code) };
  }

  // A control escape (`\n`, `\t`, `\cJ`, `\0`) is one character that is never part of a word.
  return { end: at + (next === 'c' ? 3 : 2), literal: isWordChar(next) ? ' ' : next };
}

const CODE_KEYWORDS = new Set(['import', 'export', 'require', 'function', 'class', 'interface']);

const isWordChar = (char: string): boolean =>
  (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char === '_' || char === '$';

/** A pattern extracts code when its required literal text holds a declaration keyword as a whole word, or opens markup (`<tag`, `</`). */
function namesCode(fragments: readonly string[]): boolean {
  return fragments.flatMap(patternLiteralRuns).some((run) => {
    let word = '';

    for (let at = 0; at <= run.length; at += 1) {
      const char = run[at] ?? ' ';

      if (char === '<' && (run[at + 1] === '/' || isWordChar(run[at + 1] ?? ' '))) return true;

      if (isWordChar(char)) {
        word += char;
        continue;
      }

      if (CODE_KEYWORDS.has(word)) return true;
      word = '';
    }

    return false;
  });
}

const SCANNER_NAME = /^(?:parse|scan|strip|tokenize|lex|extract|split|decode)/i;

const STRING_OPERATIONS = {
  slice: true, split: true, charAt: true, charCodeAt: true, indexOf: true,
} satisfies Readonly<Record<string, true>>;

/** The literal pattern text a `RegExp(…)` call is handed: a string argument, or each chunk of a template. */
function patternFragments(call: SyntaxNode): string[] {
  const [argument] = call.children.filter((child) => child.start > (call.raw.type === 'NewExpression' || call.raw.type === 'CallExpression' ? call.raw.callee.end : call.start));

  if (argument === undefined) return [];
  const direct = literalString(argument.raw);

  if (direct !== undefined) return [direct];

  return argument.raw.type === 'TemplateLiteral' ? argument.children.map(literalText).filter((text) => text !== undefined) : [];
}

export function inventoryJavaScript(file: string, source: string): PatternSite[] {
  const tree = parse(file, source);
  const sites: PatternSite[] = [];
  walk(tree.root, node => {
    const pattern = regexPattern(node);

    if (pattern !== undefined) {
      sites.push({ file, line: tree.lineAt(node.start), kind: 'regex-literal', owner: ownerName(node) ?? '<module>',
        source: source.slice(node.start, node.end), category: namesCode([pattern]) ? 'code' : 'lexical' });

      return;
    }

    const raw = node.raw;

    if ((raw.type === 'NewExpression' || raw.type === 'CallExpression')
      && raw.callee.type === 'Identifier' && raw.callee.name === 'RegExp') {
      sites.push({ file, line: tree.lineAt(node.start), kind: 'regexp-constructor', owner: ownerName(node) ?? '<module>',
        source: source.slice(node.start, node.end), category: namesCode(patternFragments(node)) ? 'code' : 'composition' });
    }

    if (raw.type !== 'FunctionDeclaration' && raw.type !== 'FunctionExpression' && raw.type !== 'ArrowFunctionExpression') return;
    const name = declaredName(node) ?? ownerName(node) ?? '<anonymous>';

    if (!SCANNER_NAME.test(name)) return;
    let loop = false;
    let slicing = false;
    walk(node, child => {
      if (child.type === 'ForStatement' || child.type === 'WhileStatement' || child.type === 'ForOfStatement') loop = true;

      if (child.raw.type === 'MemberExpression' && child.raw.computed) slicing = true;
      const operation = memberCalleeName(child);

      if (operation !== undefined && Object.hasOwn(STRING_OPERATIONS, operation)) slicing = true;
    });

    if (loop && slicing) sites.push({ file, line: tree.lineAt(node.start), kind: 'hand-parser', owner: name,
      source: source.slice(node.start, node.end), category: 'scanner' });
  });

  return sites;
}

const PYTHON_SCANNER = String.raw`
import ast, json, sys
rows = []
for file, text in json.load(sys.stdin):
    tree = ast.parse(text, filename=file)
    modules = {'re', 'regex'}
    functions = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.asname or alias.name for alias in node.names if alias.name in {'re', 'regex'})
        if isinstance(node, ast.ImportFrom) and node.module in {'re', 'regex'}:
            functions.update(alias.asname or alias.name for alias in node.names)
    class Scan(ast.NodeVisitor):
        owner = '<module>'
        def visit_FunctionDef(self, node):
            prior = self.owner
            self.owner = node.name
            self.generic_visit(node)
            self.owner = prior
        visit_AsyncFunctionDef = visit_FunctionDef
        def visit_Call(self, node):
            callee = node.func
            regex = (isinstance(callee, ast.Attribute) and isinstance(callee.value, ast.Name) and callee.value.id in modules)
            regex = regex or (isinstance(callee, ast.Name) and callee.id in functions)
            if regex and node.args:
                rows.append(dict(file=file, line=node.lineno, kind='python-regex', owner=self.owner,
                    source=ast.get_source_segment(text, node) or '', category='lexical'))
            self.generic_visit(node)
    Scan().visit(tree)
print(json.dumps(rows))
`;

const SiteSchema = v.object({
  file: v.string(), line: v.number(), kind: v.string(), owner: v.string(), source: v.string(),
  category: v.picklist(['lexical', 'composition', 'code', 'scanner', 'shell']),
});

/** Decisions apply to grammar families. Every candidate remains in the output. */
export const PATTERN_REVIEWS = {
  grammar: 'NECESSARY: an owned reader over the grammar stated in its header, for a format no installed parser reads; its gate test plants the shapes a regex missed.',
  framing: 'NECESSARY: locates records in mixed prose or a line protocol before a real parser validates each record.',
  lexical: 'NECESSARY: matches a token or rendered fragment; it does not claim to parse the enclosing language.',
  traversal: 'NECESSARY: traverses parsed objects, AST ranges, or byte buffers. The name-based candidate detector is conservative.',
  cli: 'NECESSARY: scans a small application-owned argument or chord vocabulary. JSON and language parsers do not implement it.',
  safety: 'NECESSARY: conservative lexical policy checks references, including forbidden text; accepting a general grammar would change that policy.',
  sourceGate: 'DEFERRED: extracts source for a contract fixture or gate. Replacing its reader changes the tested program or denominator; preserve its red fixtures in a separate semantic change.',
  traceability: 'DEFERRED: the Node-run checker owns Lean nesting and TypeScript declaration spans. Replacing that parser needs parity for theorem ownership and line ranges, beyond replacing one pattern.',
  frontmatter: 'DEFERRED: the Worker parser deliberately accepts a bounded YAML subset. Bun.YAML is unavailable in Workers; a replacement adds a portable dependency and changes accepted syntax.',
  html: 'DEFERRED: conversion is synchronous and lossy. HTMLRewriter is asynchronous; a full parser changes this API and its callers. No runtime dependency is added for this inventory.',
  xml: 'DEFERRED: XML field extraction needs a namespace-aware parser to be a full replacement. A local regex rewrite would keep the same defect class.',
  daemon: 'DEFERRED: Bun.Transpiler.scan returned no require calls in the measured fixture. The owned daemon uses literal sibling requires; a parser replacement needs a different bundled API.',
  handbook: 'DEFERRED: the handbook indexes a flat scaffold and its bridge references. A complete AST replacement must preserve notes and declaration ownership; this inventory records the limitation.',
  protected: 'DEFERRED: layergate and devbox are explicit non-goals. The inventory includes their candidates without changing their checks.',
  bundleResolver: 'DEFERRED: rewrites the bare specifiers left in an esbuild output because the VFS plugin Nimbus installs resolves before esbuild\'s alias step, so a resolver cannot answer them in the build. Replacing it needs an embedder-supplied onResolve hook in Nimbus\'s EsbuildService; the rewrite is anchored to statement position and pinned by the bundle tests.',
};

const ReviewedSiteSchema = v.object({
  file: v.string(), kind: v.string(), owner: v.string(), sourceSha256: v.string(),
  decision: v.picklist(Object.keys(PATTERN_REVIEWS)),
});

type PatternReview = v.InferOutput<typeof ReviewedSiteSchema>;

function sourceHash(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function reviewKey(site: Pick<PatternSite, 'file' | 'kind' | 'owner'>, digest: string): string {
  return JSON.stringify([site.file, site.kind, site.owner, digest]);
}

export function buildPatternInventory(corpus: ReadonlyMap<string, string>, reviews: readonly PatternReview[] = []) {
  const sites: PatternSite[] = [];
  const python: [string, string][] = [];
  const measured: string[] = [];

  for (const [file, source] of corpus) {
    if (!isPatternSource(file)) throw new Error(`outside the pattern source set: ${file}`);
    measured.push(file);

    if (isParseable(file)) sites.push(...inventoryJavaScript(file, source));
    else if (file.endsWith('.py')) python.push([file, source]);
    else {
      for (const [index, line] of source.split('\n').entries()) {
        if (line.trimStart().startsWith('#') || !/\b(?:sed|awk|gawk|grep|rg)\b|=~/.test(line)) continue;
        sites.push({ file, line: index + 1, kind: 'shell-pattern-command', owner: '<shell>', source: line.trim(),
          category: line.includes('package.json') ? 'code' : 'shell' });
      }
    }
  }

  if (python.length > 0) sites.push(...v.parse(v.array(SiteSchema), JSON.parse(execFileSync('python3', ['-c', PYTHON_SCANNER], {
    input: JSON.stringify(python), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }))));
  sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.kind.localeCompare(b.kind));
  const counts = { lexical: 0, composition: 0, code: 0, scanner: 0, shell: 0 };

  for (const site of sites) counts[site.category]++;
  const reviewed = new Map<string, string>();

  for (const review of reviews) reviewed.set(reviewKey(review, review.sourceSha256), review.decision);

  const candidates = sites.filter(site => site.category === 'code' || site.category === 'scanner')
    .map(site => ({ ...site, decision: reviewed.get(reviewKey(site, sourceHash(site.source))) ?? null }));

  return { measured: measured.sort(), categories: PATTERN_CATEGORIES, reviews: PATTERN_REVIEWS, counts, sites, candidates };
}

function located<TSite extends PatternSite>({ source, ...fields }: TSite) {
  return { ...fields, sourceSha256: sourceHash(source) };
}

if (import.meta.main) {
  const corpus = readMatching(isPatternSource);

  const recorded = v.parse(v.object({ candidates: v.array(ReviewedSiteSchema) }),
    JSON.parse(readFileSync(new URL('./pattern-inventory.json', import.meta.url), 'utf8')));

  const result = buildPatternInventory(corpus, recorded.candidates);
  const governed = trackedFiles().filter(isPatternSource).sort();
  assert.deepEqual(result.measured, governed);
  assert.ok(result.sites.length > 0 && result.counts.composition > 0, 'pattern census is empty');
  const pending = result.candidates.filter(site => site.decision === null);

  for (const site of pending) process.stderr.write(`${site.file}:${site.line} ${site.owner}: ${site.kind}\n`);

  const replacements = [{ file: 'packages/cli-backend/src/executor.ts', owner: 'createSandboxedExecutor',
      classification: 'REPLACED', replacement: 'Package-owned @cloudflare/codemode/normalize through typed local runtime adapters',
      proof: 'bun test packages/cli-backend/tests/executor.test.ts packages/cli-backend/tests/codemode-tool-factory.test.ts' },
    { file: 'scripts/jsonc.ts', owner: 'parseJsonc', classification: 'REPLACED',
      replacement: 'Bun.JSONC.parse followed by the existing Valibot schema',
      proof: 'bun test scripts/jsonc.test.ts scripts/release-config.test.ts scripts/analytics-datasets.test.ts' },
    { file: 'scripts/setup-worktree.sh', owner: 'SCOPES and package name', classification: 'REPLACED',
      replacement: 'JSON.parse reads the top-level manifest name instead of sed field extraction',
      proof: 'The nested-name smoke fixture returned @wrong before the change and @right after it.' },
    { file: 'scripts/schema-drift.ts', owner: 'parseTables, parseViews, parseParts', classification: 'REPLACED',
      replacement: 'scripts/sql-text.ts folds string expressions off the oxc tree; sql-parser-cst reads each CREATE',
      proof: 'bun test scripts/schema-drift.test.ts --test-name-pattern "RED: every spelling|RED: a view spelled"' },
    { file: 'scripts/skip-ratchet.ts', owner: 'parseJUnit', classification: 'REPLACED',
      replacement: 'scripts/xml.ts reads the report as XML; outcomes are child elements',
      proof: 'bun test scripts/skip-ratchet.test.ts' },
    { file: 'lean/check-traceability.mjs', owner: 'tsScan', classification: 'REPLACED',
      replacement: 'lean/ts-refs.mjs resolves tsRefs through oxc-parser',
      proof: 'bun test scripts/lean-citations.test.ts' }];

  if (process.argv.includes('--write') && pending.length === 0) writeFileSync(new URL('./pattern-inventory.json', import.meta.url), `${JSON.stringify({
    candidates: result.candidates.map(({ file, kind, owner, source, decision }) => ({
      file, kind, owner, sourceSha256: sourceHash(source), decision,
    })),
  }, null, 2)}\n`);

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ ...result, sites: result.sites.map(located), candidates: result.candidates.map(located), replacements }, null, 2)}\n`);
  } else {
    process.stdout.write(`pattern-inventory: ${result.measured.length} measured = ${governed.length} governed files; ${result.sites.length} sites; ${JSON.stringify(result.counts)}; ${result.candidates.length} candidates; ${pending.length} unreviewed; ${replacements.length} parsers replaced. Blind spots: runtime aliases of RegExp, implicit regex coercion, unnamed scanners, other native languages, and vendored agent-core output. Python uses its AST; shell entries identify whole pattern commands, not each embedded language token. Classification is syntactic. A review matches only unchanged source bytes, file, owner and kind; changed dependencies or surrounding semantics need human review. Review decisions in the artifact remain author assertions. --json emits the complete current inventory.\n`);
  }

  if (pending.length > 0) process.exitCode = 1;
}
