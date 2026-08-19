#!/usr/bin/env bun
/**
 * The silent-drop census — seven defect classes that destroy a failure while every
 * no-swallow rule stays green.
 *
 * WHY A SECOND CHECK BESIDE FOUR WORKING LINT RULES. `no-empty-catch`,
 * `no-sentinel-catch`, `require-cause-on-rethrow` and `no-ddl-in-catch` are all
 * errors and all proven red-to-green through the real `oxlint` binary over every
 * `catch` occurrence in the product sources (`no-swallow.gate.test.ts` reports the
 * corpus it measured; this header does not restate it, because a copied count has
 * nothing that re-runs it and this one drifted). They are not
 * weak. They are NARROW, and each one's edge is a defect a reader would call the
 * same thing:
 *
 *   - `no-sentinel-catch` fires only on a handler body of exactly ONE statement.
 *     Add a `log.warn(...)` above the `return null` and the rule is silent BY
 *     CONSTRUCTION — its own docstring says a body that logs "is not blind". True
 *     of the reader; false of the CALLER, who still cannot tell the empty answer
 *     from the failed one.
 *   - `require-cause-on-rethrow` fires only on a `ThrowStatement` whose argument
 *     is `new *Error(...)` AND which has a `CatchClause` ancestor. A
 *     `.catch((error) => { throw new Error('x') })` has no `CatchClause` ancestor,
 *     so identical chain destruction inside a promise handler is invisible.
 *   - Nothing in the rule set reads a promise. A rejection reaches nobody in
 *     three spellings — `void p`, a bare call statement, and an inline handler
 *     that absorbs — and an unhandled rejection on workerd is not an error the
 *     caller sees, it is a line in a log stream with no request tied to it.
 *   - Nothing reads what a failure log CARRIES. `log.warn('failed: ' +
 *     error.message)` satisfies every rule and is how a missing SQLite table gets
 *     reported as a missing fork: `renderCauseChain` exists precisely because the
 *     outermost message is the least informative frame.
 *
 * So this is not a fifth no-swallow rule; it is the census of what the four
 * cannot see, kept as a ratchet, because the population is non-zero today and a
 * gate demanding zero would be switched off within the hour.
 *
 * WHY A SCRIPT AND NOT AN OXLINT RULE. Every class here needs knowledge wider
 * than one node. `floating_rejection` resolves a callee against the `async`
 * declarations of the same file and then asks whether that function can reject at
 * all; `message_only` needs every use of a binding across a whole handler before
 * it can say the chain was in hand and dropped. A `createOnce` visitor is reused
 * across files, so any cross-node state it kept would make a verdict depend on
 * which sibling file was linted first — the hazard
 * `require-cause-on-rethrow`'s own header calls out.
 *
 * WHAT IT DELIBERATELY CANNOT SEE, so the count reads as a floor and not a total:
 *   - A rejection handler passed BY NAME (`.catch(this.onFailure)`). Resolving it
 *     is a call graph; a wrong verdict on a named handler is worse than a stated
 *     gap. Counted as handled — the rejection does reach something.
 *   - A promise stored, returned, or collected into an array and never awaited.
 *     That is a type-level fact. `tsc` has it; oxlint's type-aware pass is not
 *     enabled in this repo, so `typescript/no-floating-promises` cannot run.
 *   - A wrapper FACTORY that drops `cause` (`throw makeVfsError(msg)`). Whether it
 *     chains is inside the factory, so a caller-side verdict would be a guess.
 *     `parent.ts`'s `makeVfsError` does chain.
 *   - Anything outside `readSources()`. Test code is out for the same reason
 *     `no-swallow`'s denominator excludes it: a swallow in a fixture is a fixture.
 *
 *   bun scripts/silent-drop.ts            # census, ratcheted
 *   bun scripts/silent-drop.ts --lock     # record the current population
 *   bun scripts/silent-drop.ts --table    # per-class counts, no ratchet
 */

import { join } from 'node:path';
import * as v from 'valibot';

