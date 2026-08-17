/**
 * The one AST substrate for the static-analysis gates.
 *
 * TypeScript 7 is a Go compiler: the `typescript` package exports
 * `{version, versionMajorMinor}` and nothing else, and `typescript/unstable/ast`
 * has no parser — its `createSourceFile` assembles a node from statements, and
 * the only way to parse a file is an RPC channel into the compiler process. So
 * the gates parse with `oxc-parser`, which is in-process, is the parser family
 * behind `oxlint` (deploy gate 1), and was already resolved in the tree.
 *
 * oxc's JS API emits **ESTree** shape, not the Rust AST's names, and the two
 * disagree in ways that produce an empty walk rather than an error: there is no
 * `StaticMemberExpression`, `StringLiteral` or `MethodDeclaration` at runtime; a
 * member access is `MemberExpression` with a `computed` flag, every literal is
 * `Literal`, and a method is `MethodDefinition`. ESTree also *wraps* an exported
 * declaration in `ExportNamedDeclaration`, where TypeScript hung an `export`
 * modifier on the declaration itself. Knowing that is this module's job; no
 * caller should have to.
 *
 * Traversal is oxc's own `Visitor`, so the child fields and their order come from
 * the parser rather than from a list here that could fall behind it — and every
 * accessor below narrows oxc's published node union, so a shape that moves is a
 * type error rather than a silently empty result. `oxc-parser` does not populate
 * the optional `parent` pointers, which is the one thing this module adds: a
 * parent-linked spine over the same nodes.
 *
 * A gate that parses nothing is indistinguishable from a gate with no findings,
 * so a parse error here is fatal.
 */

import { type Node, parseSync, type VisitorObject, Visitor, visitorKeys } from 'oxc-parser';
import * as v from 'valibot';

/** A parsed node: oxc's own node, plus the spine oxc leaves out. */
export interface SyntaxNode {
  readonly raw: Node;
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly parent: SyntaxNode | undefined;
  readonly children: readonly SyntaxNode[];
}

interface Parsed {
  readonly root: SyntaxNode;
  /** 1-based line of a byte offset. */
  lineAt(offset: number): number;
}

interface Building {
  readonly raw: Node;
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly parent: SyntaxNode | undefined;
  readonly children: SyntaxNode[];
}

export function parse(file: string, text: string): Parsed {
  const { program, errors } = parseSync(file, text, {
    lang: file.endsWith('.tsx') ? 'tsx' : 'ts',
  });
  if (errors.length > 0) {
    // Loud, not skipped. A gate that quietly parses fewer files is
    // indistinguishable from a gate with no findings, which is how
    // `unit-layergate.test.ts` came to pass on an empty set. The wording says
    // whose problem this is, because on a shared checkout it usually is not the
    // gate's.
    throw new Error(
      `${file} does not currently parse as TypeScript, so no gate can read it`
      + ` — this is a syntax error in the file, not a gate finding.`
      + ` If someone is mid-edit, re-run.\n  ${errors.map((e) => e.message).join('\n  ')}`,
    );
  }

  const open: Building[] = [];
  let root: SyntaxNode | undefined;
  const enter = (raw: Node): void => {
    const parent = open.at(-1);
    const node: Building = { raw, type: raw.type, start: raw.start, end: raw.end, parent, children: [] };
    parent?.children.push(node);
    open.push(node);
  };
  const exit = (): void => {
    const done = open.pop();
    if (open.length === 0 && done !== undefined) root = done;
  };

  /* SAFETY: every `VisitorObject` field is an optional callback taking one member
     of `Node`, so a handler accepting the whole union is assignable to all of
     them; the keys are `visitorKeys`' own, so they are exactly the type names
     `VisitorObject` declares. Naming 165 node types here instead would be the
     schema copy this module exists to avoid. */
  const handlers = Object.fromEntries(
    Object.keys(visitorKeys).flatMap((type) => [[type, enter], [`${type}:exit`, exit]]),
  ) as VisitorObject;
  new Visitor(handlers).visit(program);

  if (root === undefined) throw new Error(`${file}: oxc-parser produced no root node.`);

  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  return {
    root,
    lineAt: (offset) => {
      let low = 0;
      let high = lineStarts.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (lineStarts[mid] <= offset) low = mid; else high = mid - 1;
      }
      return low + 1;
    },
  };
}

