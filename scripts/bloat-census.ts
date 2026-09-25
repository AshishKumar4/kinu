/**
 * Bloat census: where this tree's size is, measured on the AST.
 *
 * `bun scripts/bloat-census.ts <out.json>` writes the census as JSON and prints
 * a ranked summary. Over product source (`readSources`) it measures, per
 * package, file and function: AST nodes; code and comment characters,
 * whitespace excluded; pass-through wrappers; module-private functions and
 * private methods with exactly one caller; duplicate function bodies below
 * `gate:duplication`'s floor; type and schema literals written more than once;
 * exports no production file reaches, by `gate:wired`'s reachability. It is a
 * measurement: nothing is locked and no finding fails the run.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { type Expression, parseSync } from 'oxc-parser';

import { gitEnv } from '../packages/test-utils/src/git';
import { type DuplicateGroup, findDuplicateGroups } from './ast-duplication';
import { packageOf } from './bloat-budget';
import { canonical, commentCharacters } from './comment-only';
import { measureFile } from './complexity';
import { exportedDeclarations, inScope } from './dead-code';
import { assertMeasured } from './gate-ratchet';
import { readMatching, readSources, readTests } from './sources';
import {
  classMembers, declarationOf, declaredBindings, declaredName, identifierText, memberCalleeName, ownerName,
  parse, referencedNames, type SyntaxNode, walk,
} from './syntax';
import { buildGraph, builtinToolNames, findEntrypoints, findUnreached, isReacher, measureReach } from './wired';

const root = new URL('..', import.meta.url).pathname;

/**
 * The smallest function body the clone search reads. Measured at 1dd25b3ad:
 * from 8 to 11 nodes the groups are one-line delegation methods colliding by
 * structure (27 copies of `return this.x.y(a)` at 8), which the wrapper count
 * already names; from 12 up they include real copies such as `toLf`/`toLF`.
 */
const CLONE_FLOOR = 12;

/**
 * Fields a literal needs before its repeats count. Measured at 1dd25b3ad: at two
 * fields 193 groups repeat, led by result arms carrying `error` (18 copies); at
 * three the repeats are records such as `{ stdout; stderr; exitCode }` (7 copies).
 */
const MIN_FIELDS = 3;

const SUMMARY_ROWS = 10;

/** Nodes that carry a body of their own; a method's body is its `FunctionExpression`. */
const CALLABLE: ReadonlySet<string> = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** Callees that build an object schema: valibot's and zod's. */
const OBJECT_SCHEMA: ReadonlySet<string> = new Set(['object', 'strictObject', 'looseObject']);

interface FileRow {
  readonly file: string;
  readonly package: string;
  readonly lines: number;
  readonly nodes: number;
  readonly codeChars: number;
  readonly commentChars: number;
  readonly comments: number;
  readonly functions: number;
}

interface FunctionRow {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  /** The function's subtree, nested functions included. */
  readonly nodes: number;
  /** The same, less every nested function's subtree. */
  readonly ownNodes: number;
  readonly complexity: number;
}

interface WrapperRow {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly kind: string;
  readonly callee: string;
  /** Reachable from outside the module: an exported declaration or a non-private member of one. */
  readonly exported: boolean;
}

interface SingleCallerRow {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly kind: 'function' | 'private-method';
  readonly nodes: number;
  readonly callerLine: number;
}