import {
  assertMeasured, finding, reconcile, report, writeLock, type Finding,
} from './gate-ratchet';
import { readSources } from './sources';
import {
  blockBodyOf, declaredName, identifierCalleeName, identifierText, isAsync, memberCalleeName,
  parse, walk, type SyntaxNode,
} from './syntax';

const REPO = new URL('..', import.meta.url).pathname;
const LOCK = join(REPO, 'scripts/silent-drop.lock.json');

/** Declared as an ordered tuple rather than derived from the table's keys: the
 *  table is then `satisfies Record<DropClass, …>` and total, so a new class
 *  cannot be added without a description, and the reporting order is not
 *  whatever `Object.keys` happens to give. */
export const DROP_CLASSES = [
  'logged_default', 'message_only', 'projecting_helper', 'handler_absorbs',
  'handler_drops_cause', 'voided_promise', 'floating_rejection',
] as const;

export type DropClass = (typeof DROP_CLASSES)[number];

/**
 * Each class with the rule whose edge it sits past. `blindTo` is not decoration —
 * it is the claim this gate makes about why it exists, and a class whose named
 * rule DOES catch it would be a duplicate check.
 */
export const DROPS = {
  logged_default: {
    blindTo: 'no-sentinel-catch — fires on a one-statement handler only',
    invariant: 'a handler that yields a sentinel must first say which failure it tolerated',
    silently: 'the caller reads the same empty value for "absent" and "the read blew up"',
    fix: 'classify first — `if (!isExpected({ cause: error })) throw error;` — or return a '
      + 'refusal, `{ reason, error }` via `refusalOf`',
  },
  message_only: {
    blindTo: 'nothing — no rule reads what a failure log carries',
    invariant: 'a reported failure must carry its cause chain, not its outermost message',
    silently: 'a missing SQLite table reported as a missing fork: the frame naming the real '
      + 'fault is one `cause` deeper than the one printed',
    fix: 'pass the error itself — `renderThrownChain({ cause: error })`, or `log.failure(name, '
      + 'toProteusError({ doing, cause: error, otherwise }))`, which renders the chain for you',
  },
  projecting_helper: {
    blindTo: 'gate:duplication — one expression is below its node threshold, so 26 copies of '
      + 'this exact function did not register as duplication either',
    invariant: 'a function whose whole job is to render a failure must render its chain',
    silently: 'every caller of it drops the chain, and the defect is one call away from the '
      + '`catch` a reader inspects — which is why 26 of these were invisible',
    fix: 'delete it and call `renderThrownChain({ cause })`, or delegate to it and keep only '
      + 'the part that is genuinely local',
  },
  handler_absorbs: {
    blindTo: 'no-sentinel-catch — a handler body that is not a bare sentinel return',
    invariant: 'a rejection handler must rethrow, forward the error, or record a classified failure',
    silently: 'the promise resolves, so the caller proceeds as though the work succeeded',
    fix: 'rethrow, hand the error on, or record it through `Logger.failure`, which requires a class',
  },
  handler_drops_cause: {
    blindTo: 'require-cause-on-rethrow — requires a CatchClause ancestor',
    invariant: 'an error thrown from a rejection handler must chain the rejection',
    silently: 'the stack, the SQLite code and the HTTP status underneath are destroyed while the '
      + 'message survives, so nothing downstream can classify it',
    fix: '`new Error(message, { cause: error })`',
  },
  voided_promise: {
    blindTo: 'nothing — no rule reads a promise',
    invariant: '`void`-ing a promise must not discard a rejection it can produce',
    silently: 'an unhandled rejection with no request context, and the work reported as done',
    fix: 'attach a recording rejection handler, or await it, or hand it to the job runner that '
      + 'owns unawaited work',
  },
  floating_rejection: {
    blindTo: 'nothing — no rule reads a promise',
    invariant: 'a bare call to an async function that can reject must be awaited or handled',
    silently: 'the same unhandled rejection, plus the next statement running before the work it '
      + 'followed has finished',
    fix: 'await it, or hand it to the job runner that owns unawaited work',
  },
} satisfies Readonly<Record<DropClass, Omit<Finding, 'at' | 'found'> & { blindTo: string }>>;