/** Preorder over `node` and every descendant. */
export function walk(node: SyntaxNode, visit: (n: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

/**
 * A string-valued literal, decoded rather than shape-tested: `StringLiteral` and
 * `NumericLiteral` are both `type: "Literal"` and differ only in what `value`
 * holds, which is a fact about the parser's output and not about our types.
 */
const StringValued = v.object({ value: v.string() });

const literalString = (raw: Node): string | undefined => {
  if (raw.type !== 'Literal') return undefined;
  const decoded = v.safeParse(StringValued, raw);
  return decoded.success ? decoded.output.value : undefined;
};

/** Identifier text, for the three node types that carry a plain name. */
const identifierName = (raw: Node): string | undefined =>
  raw.type === 'Identifier' || raw.type === 'PrivateIdentifier' || raw.type === 'JSXIdentifier'
    ? raw.name
    : undefined;

/** Reader-visible literal content: strings, numbers, bigints, regexes, template
 *  head/middle/tail chunks and JSX text. A `TemplateElement` is a separate node
 *  from the template it sits in, and omitting it fingerprinted `INSERT` and
 *  `INSERT … ON CONFLICT` identically. */
export function literalText(node: SyntaxNode): string | undefined {
  const { raw } = node;
  if (raw.type === 'TemplateElement') return raw.value.cooked ?? raw.value.raw;
  if (raw.type === 'JSXText') return raw.value;
  if (raw.type !== 'Literal') return undefined;
  return literalString(raw) ?? raw.raw ?? undefined;
}

/** The value of a string literal, including a template with nothing
 *  interpolated — the test for "this argument is a name being passed", which is
 *  narrower than "this is a literal": `42` has text and is not a string. */
function stringValue(node: SyntaxNode): string | undefined {
  const direct = literalString(node.raw);
  if (direct !== undefined) return direct;
  const { raw } = node;
  if (raw.type !== 'TemplateLiteral' || raw.expressions.length > 0) return undefined;
  const [only] = raw.quasis;
  return only === undefined ? undefined : only.value.cooked ?? only.value.raw;
}

/** Identifier text of `node` itself. */
export const identifierText = (node: SyntaxNode): string | undefined => identifierName(node.raw);

/** Declarations naming themselves through a `key` child. */
const KEYED_DECLARATIONS: ReadonlySet<string> = new Set([
  'MethodDefinition', 'TSAbstractMethodDefinition', 'TSMethodSignature',
  'PropertyDefinition', 'TSAbstractPropertyDefinition', 'TSPropertySignature',
  'Property',
]);

/** Declarations naming themselves through an `id` child. */
const IDENTIFIED_DECLARATIONS: ReadonlySet<string> = new Set([
  'FunctionDeclaration', 'TSDeclareFunction', 'FunctionExpression',
  'ClassDeclaration', 'ClassExpression', 'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration', 'TSEnumDeclaration', 'TSModuleDeclaration',
  'VariableDeclarator',
]);

/**
 * The declared name of `node`, or undefined when it has none. A computed key and
 * a string-literal key both count as none: no caller here can act on them.
 */
export function declaredName(node: SyntaxNode): string | undefined {
  const { raw } = node;
  if (KEYED_DECLARATIONS.has(raw.type) && 'key' in raw) {
    return 'computed' in raw && raw.computed ? undefined : identifierName(raw.key);
  }
  if (IDENTIFIED_DECLARATIONS.has(raw.type) && 'id' in raw && raw.id !== null) {
    return identifierName(raw.id);
  }
  return undefined;
}

/** `MethodDefinition.kind`, which is how a constructor is told from a method,
 *  getter or setter. */
export const methodKind = (node: SyntaxNode): string | undefined =>
  node.raw.type === 'MethodDefinition' ? node.raw.kind : undefined;

/** True when an interface member is declared with `?`. On a capability contract
 *  that is the whole signal: a required field cannot differ between two
 *  implementations because `tsc` demands it, so only an optional one can be
 *  present on one backend and silently absent on the other. */
export const isOptionalMember = (node: SyntaxNode): boolean =>
  (node.raw.type === 'TSPropertySignature' || node.raw.type === 'TSMethodSignature')
  && node.raw.optional === true;

/** Shapes with their own `this` and `await` scope: an `await` inside one of these
 *  does not belong to the function that encloses it. */
export const isFunctionLike = (node: SyntaxNode): boolean =>
  node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression'
  || node.type === 'ArrowFunctionExpression' || node.type === 'MethodDefinition';

/** The function a class or object member is implemented by — the inverse of
 *  `functionOwner`. */
export function functionOf(member: SyntaxNode): SyntaxNode | undefined {
  const { raw } = member;
  if (raw.type !== 'MethodDefinition' && raw.type !== 'Property') return undefined;
  return member.children.find((child) => child.raw === raw.value);
}

/** True when this function is declared `async`. On a member, the modifier lives
 *  on the function ESTree hangs off it, not on the member. */
export function isAsync(node: SyntaxNode): boolean {
  const target = functionOf(node) ?? node;
  const { raw } = target;
  return 'async' in raw && raw.async === true;
}

/** The written return type annotation, or undefined when there is none. The
 *  distinction matters: a base accepting `void | Promise<void>` silently widens
 *  an unannotated method the moment `async` appears. */
export function returnTypeOf(node: SyntaxNode): SyntaxNode | undefined {
  const target = functionOf(node) ?? node;
  const { raw } = target;
  if (!('returnType' in raw) || raw.returnType === null || raw.returnType === undefined) return undefined;
  const annotation = target.children.find((child) => child.raw === raw.returnType);
  return annotation?.children[0];
}

/**
 * The member a function is the implementation of. ESTree hangs a method's or an
 * object-literal method's function on the member node, leaving the function
 * itself anonymous, where TypeScript had a single named node for both. Gate
 * output names this node, so the distinction is visible to a reader.
 */
export function functionOwner(fn: SyntaxNode): SyntaxNode {
  const { parent } = fn;
  if (parent === undefined) return fn;
  if (parent.type === 'MethodDefinition' || parent.type === 'TSAbstractMethodDefinition') return parent;
  return parent.raw.type === 'Property' && parent.raw.method ? parent : fn;
}

/**
 * The block a function body actually is. A `TSMethodSignature` and a `declare`
 * overload have no body, and an arrow with an expression body has no block, so
 * all three yield undefined.
 */
export function blockBodyOf(node: SyntaxNode): SyntaxNode | undefined {
  const { raw } = node;
  if (raw.type !== 'FunctionDeclaration' && raw.type !== 'FunctionExpression'
    && raw.type !== 'ArrowFunctionExpression') return undefined;
  const body = raw.body;
  if (body === null || body.type !== 'BlockStatement') return undefined;
  return node.children.find((child) => child.raw === body);
}

/**
 * The property name of a call whose callee is a member access, static
 * (`stub.foo()`) or computed (`handlers['foo']()`). Undefined for a bare
 * identifier callee: that is a call of a free function, and counting it would let
 * a same-named core function stand in as a caller of a method.
 */
export function memberCalleeName(node: SyntaxNode): string | undefined {
  const { raw } = node;
  if (raw.type !== 'CallExpression' || raw.callee.type !== 'MemberExpression') return undefined;
  const { callee } = raw;
  return callee.computed ? literalString(callee.property) : identifierName(callee.property);
}

/** The name of a call's callee when it is a plain identifier. */
export const identifierCalleeName = (node: SyntaxNode): string | undefined =>
  node.raw.type === 'CallExpression' ? identifierName(node.raw.callee) : undefined;

/** String literals passed as arguments of a call — "a name being handed to
 *  something that runs it", as opposed to a name merely mentioned. */
export function stringArguments(node: SyntaxNode): readonly string[] {
  if (node.raw.type !== 'CallExpression') return [];
  const found: string[] = [];
  for (const child of node.children) {
    if (!node.raw.arguments.some((argument) => argument === child.raw)) continue;
    const value = stringValue(child);
    if (value !== undefined) found.push(value);
  }
  return found;
}

/** Names of the decorators applied to `node`, read from decorator syntax rather
 *  than the text `@name`, so a mention in a comment or a string cannot produce
 *  one. `@callable()` and `@callable` both yield `callable`. */
export function decoratorNames(node: SyntaxNode): readonly string[] {
  const { raw } = node;
  if (!('decorators' in raw)) return [];
  const names: string[] = [];
  for (const decorator of raw.decorators ?? []) {
    const { expression } = decorator;
    const name = expression.type === 'CallExpression'
      ? identifierName(expression.callee)
      : identifierName(expression);
    if (name !== undefined) names.push(name);
  }
  return names;
}

/** Class members of a class declaration, in source order. */
export function classMembers(node: SyntaxNode): readonly SyntaxNode[] {
  const { raw } = node;
  if (raw.type !== 'ClassDeclaration' && raw.type !== 'ClassExpression') return [];
  const body = node.children.find((child) => child.raw === raw.body);
  return body?.children ?? [];
}

/** The name in a class's `extends` clause when it is a plain identifier —
 *  `class A extends B<C>` yields `B`. Which base a class extends is how a gate
 *  tells two same-named lifecycle hooks apart without any type information. */
export const superClassName = (node: SyntaxNode): string | undefined =>
  (node.raw.type === 'ClassDeclaration' || node.raw.type === 'ClassExpression')
  && node.raw.superClass !== null && node.raw.superClass !== undefined
    ? identifierName(node.raw.superClass)
    : undefined;

/* ── Module structure ─────────────────────────────────────────────────────
   ESTree wraps an exported declaration instead of flagging it, so "the
   declaration this statement declares" and "is it exported" are one question
   here rather than two. */

/** A top-level statement's declaration and whether ESTree's `export` wrapper was
 *  around it. */
interface Declared {
  readonly node: SyntaxNode;
  readonly exported: boolean;
}

/** The declaration a top-level statement declares, unwrapping the `export`
 *  wrapper ESTree puts around it, plus whether that wrapper was there. */
export function declarationOf(statement: SyntaxNode): Declared {
  const { raw } = statement;
  if (raw.type !== 'ExportNamedDeclaration' && raw.type !== 'ExportDefaultDeclaration') {
    return { node: statement, exported: false };
  }
  const inner = statement.children.find((child) => child.raw === raw.declaration);
  return inner === undefined ? { node: statement, exported: true } : { node: inner, exported: true };
}

/** True when this statement re-exports from another module — `export … from '…'`
 *  declares nothing locally. */
export const isReExport = (statement: SyntaxNode): boolean =>
  (statement.raw.type === 'ExportNamedDeclaration' || statement.raw.type === 'ExportAllDeclaration')
  && statement.raw.source !== null;

/** Local names an `export { … }` clause names. For `export { a as b }` this is
 *  `a`: the name that must have been declared here for the export to be a
 *  declaration rather than a re-export. */
export function exportedLocalNames(statement: SyntaxNode): readonly string[] {
  if (statement.raw.type !== 'ExportNamedDeclaration') return [];
  const names: string[] = [];
  for (const specifier of statement.raw.specifiers) {
    const name = identifierName(specifier.local) ?? literalString(specifier.local);
    if (name !== undefined) names.push(name);
  }
  return names;
}

/** Names an `import` statement binds locally: default, namespace and named. */
export function importedNames(statement: SyntaxNode): readonly string[] {
  if (statement.raw.type !== 'ImportDeclaration') return [];
  return statement.raw.specifiers
    .map((specifier) => identifierName(specifier.local))
    .filter((name): name is string => name !== undefined);
}

/**
 * Binding targets of a destructuring pattern. Only targets: the `c` in
 * `{ c: [d] }` is a property key, not a binding, and the `y` in `{ x = y }` is a
 * default value. Collecting either would report names this file never declared.
 */
function collectBindings(raw: Node, into: string[]): void {
  if (raw.type === 'Identifier') { into.push(raw.name); return; }
  if (raw.type === 'ObjectPattern') {
    for (const property of raw.properties) {
      collectBindings(property.type === 'RestElement' ? property.argument : property.value, into);
    }
    return;
  }
  if (raw.type === 'ArrayPattern') {
    for (const element of raw.elements) if (element !== null) collectBindings(element, into);
    return;
  }
  if (raw.type === 'AssignmentPattern') { collectBindings(raw.left, into); return; }
  if (raw.type === 'RestElement') collectBindings(raw.argument, into);
}

/**
 * Names a variable declaration binds. `identifiersOnly` is the difference
 * between the two questions the dead-code gate asks: everything this statement
 * declares, versus the names a later `export { … }` clause could name, which is
 * only the plain `const a = …` form.
 */
export function declaredBindings(declaration: SyntaxNode, identifiersOnly: boolean): readonly string[] {
  const { raw } = declaration;
  if (raw.type !== 'VariableDeclaration') return [];
  const names: string[] = [];
  for (const declarator of raw.declarations) {
    if (identifiersOnly) {
      if (declarator.id.type === 'Identifier') names.push(declarator.id.name);
      continue;
    }
    collectBindings(declarator.id, names);
  }
  return names;
}

/**
 * Every module this file names: `import … from`, `export … from`, bare
 * `import '…'`, and `import(…)` with a literal argument. The dynamic form is
 * included because a lazily-imported platform module is still a dependency on
 * that platform — leaving it out would report a file as runtime-agnostic on the
 * strength of where its import was written.
 */
export function moduleSpecifiers(tree: SyntaxNode): readonly string[] {
  const out: string[] = [];
  walk(tree, (node) => {
    const { raw } = node;
    if (raw.type === 'ImportDeclaration' || raw.type === 'ExportNamedDeclaration'
      || raw.type === 'ExportAllDeclaration') {
      const source = raw.source === null || raw.source === undefined
        ? undefined
        : literalString(raw.source);
      if (source !== undefined) out.push(source);
      return;
    }
    if (raw.type !== 'ImportExpression') return;
    const source = literalString(raw.source);
    if (source !== undefined) out.push(source);
  });
  return out;
}

/**
 * The number an expression evaluates to, when it evaluates to one without
 * running anything: a literal, a sign, or arithmetic over those. This is what
 * makes `5 * 60 * 1000` and `300_000` the same policy rather than two — a
 * comparison over source text sees two unrelated constants, and the tree
 * currently writes five minutes in both notations.
 *
 * Deliberately narrow. No identifiers: resolving `BASE * 3` needs a binding
 * table, and a gate that resolves some names and not others reports a
 * difference where the difference is its own reach. `NaN` and the infinities
 * are dropped for the same reason a gate never compares them: they are not
 * policy numbers.
 */
export function numericValue(node: SyntaxNode): number | undefined {
  const { raw } = node;
  if (raw.type === 'Literal') {
    const decoded = v.safeParse(NumberValued, raw);
    return decoded.success && Number.isFinite(decoded.output.value)
      ? decoded.output.value
      : undefined;
  }
  if (raw.type === 'TSAsExpression' || raw.type === 'TSSatisfiesExpression'
    || raw.type === 'TSNonNullExpression') {
    return numericValue(node.children[0]);
  }
  if (raw.type === 'UnaryExpression' && (raw.operator === '-' || raw.operator === '+')) {
    const inner = numericValue(node.children[0]);
    return inner === undefined ? undefined : (raw.operator === '-' ? -inner : inner);
  }
  if (raw.type !== 'BinaryExpression') return undefined;
  const left = numericValue(node.children[0]);
  const right = numericValue(node.children[1]);
  if (left === undefined || right === undefined) return undefined;
  switch (raw.operator) {
    case '*': return finite(left * right);
    case '/': return finite(left / right);
    case '+': return finite(left + right);
    case '-': return finite(left - right);
    case '**': return finite(left ** right);
    default: return undefined;
  }
}

const finite = (value: number): number | undefined =>
  Number.isFinite(value) ? value : undefined;

const NumberValued = v.object({ value: v.number() });