interface Site {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

interface LiteralSite extends Site {
  readonly kind: 'type' | 'schema';
  readonly key: string;
  readonly fields: number;
  readonly nodes: number;
}

interface RepeatGroup {
  readonly kind: 'type' | 'schema';
  readonly fields: number;
  readonly nodes: number;
  readonly copies: readonly Site[];
}

interface UnreachedRow {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly kind: 'value' | 'type';
  readonly reason: string;
}

interface FileCensus {
  readonly row: FileRow;
  readonly functions: readonly FunctionRow[];
  readonly wrappers: readonly WrapperRow[];
  readonly singleCallers: readonly SingleCallerRow[];
  readonly literals: readonly LiteralSite[];
  readonly lines: ReadonlyMap<string, number>;
}

interface FunctionSize {
  readonly nodes: number;
  readonly own: number;
}

interface TreeSize {
  readonly total: number;
  readonly functions: ReadonlyMap<SyntaxNode, FunctionSize>;
}

/** Subtree sizes of the whole tree and of every function in it, inclusive and own. */
function treeSize(tree: SyntaxNode): TreeSize {
  const functions = new Map<SyntaxNode, FunctionSize>();

  const visit = (node: SyntaxNode): readonly [number, number] => {
    let total = 1;
    let nested = 0;

    for (const child of node.children) {
      const [size, inner] = visit(child);
      total += size;
      nested += CALLABLE.has(child.type) ? size : inner;
    }

    if (CALLABLE.has(node.type)) functions.set(node, { nodes: total, own: total - nested });

    return [total, nested];
  };

  return { total: visit(tree)[0], functions };
}

function unwrapped(expression: Expression): Expression {
  if (expression.type === 'AwaitExpression') return unwrapped(expression.argument);

  if (expression.type === 'ParenthesizedExpression' || expression.type === 'TSAsExpression'
    || expression.type === 'TSSatisfiesExpression' || expression.type === 'TSNonNullExpression'
    || expression.type === 'ChainExpression') return unwrapped(expression.expression);

  return expression;
}

/** The single expression a function body evaluates, when that is all it does. */
function soleExpression(fn: SyntaxNode): Expression | undefined {
  const { raw } = fn;

  if (raw.type !== 'FunctionDeclaration' && raw.type !== 'FunctionExpression' && raw.type !== 'ArrowFunctionExpression') {
    return undefined;
  }

  const { body } = raw;

  if (body === null) return undefined;

  if (body.type !== 'BlockStatement') return body;
  const [only, ...rest] = body.body;

  if (only === undefined || rest.length > 0) return undefined;

  if (only.type === 'ReturnStatement') return only.argument ?? undefined;

  return only.type === 'ExpressionStatement' ? only.expression : undefined;
}

/** Node types a plain reference is built from: `f`, `this.store.get`, `super`. */
const REFERENCE: ReadonlySet<string> = new Set([
  'Identifier', 'PrivateIdentifier', 'MemberExpression', 'ThisExpression', 'Super', 'Literal',
]);

/**
 * The callee a function forwards to, when its body is one call to a plain
 * reference, passing the function's own parameters through unchanged and in
 * order. A callee that computes (`make().run`) does more than forward, and one
 * that reads a parameter (`(f, x) => f(x)`) applies it.
 */
function forwardedCallee(fn: SyntaxNode): SyntaxNode | undefined {
  const { raw } = fn;

  if (raw.type !== 'FunctionDeclaration' && raw.type !== 'FunctionExpression' && raw.type !== 'ArrowFunctionExpression') {
    return undefined;
  }

  const params: string[] = [];
  let spread = false;

  for (const param of raw.params) {
    if (param.type === 'Identifier') params.push(param.name);
    else if (param.type === 'RestElement' && param.argument.type === 'Identifier') {
      params.push(param.argument.name);
      spread = true;
    } else return undefined;
  }

  const expression = soleExpression(fn);
  const call = expression === undefined ? undefined : unwrapped(expression);

  if ((call?.type !== 'CallExpression' && call?.type !== 'NewExpression') || call.arguments.length !== params.length) {
    return undefined;
  }

  for (const [index, argument] of call.arguments.entries()) {
    const passed = spread && index === params.length - 1 && argument.type === 'SpreadElement' ? argument.argument : argument;

    if (passed.type !== 'Identifier' || passed.name !== params[index]) return undefined;
  }

  let callee: SyntaxNode | undefined;
  walk(fn, (node) => {
    if (node.raw === call.callee) callee = node;
  });

  if (callee === undefined) return undefined;
  let plain = true;
  walk(callee, (node) => {
    if (!REFERENCE.has(node.type)) plain = false;
  });
  const read = referencedNames(callee);

  return plain && !params.some((name) => read.has(name)) ? callee : undefined;
}

/**
 * What a function is to its reader, or undefined for an anonymous callback. A
 * function in value position is an `alias`: only a bare-identifier callee can
 * replace it, because `obj.method` taken as a value loses its receiver.
 */
function namedKind(fn: SyntaxNode): string | undefined {
  if (fn.type === 'FunctionDeclaration') return declaredName(fn) === undefined ? undefined : 'function';
  const owner = fn.parent;

  if (owner === undefined) return undefined;

  if (owner.raw.type === 'MethodDefinition' || owner.raw.type === 'TSAbstractMethodDefinition') return owner.raw.kind;

  if (owner.raw.type === 'VariableDeclarator' || owner.raw.type === 'PropertyDefinition' || owner.raw.type === 'Property') {
    return declaredName(owner) === undefined ? undefined : 'alias';
  }

  return undefined;
}

const isPrivateMember = (member: SyntaxNode): boolean =>
  (member.raw.type === 'MethodDefinition' || member.raw.type === 'PropertyDefinition')
  && (member.raw.accessibility === 'private' || member.raw.key.type === 'PrivateIdentifier');

/** Top-level statements another module can import from. */
function exportedStatements(file: string, text: string, tree: SyntaxNode): Set<SyntaxNode> {
  const names = exportedDeclarations(file, text, tree);
  const exported = new Set<SyntaxNode>();

  for (const statement of tree.children) {
    const { node, exported: wrapped } = declarationOf(statement);
    const declared = node.type === 'VariableDeclaration' ? declaredBindings(node, false) : [declaredName(node)];

    if (wrapped || declared.some((name) => name !== undefined && names.has(name))) exported.add(statement);
  }

  return exported;
}

/** Whether `fn` is part of what its module exports: not nested in another
 *  function, not a private member, inside an exported top-level statement. */
function isExported(fn: SyntaxNode, exported: ReadonlySet<SyntaxNode>): boolean {
  let node = fn;

  if (node.parent !== undefined && isPrivateMember(node.parent)) return false;

  while (node.parent !== undefined && node.parent.type !== 'Program') {
    node = node.parent;

    if (CALLABLE.has(node.type)) return false;
  }

  return exported.has(node);
}

interface Use {
  readonly line: number;
  readonly call: boolean;
  readonly inside: boolean;
}

interface SingleCaller {
  readonly name: string;
  readonly kind: 'function' | 'private-method';
  readonly fn: SyntaxNode;
  readonly line: number;
  readonly callerLine: number;
}

/** Module-private functions and private methods called from exactly one place outside themselves. */
function singleCallers(
  tree: SyntaxNode,
  exported: ReadonlySet<SyntaxNode>,
  lineAt: (offset: number) => number,
): SingleCaller[] {
  const candidates = new Map<string, { fn: SyntaxNode; span: SyntaxNode }>();

  for (const statement of tree.children) {
    if (exported.has(statement)) continue;
    const name = declaredName(statement);

    if (statement.type === 'FunctionDeclaration' && name !== undefined) candidates.set(name, { fn: statement, span: statement });

    const [declarator, ...others] = statement.type === 'VariableDeclaration' ? statement.children : [];
    const init = declarator?.children.at(-1);
    const bound = declarator === undefined ? undefined : declaredName(declarator);

    if (others.length === 0 && init !== undefined && bound !== undefined && CALLABLE.has(init.type)) {
      candidates.set(bound, { fn: init, span: statement });
    }
  }

  const uses = new Map<string, Use[]>();
  walk(tree, (node) => {
    const name = identifierText(node);
    const candidate = name === undefined ? undefined : candidates.get(name);

    if (name === undefined || candidate === undefined || !referencedNames(node).has(name)) return;
    const { parent } = node;

    // A closing tag names the element its opening tag already counted.
    if (parent?.type === 'JSXClosingElement') return;

    const call = (parent?.raw.type === 'CallExpression' && parent.raw.callee === node.raw)
      || (parent?.raw.type === 'JSXOpeningElement' && parent.raw.name === node.raw);

    const inside = node.start >= candidate.span.start && node.end <= candidate.span.end;
    const seen = uses.get(name);
    const use = { line: lineAt(node.start), call, inside };

    if (seen === undefined) uses.set(name, [use]); else seen.push(use);
  });

  const found = [...candidates].flatMap(([name, { fn, span }]): SingleCaller[] => {
    const [only, ...more] = uses.get(name) ?? [];

    return only?.call === true && !only.inside && more.length === 0
      ? [{ name, kind: 'function', fn, line: lineAt(span.start), callerLine: only.line }]
      : [];
  });

  walk(tree, (node) => {
    if (node.type !== 'ClassDeclaration' && node.type !== 'ClassExpression') return;

    for (const member of classMembers(node)) {
      if (member.raw.type !== 'MethodDefinition' || member.raw.kind !== 'method' || !isPrivateMember(member)) continue;
      const name = declaredName(member);
      const fn = member.children.at(-1);

      if (name === undefined || fn === undefined) continue;
      const calls: Use[] = [];
      walk(node, (reference) => {
        const { raw } = reference;

        if (raw.type !== 'MemberExpression' || raw.computed || raw.property.name !== name) return;
        const { parent } = reference;
        calls.push({
          line: lineAt(reference.start),
          call: parent?.raw.type === 'CallExpression' && parent.raw.callee === raw,
          inside: reference.start >= member.start && reference.end <= member.end,
        });
      });
      const [only, ...more] = calls;

      if (only?.call === true && !only.inside && more.length === 0) {
        found.push({
          name: `${declaredName(node) ?? '(class)'}.${name}`, kind: 'private-method', fn,
          line: lineAt(member.start), callerLine: only.line,
        });
      }
    }
  });

  return found;
}

/** A type or schema literal's fields, when it has enough of them to count. */
function literalFields(node: SyntaxNode): { kind: 'type' | 'schema'; fields: readonly SyntaxNode[] } | undefined {
  if (node.type === 'TSInterfaceBody' || node.type === 'TSTypeLiteral') {
    return node.children.length >= MIN_FIELDS ? { kind: 'type', fields: node.children } : undefined;
  }

  const callee = memberCalleeName(node);

  if (callee === undefined || !OBJECT_SCHEMA.has(callee) || node.raw.type !== 'CallExpression') return undefined;
  const [first] = node.raw.arguments;
  const literal = node.children.find((child) => child.raw === first);

  return literal?.type === 'ObjectExpression' && literal.children.length >= MIN_FIELDS
    ? { kind: 'schema', fields: literal.children }
    : undefined;
}

function censusOfFile(file: string, text: string): FileCensus {
  const { root: tree, lineAt } = parse(file, text);
  const { comments } = parseSync(file, text);
  const commentChars = commentCharacters(text, comments);
  const size = treeSize(tree);
  const measured = new Map(measureFile(file, text).map((entry) => [entry.offset, entry]));
  const exported = exportedStatements(file, text, tree);
  const functions: FunctionRow[] = [];
  const wrappers: WrapperRow[] = [];

  for (const [fn, { nodes, own }] of size.functions) {
    const entry = measured.get(fn.start);
    const name = entry?.name ?? declaredName(fn) ?? 'fn';
    functions.push({ file, line: lineAt(fn.start), name, nodes, ownNodes: own, complexity: entry?.complexity ?? 1 });
    const kind = namedKind(fn);
    const callee = kind === undefined ? undefined : forwardedCallee(fn);

    if (kind !== undefined && callee !== undefined && (kind !== 'alias' || callee.type === 'Identifier')) {
      wrappers.push({
        file, line: lineAt(fn.start), name, kind,
        callee: text.slice(callee.start, callee.end).replace(/\s+/g, ' ').trim().slice(0, 80),
        exported: isExported(fn, exported),
      });
    }
  }

  const literals: LiteralSite[] = [];
  walk(tree, (node) => {
    const found = literalFields(node);

    if (found === undefined) return;
    let nodes = 0;
    walk(node, () => {
      nodes += 1;
    });
    const key = found.fields.map((field) => canonical(field.raw)).sort((a, b) => a.localeCompare(b)).join('\n');
    const owner = node.parent === undefined ? undefined : declaredName(node.parent);
    literals.push({
      kind: found.kind, key: `${found.kind}\n${key}`, fields: found.fields.length, nodes,
      file, line: lineAt(node.start), name: owner ?? ownerName(node) ?? '(inline)', start: node.start, end: node.end,
    });
  });

  const lines = new Map<string, number>();

  for (const statement of tree.children) {
    const name = declaredName(declarationOf(statement).node);

    if (name !== undefined) lines.set(name, lineAt(statement.start));
  }

  return {
    row: {
      file, package: packageOf(file), lines: text.split('\n').length, nodes: size.total,
      codeChars: text.replace(/\s/g, '').length - commentChars, commentChars, comments: comments.length,
      functions: size.functions.size,
    },
    functions,
    wrappers,
    singleCallers: singleCallers(tree, exported, lineAt).map(({ fn, ...rest }) => ({
      file, ...rest, nodes: size.functions.get(fn)?.nodes ?? 0,
    })),
    literals,
    lines,
  };
}

/** Literals written more than once, outermost only: a repeated interface repeats every literal inside it. */
function repeatGroups(literals: readonly LiteralSite[]): RepeatGroup[] {
  const byKey = new Map<string, LiteralSite[]>();

  for (const site of literals) {
    const sites = byKey.get(site.key);

    if (sites === undefined) byKey.set(site.key, [site]); else sites.push(site);
  }

  const repeated = [...byKey.values()].filter((sites) => sites.length > 1)
    .sort((a, b) => (b[0]?.nodes ?? 0) - (a[0]?.nodes ?? 0));

  const kept: LiteralSite[][] = [];

  for (const sites of repeated) {
    const contained = sites.every((site) => kept.some((outer) => outer.some((o) =>
      o.file === site.file && o.start <= site.start && o.end >= site.end)));

    if (!contained) kept.push(sites);
  }

  return kept.flatMap((sites) => {
    const [first] = sites;

    return first === undefined ? [] : [{
      kind: first.kind, fields: first.fields, nodes: first.nodes,
      copies: sites.map(({ file, line, name, start, end }) => ({ file, line, name, start, end })),
    }];
  }).sort((a, b) => b.nodes * (b.copies.length - 1) - a.nodes * (a.copies.length - 1));
}

/** Exports no production file reaches, values and types, by `gate:wired`'s own graph. */
function unreachedExports(lines: ReadonlyMap<string, ReadonlyMap<string, number>>) {
  const reachers = readMatching(isReacher);
  const tests = readTests();
  const read = (file: string): string => reachers.get(file) ?? '';
  const graph = buildGraph(reachers);
  const entrypoints = findEntrypoints(reachers, graph.modules, builtinToolNames(graph.modules, read));
  const reach = measureReach(graph, entrypoints);

  const values: UnreachedRow[] = findUnreached(graph, reach, tests, read)
    .map(({ file, line, name, reason }) => ({ file, line, name, kind: 'value', reason }));

  const types: UnreachedRow[] = [...graph.modules].filter(([file]) => inScope(file)).flatMap(([file, module]) =>
    [...module.exports].filter((name) => !module.values.has(name) && !reach.reached.has(`${file}#${name}`))
      .map((name) => ({
        file, line: lines.get(file)?.get(name) ?? 1, name, kind: 'type' as const,
        reason: reach.live.has(file) ? 'no production reference' : 'no entrypoint reaches the file',
      })));

  return {
    values, types, dangling: graph.dangling, entrypoints: entrypoints.length, live: reach.live.size,
  };
}

const payoff = (group: DuplicateGroup): number => group.nodes * (group.members.length - 1);

/** The counts a package accumulates. Mutable: the census adds into one row per package. */
interface Counts {
  files: number;
  lines: number;
  nodes: number;
  codeChars: number;
  commentChars: number;
  functions: number;
  wrappers: number;
  singleCallers: number;
  clones: number;
  repeats: number;
  unreachedValues: number;
  unreachedTypes: number;
}

interface PackageRow extends Counts {
  readonly package: string;
}

const COUNTED = [
  'files', 'lines', 'nodes', 'codeChars', 'commentChars', 'functions',
  'wrappers', 'singleCallers', 'clones', 'repeats', 'unreachedValues', 'unreachedTypes',
] as const satisfies readonly (keyof Counts)[];

const emptyRow = (name: string): PackageRow => ({
  package: name, files: 0, lines: 0, nodes: 0, codeChars: 0, commentChars: 0, functions: 0,
  wrappers: 0, singleCallers: 0, clones: 0, repeats: 0, unreachedValues: 0, unreachedTypes: 0,
});

function git(...args: readonly string[]): string {
  return execFileSync('git', ['-C', root, ...args], { env: gitEnv(), encoding: 'utf8' }).trim();
}

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];

  return rows.map((row) => row.map((cell, column) => (column === 0
    ? cell.padEnd(widths[column] ?? 0)
    : cell.padStart(widths[column] ?? 0))).join('  ')).join('\n');
}