/**
 * Where a dropped chain ENDS UP. Only meaningful for `message_only`, and it is
 * the difference between "fix this now" and "a bounded human-facing string": a
 * `log` sink is what a reader greps at 3am, a `wire` payload is what another
 * component classifies from, and a `display` string is read by someone who can
 * ask for more. Recorded rather than filtered, because a census that silently
 * dropped the third bucket would measure one set and report another.
 */
export const SINKS = ['log', 'wire', 'display', 'other'] as const;
export type Sink = (typeof SINKS)[number];

export interface Drop {
  readonly kind: DropClass;
  readonly sink: Sink;
  readonly file: string;
  readonly line: number;
  /** Enclosing named declaration, so a ratchet key survives edits above it. */
  readonly symbol: string;
  /** One bounded line of the source — what makes a finding readable. */
  readonly text: string;
}

/** Calls that write to an observability sink. Member name OR receiver, because
 *  `log.warn(...)`, `console.error(...)` and `diagnostics.failure(...)` are one
 *  population and only the receiver distinguishes the middle one. */
const LOG_METHODS: ReadonlySet<string> = new Set([
  'log', 'warn', 'error', 'info', 'debug', 'trace', 'event', 'failure',
]);
const LOG_RECEIVERS: ReadonlySet<string> = new Set([
  'console', 'diagnostics', 'logger', 'log', 'journal',
]);

/** A literal's value, decoded rather than asserted: `Literal` covers strings,
 *  numbers, booleans and `null`, and which one it is lives in `value`. */
const LiteralValue = v.object({
  value: v.union([v.null(), v.boolean(), v.number(), v.string()]),
});

/** Values a failing operation hands back that a succeeding one can hand back
 *  too — the same population `no-sentinel-catch` tests for, read off oxc's AST
 *  here rather than off `ESTree` there. */
function isSentinel(node: SyntaxNode | undefined): boolean {
  if (node === undefined) return true;
  if (node.type === 'ArrayExpression' || node.type === 'ObjectExpression') {
    return node.children.length === 0;
  }
  if (node.type === 'Identifier') return identifierText(node) === 'undefined';
  if (node.type === 'UnaryExpression') {
    return node.raw.type === 'UnaryExpression' && node.raw.operator === '-'
      && isSentinel(node.children[0]);
  }
  const literal = v.safeParse(LiteralValue, node.raw);
  if (!literal.success) return false;
  const { value } = literal.output;
  return value === null || value === false || value === 0 || value === '';
}

/** Descendants of `scope` that belong to it rather than to a function nested
 *  inside — whose `throw` says nothing about this scope's own path. */
function ownNodes(scope: SyntaxNode): readonly SyntaxNode[] {
  const own: SyntaxNode[] = [];
  const descend = (node: SyntaxNode): void => {
    for (const child of node.children) {
      if (child.type === 'FunctionDeclaration' || child.type === 'FunctionExpression'
        || child.type === 'ArrowFunctionExpression') continue;
      own.push(child);
      descend(child);
    }
  };
  descend(scope);
  return own;
}

/**
 * What became of a caught error inside its handler. Three fates, and only the
 * first preserves the chain:
 *
 *   FORWARDED — handed WHOLE to something: a call or constructor argument, an
 *     object property value, thrown, returned, assigned. The receiver then owns
 *     the decision, so this handler dropped nothing.
 *   PROJECTED — `.message`, `.stack`, `String(error)`, `` `${error}` ``,
 *     `error.toString()`. Each yields the outermost frame and discards every
 *     `cause` beneath it.
 *   INSPECTED — `error instanceof X`, `error.code`, a comparison. Neither
 *     preserves nor destroys; it is how a handler decides what it is looking at,
 *     and counting it as forwarding is what made an earlier draft of this gate
 *     report zero over a tree holding 157 instances.
 */
interface Fate {
  readonly forwarded: boolean;
  /** Projection sites, so a finding can point at the expression that dropped it. */
  readonly projections: readonly SyntaxNode[];
}

const PROJECTED_PROPERTIES: ReadonlySet<string> = new Set(['message', 'stack', 'toString']);
const PROJECTING_CALLS: ReadonlySet<string> = new Set(['String']);
/** A bare use of the binding in one of these positions is the VALUE flowing on
 *  whole. `ConditionalExpression` and `LogicalExpression` are here because
 *  `error instanceof Error ? error : String(error)` forwards the error on the arm
 *  that has one and stringifies only what is not an error — the correct shape, and
 *  an earlier draft counted it as a drop. */
const FORWARDING_PARENTS: ReadonlySet<string> = new Set([
  'Property', 'SpreadElement', 'ThrowStatement', 'ReturnStatement',
  'AssignmentExpression', 'VariableDeclarator', 'ConditionalExpression',
  'LogicalExpression', 'ArrayExpression',
]);

function fateOf(scope: SyntaxNode, binding: string): Fate {
  let forwarded = false;
  const projections: SyntaxNode[] = [];
  walk(scope, (node) => {
    if (node.type !== 'Identifier' || identifierText(node) !== binding) return;
    const parent = node.parent;
    if (parent === undefined) return;
    if (parent.type === 'MemberExpression' && parent.children[0] === node) {
      const property = identifierText(parent.children[1] ?? parent);
      if (property !== undefined && PROJECTED_PROPERTIES.has(property)) projections.push(parent);
      return;
    }
    if (parent.type === 'TemplateLiteral') { projections.push(parent); return; }
    if (parent.type === 'NewExpression' || parent.type === 'CallExpression') {
      if (parent.children[0] === node) return;
      const callee = identifierCalleeName(parent);
      if (callee !== undefined && PROJECTING_CALLS.has(callee)) projections.push(parent);
      else forwarded = true;
      return;
    }
    if (FORWARDING_PARENTS.has(parent.type)) forwarded = true;
  });
  return { forwarded, projections };
}

/**
 * The nearest enclosing consumer of a projection, and what that consumer feeds.
 * `other` is the honest answer for a consumer nobody enumerated — a helper
 * function's own return value, most often — rather than a default that would
 * inflate one of the three named buckets.
 */
function sinkOf(projection: SyntaxNode): Sink {
  for (let at: SyntaxNode | undefined = projection.parent; at !== undefined; at = at.parent) {
    if (at.type === 'CallExpression') {
      const method = memberCalleeName(at);
      if (method !== undefined && LOG_METHODS.has(method)) return 'log';
      const callee = at.children[0];
      const receiver = callee?.type === 'MemberExpression'
        ? identifierText(callee.children[0] ?? callee)
        : undefined;
      if (receiver !== undefined && LOG_RECEIVERS.has(receiver)) return 'log';
      const plain = identifierCalleeName(at);
      return plain !== undefined && plain.startsWith('set') ? 'display' : 'wire';
    }
    if (at.type === 'NewExpression' || at.type === 'ThrowStatement'
      || at.type === 'ReturnStatement') return 'wire';
    if (at.type === 'JSXExpressionContainer') return 'display';
  }
  return 'other';
}

/** `new *Error(...)` with no `cause` — the same callee and `{ cause }` tests
 *  `require-cause-on-rethrow` applies, so the two checks cannot disagree about
 *  what chaining means. */
function chainlessErrorConstruction(node: SyntaxNode): boolean {
  if (node.type !== 'NewExpression') return false;
  const callee = node.children[0];
  if (callee === undefined) return false;
  const name = identifierText(callee)
    ?? (callee.type === 'MemberExpression' ? identifierText(callee.children[1] ?? callee) : undefined);
  if (name === undefined || !name.endsWith('Error')) return false;
  return !node.children.slice(1).some((argument) => argument.type === 'ObjectExpression'
    && argument.children.some((property) => property.type === 'Property'
      && identifierText(property.children[0] ?? property) === 'cause'));
}

/** Rejection-handler positions on a promise call: `.catch(fn)` and the SECOND
 *  argument of `.then(ok, fn)`. Both, because they are one defect and covering
 *  one makes the other the cheap way around it. */