const count = (n: number): string => n.toLocaleString('en-US');

if (import.meta.main) {
  const out = process.argv[2];

  if (out === undefined) {
    console.error('usage: bun scripts/bloat-census.ts <out.json>');
    process.exit(2);
  }

  const started = performance.now();
  const sources = readSources();
  const censuses = [...sources].map(([file, text]) => censusOfFile(file, text));
  const files = censuses.map((census) => census.row);
  const functions = censuses.flatMap((census) => census.functions).sort((a, b) => b.nodes - a.nodes);
  const wrappers = censuses.flatMap((census) => census.wrappers);
  const single = censuses.flatMap((census) => census.singleCallers).sort((a, b) => a.nodes - b.nodes);
  const repeats = repeatGroups(censuses.flatMap((census) => census.literals));

  const gateKeys = new Set(findDuplicateGroups(sources).map((group) => group.key));

  const clones = findDuplicateGroups(sources, CLONE_FLOOR).filter((group) => !gateKeys.has(group.key))
    .sort((a, b) => payoff(b) - payoff(a));

  // gate:wired's graph keeps every parse until exit; free the earlier passes' trees before it starts.
  Bun.gc(true);
  const unreached = unreachedExports(new Map(censuses.map((census) => [census.row.file, census.lines])));

  const measured = assertMeasured('bloat-census', [
    ['source files', files.length],
    ['AST nodes', files.reduce((n, row) => n + row.nodes, 0)],
    ['comments', files.reduce((n, row) => n + row.comments, 0)],
    ['functions', functions.length],
    ['type and schema literals', censuses.reduce((n, census) => n + census.literals.length, 0)],
    ['entrypoints', unreached.entrypoints],
    ['live files', unreached.live],
  ]);

  const packages = new Map<string, PackageRow>();

  const bucket = (file: string): PackageRow => {
    const name = packageOf(file);
    const existing = packages.get(name);

    if (existing !== undefined) return existing;
    const fresh = emptyRow(name);
    packages.set(name, fresh);

    return fresh;
  };

  for (const row of files) {
    const into = bucket(row.file);
    into.files += 1;
    into.lines += row.lines;
    into.nodes += row.nodes;
    into.codeChars += row.codeChars;
    into.commentChars += row.commentChars;
    into.functions += row.functions;
  }

  for (const row of wrappers) bucket(row.file).wrappers += 1;

  for (const row of single) bucket(row.file).singleCallers += 1;

  for (const group of clones) for (const name of new Set(group.members.map((m) => m.file))) bucket(name).clones += 1;

  for (const group of repeats) for (const name of new Set(group.copies.map((c) => c.file))) bucket(name).repeats += 1;

  for (const row of unreached.values) bucket(row.file).unreachedValues += 1;

  for (const row of unreached.types) bucket(row.file).unreachedTypes += 1;

  const byPackage = [...packages.values()].sort((a, b) => b.nodes - a.nodes);
  const total = emptyRow('total');

  for (const row of byPackage) {
    for (const key of COUNTED) total[key] += row[key];
  }

  // A group spanning two packages counts once in each, and once in the total.
  total.clones = clones.length;
  total.repeats = repeats.length;

  const seconds = (performance.now() - started) / 1000;
  const revision = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain').length > 0;

  writeFileSync(out, `${JSON.stringify({
    revision, dirty, measured, seconds: Math.round(seconds * 10) / 10,
    definitions: {
      nodes: 'oxc ESTree nodes in the subtree (syntax.ts spine)',
      codeChars: 'non-whitespace characters outside comments',
      commentChars: 'non-whitespace characters inside comments, delimiters included',
      wrappers: 'named functions whose body is one call to a plain reference, passing their own parameters '
        + 'through in order; a function in value position counts only when that reference is a bare identifier',
      singleCallers: 'module-private functions and private methods referenced exactly once, by a call outside themselves',
      clones: `duplicate function bodies of ${String(CLONE_FLOOR)}+ nodes that gate:duplication's floor does not report`,
      repeats: `type or object-schema literals with ${String(MIN_FIELDS)}+ fields written more than once, field order ignored`,
      unreached: 'exports no production file reaches, by gate:wired; values and types',
    },
    totals: total,
    packages: byPackage,
    files: [...files].sort((a, b) => b.nodes - a.nodes),
    functions,
    wrappers,
    singleCallers: single,
    clones: clones.map((group) => ({ ...group, payoff: payoff(group) })),
    repeats,
    unreached: { dangling: unreached.dangling, values: unreached.values, types: unreached.types },
  }, null, 1)}\n`);

  const share = (row: { codeChars: number; commentChars: number }): string =>
    `${String(Math.round((100 * row.commentChars) / Math.max(1, row.codeChars + row.commentChars)))}%`;

  console.log(`bloat-census: ${measured} in ${seconds.toFixed(1)} s at ${revision.slice(0, 9)}${dirty ? ' (dirty)' : ''}`);
  console.log(`\n${table([
    ['package', 'files', 'nodes', 'code ch', 'comment ch', 'cmt%', 'wrap', '1-call', 'clones', 'repeat', 'unreach v/t'],
    ...[...byPackage, total].map((row) => [
      row.package, count(row.files), count(row.nodes), count(row.codeChars), count(row.commentChars), share(row),
      count(row.wrappers), count(row.singleCallers), count(row.clones), count(row.repeats),
      `${count(row.unreachedValues)}/${count(row.unreachedTypes)}`,
    ]),
  ])}`);

  const rank = <T,>(title: string, rows: readonly T[], cells: (row: T) => readonly string[]): void => {
    console.log(`\n${title}`);

    for (const row of rows.slice(0, SUMMARY_ROWS)) console.log(`  ${cells(row).join('  ')}`);
  };

  rank('files by comment characters', [...files].sort((a, b) => b.commentChars - a.commentChars),
    (row) => [count(row.commentChars).padStart(7), share(row).padStart(4), row.file]);

  rank('files by AST nodes', [...files].sort((a, b) => b.nodes - a.nodes),
    (row) => [count(row.nodes).padStart(7), row.file]);

  rank('functions by AST nodes (own nodes)', functions,
    (row) => [`${count(row.nodes)} (${count(row.ownNodes)})`.padStart(15), `${row.file}:${String(row.line)} ${row.name}`]);

  rank('duplicate bodies below the gate floor, by nodes saved', clones, (group) => [
    count(payoff(group)).padStart(5), `${String(group.members.length)}x ${String(group.nodes)} nodes`,
    group.members.map((m) => `${m.file}:${String(m.line)} ${m.name}`).join(' | '),
  ]);

  rank('repeated type and schema literals, by nodes saved', repeats, (group) => [
    count(group.nodes * (group.copies.length - 1)).padStart(5), `${group.kind} ${String(group.copies.length)}x ${String(group.fields)} fields`,
    group.copies.map((c) => `${c.file}:${String(c.line)} ${c.name}`).join(' | '),
  ]);

  if (unreached.dangling.length > 0) {
    console.log(`\nwarning: ${String(unreached.dangling.length)} local import(s) resolve to no file, so reach is undercounted`);
  }

  console.log(`\nfull census: ${out}`);
  console.log('  blind: sizes are syntax, not runtime cost; a small function called in a hot loop outweighs a large one run once.');
  console.log('  blind: single callers are counted by name within one file; a dynamic or bracket reference is not seen.');
  console.log('  blind: clones keep literal text, so a copy whose strings were also edited is not a clone here.');
}