function rejectionHandlerOf(call: SyntaxNode): SyntaxNode | undefined {
  const method = memberCalleeName(call);
  const args = call.children.slice(1);
  const handler = method === 'catch'
    ? args[0]
    : method === 'then' && args.length >= 2 ? args[1] : undefined;
  if (handler === undefined) return undefined;
  return handler.type === 'ArrowFunctionExpression' || handler.type === 'FunctionExpression'
    ? handler
    : undefined;
}

/** Whether any call in this chain hands the rejection to ANYTHING, inline or by
 *  name. Named handlers count here: the question is whether the rejection is
 *  reachable at all, not whether the thing reached records it. */
function chainHandlesRejection(expression: SyntaxNode): boolean {
  let handled = false;
  walk(expression, (node) => {
    if (node.type !== 'CallExpression') return;
    const method = memberCalleeName(node);
    if (method === 'catch' && node.children.length > 1) handled = true;
    if (method === 'then' && node.children.length > 2) handled = true;
  });
  return handled;
}

/**
 * What this file's own `async` definitions do with a rejection.
 *
 * `contained` is what keeps two of the six classes honest. `async function load()
 * { try { … } catch (e) { setError(e) } }` cannot reject, so `void load()`
 * discards nothing — and that pattern accounts for 20 of this tree's 77 `void`
 * statements. Reporting them would bury the ones that do discard a rejection
 * under a list nobody reads.
 *
 * The asymmetry is deliberate. A name DEFINED here is judged, and only ever
 * judged into silence. A name that resolves to nothing here — an import, an
 * ambient `declare`, a parameter, a method on a foreign object — is unresolvable
 * without a call graph, and an unresolvable promise is reported: `void` on it is
 * the canonical fire-and-forget, and treating "I could not look" as "it is fine"
 * is the defect this whole gate is about.
 */
interface AsyncDefinitions {
  /** Defined here and `async` — the only names a BARE call statement can be
   *  judged a floating promise by, since a bare sync call is just a call. */
  readonly asynchronous: ReadonlySet<string>;
  /** Defined here and provably unable to reject. */
  readonly contained: ReadonlySet<string>;
}

function asyncDefinitions(root: SyntaxNode): AsyncDefinitions {
  const asynchronous = new Set<string>();
  const contained = new Set<string>();
  const consider = (name: string | undefined, fn: SyntaxNode): void => {
    if (name === undefined || !isAsync(fn)) return;
    asynchronous.add(name);
    const body = blockBodyOf(fn);
    if (body === undefined) return;
    // Containment is about the AWAITS, not about the shape of the body. The React
    // spelling is `setLoading(true); setErr(null); try { await … } catch { setErr(…) }
    // finally { setLoading(false) }` — three statements, no rejection reachable, and
    // an earlier draft that demanded the whole body BE the try reported every one of
    // them. So: some try whose catch does not rethrow, and no `await` outside it.
    //
    // What this deliberately does not model: a SYNCHRONOUS throw before the try,
    // which would reject the promise. Nothing in this tree does that, and modelling
    // it would mean deciding which sync calls can throw.
    const own = ownNodes(body);
    const guarded = own.filter((node) => {
      if (node.type !== 'TryStatement') return false;
      const handler = node.children.find((child) => child.type === 'CatchClause');
      const handlerBody = handler?.children.at(-1);
      return handlerBody !== undefined
        && !ownNodes(handlerBody).some((inner) => inner.type === 'ThrowStatement');
    });
    if (guarded.length === 0) return;
    const unguarded = own.some((node) => node.type === 'AwaitExpression'
      && !guarded.some((tried) => tried.start <= node.start && node.end <= tried.end));
    if (!unguarded) contained.add(name);
  };
  walk(root, (node) => {
    if (node.type === 'FunctionDeclaration' || node.type === 'MethodDefinition') {
      consider(declaredName(node), node);
      return;
    }
    if (node.type !== 'VariableDeclarator') return;
    const initialiser = node.children[1];
    if (initialiser === undefined) return;
    const name = identifierText(node.children[0] ?? node);
    if (initialiser.type === 'ArrowFunctionExpression' || initialiser.type === 'FunctionExpression') {
      consider(name, initialiser);
      return;
    }
    // `const load = useCallback(async () => { … }, [])` — the React spelling, and
    // what every `void load()` in this repo's UI actually resolves to.
    if (initialiser.type !== 'CallExpression') return;
    const wrapped = initialiser.children.slice(1).find(
      (argument) => argument.type === 'ArrowFunctionExpression'
        || argument.type === 'FunctionExpression',
    );
    if (wrapped !== undefined) consider(name, wrapped);
  });
  return { asynchronous, contained };
}

/** The name a call resolves to inside this file — plainly (`load()`) or through
 *  `this` (`this.load()`). A call on any other object is not resolvable against
 *  this file's declarations. */
function localCalleeName(call: SyntaxNode): string | undefined {
  const plain = identifierCalleeName(call);
  if (plain !== undefined) return plain;
  const callee = call.children[0];
  if (callee?.type !== 'MemberExpression') return undefined;
  return callee.children[0]?.type === 'ThisExpression'
    ? identifierText(callee.children[1] ?? callee)
    : undefined;
}

/**
 * Every class in one file. Pure over `(file, text)` so the self-test drives each
 * branch from a fixture rather than from whatever the tree happens to hold.
 */
export function auditFile(file: string, text: string): readonly Drop[] {
  const { root, lineAt } = parse(file, text);
  const defined = asyncDefinitions(root);
  const found: Drop[] = [];
  const record = (kind: DropClass, node: SyntaxNode, sink: Sink): void => {
    let symbol = '<module>';
    for (let scope: SyntaxNode | undefined = node; scope !== undefined; scope = scope.parent) {
      const name = declaredName(scope);
      if (name !== undefined) { symbol = name; break; }
    }
    found.push({
      kind,
      sink,
      file,
      line: lineAt(node.start),
      symbol,
      text: text.slice(node.start, node.end).split('\n')[0]?.trim().slice(0, 110) ?? '',
    });
  };

  /** A caught error's fate, for both spellings of a handler — a `catch` clause
   *  and an inline rejection handler. One function because it is one defect.
   *  Answers whether the error was forwarded, which the caller needs to decide
   *  whether the handler also ABSORBED it. */
  const auditHandler = (scope: SyntaxNode, binding: string | undefined): boolean => {
    if (binding === undefined) return false;
    const { forwarded, projections } = fateOf(scope, binding);
    if (forwarded || projections.length === 0) return forwarded;
    // The outermost projection, once per handler: three `error.message` reads
    // feeding one log line are one dropped chain, not three.
    const site = projections[0] ?? scope;
    record('message_only', site, sinkOf(site));
    return false;
  };

  /**
   * A function whose ENTIRE body renders one of its own parameters down to that
   * parameter's outermost message. The `catch` that calls it is clean by every
   * rule in the set — it hands the error on WHOLE — and the chain dies one frame
   * later, inside a two-line helper nobody re-reads. Twenty-six of these existed
   * at 2b7b020f under eight names.
   *
   * Two tests, and both are needed. A SINGLE-RETURN body: anything longer is doing
   * work, and a function that reads `.message` in the middle of real logic is a
   * judgement its author made rather than an adapter standing between a caller and
   * the truth. And a `.message`/`.stack` READ specifically, not `fateOf`'s wider
   * projection set: `String(x)` and `` `${x}` `` are how every value in the
   * language reaches a string, so admitting them made this class report 173 sites
   * of which 147 were `(byte) => byte.toString(16)` and its relatives. Only
   * `.message` and `.stack` are unambiguously an error being flattened.
   */
  const auditAdapter = (fn: SyntaxNode): void => {
    const block = blockBodyOf(fn);
    const returned = block === undefined
      ? fn.children.at(-1)
      : block.children.length === 1 && block.children[0]?.type === 'ReturnStatement'
        ? block.children[0]
        : undefined;
    if (returned === undefined || returned.type === 'BlockStatement') return;
    // Parameters only: `children` also holds the body and any type annotation, and
    // the body is what we are about to search.
    const parameters = fn.children.filter(
      (child) => child !== block && child !== returned
        && (child.type === 'Identifier' || child.type === 'ObjectPattern'),
    );
    const bound: string[] = [];
    for (const parameter of parameters) {
      walk(parameter, (node) => {
        const name = node.type === 'Identifier' ? identifierText(node) : undefined;
        if (name !== undefined) bound.push(name);
      });
    }
    // The value must be EVIDENTLY an error. A `.message` field belongs to a
    // valibot `Issue`, a chat event and a timeline row as much as to an `Error`,
    // and 11 of the first 15 findings here were `(issue) => issue.message` over
    // `safeParse().issues` — reading a typed field of a non-error, which is not a
    // dropped chain and cannot be one. So the function has to say so itself:
    // either it narrows with `instanceof Error`, or its parameter arrives
    // unnarrowed (`unknown`, or a bare type parameter), which is exactly how all
    // 26 of the real ones were written.
    const source = text.slice(fn.start, fn.end);
    const handlesAnError = /instanceof Error|:\s*unknown|<\w+>\s*\(/u.test(source);
    if (!handlesAnError) return;
    for (const name of bound) {
      let flattens = false;
      walk(returned, (node) => {
        if (node.type !== 'MemberExpression' || node.children[0]?.type !== 'Identifier') return;
        if (identifierText(node.children[0]) !== name) return;
        const property = identifierText(node.children[1] ?? node);
        if (property === 'message' || property === 'stack') flattens = true;
      });
      if (flattens && !fateOf(returned, name).forwarded) {
        record('projecting_helper', fn, 'wire');
        return;
      }
    }
  };

  walk(root, (node) => {
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression'
      || node.type === 'ArrowFunctionExpression' || node.type === 'MethodDefinition') {
      auditAdapter(node.type === 'MethodDefinition' ? node.children.at(-1) ?? node : node);
    }

    if (node.type === 'CatchClause') {
      const body = node.children.at(-1);
      if (body === undefined || body.type !== 'BlockStatement') return;
      const own = ownNodes(body);
      const rethrows = own.some((statement) => statement.type === 'ThrowStatement');

      if (body.children.length > 1 && !rethrows) {
        const sentinel = own.find(
          (statement) => statement.type === 'ReturnStatement' && isSentinel(statement.children[0]),
        );
        if (sentinel !== undefined) record('logged_default', sentinel, 'wire');
      }
      const bound = node.children.length > 1 ? identifierText(node.children[0] ?? node) : undefined;
      auditHandler(body, bound);
      return;
    }

    if (node.type === 'CallExpression') {
      const handler = rejectionHandlerOf(node);
      if (handler !== undefined) {
        const block = blockBodyOf(handler);
        const scope = block ?? handler.children.at(-1);
        const parameter = handler.children.length > 1
          ? identifierText(handler.children[0] ?? handler)
          : undefined;
        const own = block === undefined ? [] : ownNodes(block);
        const rethrows = own.some((statement) => statement.type === 'ThrowStatement');
        const forwarded = scope === undefined ? false : auditHandler(scope, parameter);

        // A body that is empty, or a bare sentinel return, is `no-sentinel-catch`'s.
        // What is left — a handler that runs statements, forwards nothing and
        // rethrows nothing — is this gate's.
        if (block !== undefined && block.children.length > 0 && !rethrows && !forwarded) {
          const bare = block.children.length === 1
            && block.children[0]?.type === 'ReturnStatement';
          if (!bare) record('handler_absorbs', handler, 'wire');
        }
        for (const statement of own) {
          if (statement.type !== 'ThrowStatement') continue;
          const thrown = statement.children[0];
          if (thrown !== undefined && chainlessErrorConstruction(thrown)) {
            record('handler_drops_cause', statement, 'wire');
          }
        }
        return;
      }
    }

    if (node.type !== 'ExpressionStatement') return;
    const expression = node.children[0];
    if (expression === undefined) return;

    if (expression.type === 'UnaryExpression' && expression.raw.type === 'UnaryExpression'
      && expression.raw.operator === 'void') {
      const operand = expression.children[0];
      if (operand === undefined || operand.type !== 'CallExpression') return;
      if (chainHandlesRejection(operand)) return;
      // Judged only into silence: a name this file defines and proves cannot
      // reject is dropped, everything else — including a name that resolves
      // nowhere here — is reported.
      const callee = localCalleeName(operand);
      if (callee === undefined || !defined.contained.has(callee)) {
        record('voided_promise', node, 'wire');
      }
      return;
    }

    if (expression.type !== 'CallExpression') return;
    const callee = localCalleeName(expression);
    if (callee !== undefined && defined.asynchronous.has(callee)
      && !defined.contained.has(callee) && !chainHandlesRejection(expression)) {
      record('floating_rejection', node, 'wire');
    }
  });

  return found;
}

/** The whole corpus. `readSources()` and no glob of its own: the population this
 *  governs must be the population `no-swallow` measures, or the two numbers
 *  describe different repositories. */
export function auditCorpus(sources: ReadonlyMap<string, string>): readonly Drop[] {
  const drops: Drop[] = [];
  for (const [file, text] of sources) drops.push(...auditFile(file, text));
  return drops;
}

/** One ratchet key per site, symbol-anchored so an edit above it does not churn
 *  the lock, and sink-tagged so a chain dropped into a log line cannot be quietly
 *  downgraded to a display string without the lock noticing. */
export const keyOf = (drop: Drop): string =>
  `${drop.kind}/${drop.sink} ${drop.file}#${drop.symbol}`;

/** `class` and `class/sink` counts in one map, because the audit table wants both
 *  and computing them twice is how two numbers that must agree stop agreeing. */
export function census(drops: readonly Drop[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const kind of DROP_CLASSES) counts.set(kind, 0);
  for (const drop of drops) {
    counts.set(drop.kind, (counts.get(drop.kind) ?? 0) + 1);
    counts.set(`${drop.kind}/${drop.sink}`, (counts.get(`${drop.kind}/${drop.sink}`) ?? 0) + 1);
  }
  return counts;
}

function detailOf(drops: readonly Drop[]): ReadonlyMap<string, string> {
  const sites = new Map<string, Drop[]>();
  for (const drop of drops) {
    const existing = sites.get(keyOf(drop));
    if (existing === undefined) sites.set(keyOf(drop), [drop]);
    else existing.push(drop);
  }
  const detail = new Map<string, string>();
  for (const [key, group] of sites) {
    const first = group[0];
    if (first === undefined) continue;
    const described = DROPS[first.kind];
    detail.set(key, finding({
      at: group.map((drop) => `${drop.file}:${String(drop.line)}`).join(', '),
      invariant: described.invariant,
      found: `${first.text}   [past ${described.blindTo}]`,
      silently: described.silently,
      fix: described.fix,
    }));
  }
  return detail;
}

async function main(): Promise<number> {
  const sources = readSources();
  const drops = auditCorpus(sources);

  // Upstream of every write and every verdict: a census over an empty corpus
  // reports a clean tree and locks nothing.
  const measured = assertMeasured('silent-drop', [
    ['product sources', sources.size],
    ['catch occurrences', [...sources.values()]
      .reduce((total, text) => total + (text.match(/\bcatch\b/gu)?.length ?? 0), 0)],
    ['classes searched', DROP_CLASSES.length],
  ]);
  const keys = drops.map(keyOf);

  if (process.argv.includes('--table')) {
    const counts = census(drops);
    console.log(`silent-drop: ${measured}`);
    for (const kind of DROP_CLASSES) {
      console.log(`  ${String(counts.get(kind) ?? 0).padStart(4)}  ${kind}`
        + `  [past ${DROPS[kind].blindTo}]`);
      for (const sink of SINKS) {
        const count = counts.get(`${kind}/${sink}`) ?? 0;
        if (count > 0) console.log(`        ${String(count).padStart(4)}  -> ${sink}`);
      }
    }
    console.log(`  ${String(drops.length).padStart(4)}  instances over ${new Set(keys).size} sites`);
    return 0;
  }

  if (process.argv.includes('--lock')) {
    console.log(`silent-drop: locked ${writeLock(keys, LOCK)} site(s) — ${measured}`);
    return 0;
  }
  return report('silent-drop', reconcile(keys, LOCK), detailOf(drops),
    'bun scripts/silent-drop.ts --lock', measured);
}

if (import.meta.main) process.exit(await main());
