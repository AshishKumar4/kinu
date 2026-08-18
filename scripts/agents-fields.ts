/**
 * The `agents` action/field gate: every field an action's HANDLER reads must be
 * declared, and every declared field must be read.
 *
 * WHY IT EXISTS. `agents` is the one delegation surface, and its input was a
 * single flat `v.object`. Valibot's `object` EXCLUDES an unknown entry rather
 * than rejecting it, so a field the schema did not declare arrived at the
 * dispatcher ABSENT — indistinguishable from a caller who never sent it.
 * Measured against the shipped parser on 2026-08-18:
 *
 *   parseAgentsToolInput({ action:'fork', task:'x', budgetUsd:5, wallClockMs:1000 })
 *     -> { action:'fork', task:'x' }
 *
 * Both caps gone, silently. The structural half of that defect is what this
 * gate closes: an action can join `AGENTS_TOOL_ACTIONS` while its fields never
 * join the schema, and the only symptom is that everything the caller asked for
 * reads as unasked-for. On the surface where a dropped field is a dropped SPEND
 * CAP, that is the difference between a $5 ceiling and no ceiling.
 *
 * ## WHAT IT COMPARES, AND WHY IT IS NOT A TAUTOLOGY
 *
 * Reading the picklist and the schema out of one file and checking they agree
 * would prove nothing: the same information would sit on both sides. So the two
 * sides are the DECLARATION and the CODE.
 *
 *   declared — `AGENTS_TOOL_ACTIONS` (tools/registry.ts), plus
 *              `AGENTS_ACTION_FIELDS` and the `AgentsInputEntries` the parse
 *              schemas are built from (tools/agents-tool.ts).
 *   read     — the `input.<field>` member reads `dispatchAgentsAction` actually
 *              performs, per `case` arm, followed transitively through every
 *              call that hands the WHOLE input to another function: `runFork`,
 *              `forkSettleRefusal`, `forkMissionScope`, `requestedTopic`, and
 *              across the module boundary into `readMissionLimits`, which is
 *              where `budget_usd` and `budget_tokens` are genuinely read.
 *
 * A handler that reads a field nothing declares is the shipped defect. A
 * declaration nothing reads is the same silence from the other side: a field
 * accepted on an action whose handler cannot act on it (`budget_usd` on `hire`
 * parsed cleanly and was ignored). Both are findings here.
 *
 * ## HONESTY ABOUT ITS REACH
 *
 * The derivation follows the input only while it is still the input: a member
 * read, or a whole-input argument to a function this gate can find. Anything
 * else — a computed `input[key]`, a spread, a hand-off to a callee outside
 * product source — is reported as OPAQUE and fails the gate rather than being
 * skipped. A gate that silently stopped following would be green over exactly
 * the code it could not read, which is the defect class this repository has
 * spent a session closing. If a legitimate new shape trips it, teach the gate
 * or stop passing the whole input around; do not narrow what it governs.
 *
 * What it does NOT prove: that a field the handler reads is USED for anything
 * (a read whose value is discarded still counts as a read), that the JSON
 * Schema the model sees advertises the same set (that is bound at compile time,
 * by deriving the property types from `AGENTS_ACTION_FIELDS`, and asserted in
 * `unit-agents-tool.test.ts` under full deps), and anything at all about a
 * field's TYPE.
 */

import { readSources } from './sources';
import { declaredName, identifierText, literalText, parse, type SyntaxNode, walk } from './syntax';

const AGENTS_TOOL = 'packages/core/src/tools/agents-tool.ts';
const REGISTRY = 'packages/core/src/tools/registry.ts';
/** The handler, the picklist, the per-action map and the schema entries — the
 *  four names this gate is a relation between. */
const HANDLER = 'dispatchAgentsAction';
const PICKLIST = 'AGENTS_TOOL_ACTIONS';
const FIELD_MAP = 'AGENTS_ACTION_FIELDS';
const INPUT_ENTRIES = 'AgentsInputEntries';
/** The discriminant is declared by the picklist itself, so it is never one of an
 *  action's fields. */
const DISCRIMINANT = 'action';

export type FindingKind =
  /** On the picklist with no `case` arm: nothing dispatches it. */
  | 'unhandled-action'
  /** On the picklist, absent from the field map: its fields are declared nowhere. */
  | 'undeclared-action'
  /** In the field map and not on the picklist. */
  | 'orphan-action'
  /** The handler reads it; the action's field list does not claim it. */
  | 'undeclared-field'
  /** Claimed for an action whose handler never reads it. */
  | 'unread-field'
  /** Claimed by an action and absent from the parse schema: dropped in flight. */
  | 'unparsed-field'
  /** Parsed and claimed by no action at all. */
  | 'orphan-field'
  /** The input went somewhere this gate cannot follow, so it proves nothing there. */
  | 'opaque';

export interface Finding {
  readonly kind: FindingKind;
  readonly detail: string;
}

export interface Declarations {
  readonly actions: readonly string[];
  /** Field names the parse schemas declare, discriminant excluded. */
  readonly parseFields: readonly string[];
  readonly actionFields: ReadonlyMap<string, readonly string[]>;
}

export interface HandlerReads {
  readonly byAction: ReadonlyMap<string, ReadonlySet<string>>;
  readonly opaque: readonly string[];
  /** Every whole-input hand-off followed, for the report's own denominator. */
  readonly hops: readonly string[];
}

interface Source {
  readonly file: string;
  readonly root: SyntaxNode;
  lineAt(offset: number): number;
}

/** Parsed product source, indexed by repo-relative path. Materialised through the
 *  one enumerator, so this gate reads what the repository governs rather than a
 *  corpus of its own. */
export function parseSources(sources: ReadonlyMap<string, string>): Map<string, Source> {
  const parsed = new Map<string, Source>();
  for (const [file, text] of sources) {
    if (!file.startsWith('packages/core/src/')) continue;
    const tree = parse(file, text);
    parsed.set(file, { file, root: tree.root, lineAt: tree.lineAt });
  }
  return parsed;
}

/** The initializer side of a module-level `const NAME = …`, through whatever
 *  `as const satisfies` wrapper it is written under. */
function declarationNamed(source: Source, name: string): SyntaxNode | undefined {
  let found: SyntaxNode | undefined;
  walk(source.root, (node) => {
    if (found !== undefined || node.type !== 'VariableDeclarator') return;
    if (declaredName(node) === name) found = node;
  });
  return found;
}

function firstOfType(node: SyntaxNode, type: string): SyntaxNode | undefined {
  let found: SyntaxNode | undefined;
  walk(node, (child) => {
    if (found === undefined && child.type === type) found = child;
  });
  return found;
}

/** Property names of the object literal inside `node`. */
function objectKeys(node: SyntaxNode): readonly string[] {
  const object = firstOfType(node, 'ObjectExpression');
  if (object === undefined) return [];
  const keys: string[] = [];
  for (const property of object.children) {
    if (property.type !== 'Property') continue;
    const key = declaredName(property);
    if (key !== undefined) keys.push(key);
  }
  return keys;
}

/** String elements of the array literal inside `node`. */
function stringElements(node: SyntaxNode): readonly string[] {
  const array = firstOfType(node, 'ArrayExpression');
  if (array === undefined) return [];
  const values: string[] = [];
  for (const element of array.children) {
    const text = literalText(element);
    if (text !== undefined) values.push(text);
  }
  return values;
}

export function readDeclarations(parsed: ReadonlyMap<string, Source>): Declarations {
  const registry = parsed.get(REGISTRY);
  const tool = parsed.get(AGENTS_TOOL);
  if (registry === undefined || tool === undefined) {
    throw new Error(`agents-fields: ${REGISTRY} or ${AGENTS_TOOL} is not in the enumerated product source`);
  }
  const picklist = declarationNamed(registry, PICKLIST);
  const entries = declarationNamed(tool, INPUT_ENTRIES);
  const map = declarationNamed(tool, FIELD_MAP);
  if (picklist === undefined || entries === undefined || map === undefined) {
    throw new Error(`agents-fields: could not find ${PICKLIST}, ${INPUT_ENTRIES} and ${FIELD_MAP}`
      + ' — one of them was renamed, and this gate governs nothing until it names the new one');
  }
  const actionFields = new Map<string, readonly string[]>();
  const mapObject = firstOfType(map, 'ObjectExpression');
  for (const property of mapObject?.children ?? []) {
    if (property.type !== 'Property') continue;
    const action = declaredName(property);
    if (action !== undefined) actionFields.set(action, stringElements(property));
  }
  return {
    actions: stringElements(picklist),
    parseFields: objectKeys(entries).filter((field) => field !== DISCRIMINANT),
    actionFields,
  };
}

/* ── The code side ────────────────────────────────────────────────────────── */

/** Functions a file declares, by name: `function f()` and `const f = (…) => …`
 *  both, because the handler's hops are written both ways. */
function functionsOf(source: Source): Map<string, SyntaxNode> {
  const functions = new Map<string, SyntaxNode>();
  walk(source.root, (node) => {
    const isFunction = node.type === 'FunctionDeclaration'
      || node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression';
    if (!isFunction) return;
    const own = declaredName(node);
    const bound = node.parent?.type === 'VariableDeclarator' ? declaredName(node.parent) : undefined;
    const name = own ?? bound;
    if (name !== undefined && !functions.has(name)) functions.set(name, node);
  });
  return functions;
}

/** The parameter list of a function-like node. */
function paramsOf(node: SyntaxNode): readonly { readonly type: string; readonly node: SyntaxNode }[] {
  const params: { type: string; node: SyntaxNode }[] = [];
  const raw = 'params' in node.raw ? node.raw.params : [];
  for (const parameter of raw) {
    const matched = firstMatching(node, (child) => child.raw === parameter);
    if (matched !== undefined) params.push({ type: parameter.type, node: matched });
  }
  return params;
}

function firstMatching(node: SyntaxNode, predicate: (child: SyntaxNode) => boolean): SyntaxNode | undefined {
  let found: SyntaxNode | undefined;
  walk(node, (child) => {
    if (found === undefined && predicate(child)) found = child;
  });
  return found;
}

/** Preorder, minus one subtree — how the handler's pre-switch statements are read
 *  separately from its arms. */
function walkExcept(node: SyntaxNode, skip: SyntaxNode | undefined, visit: (n: SyntaxNode) => void): void {
  if (node === skip) return;
  visit(node);
  for (const child of node.children) walkExcept(child, skip, visit);
}

/** Where a repo-relative import specifier resolves inside product source. */
function resolveLocal(from: string, specifier: string, parsed: ReadonlyMap<string, Source>): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const segments = from.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  const base = segments.join('/');
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (parsed.has(candidate)) return candidate;
  }
  return undefined;
}

/** The module a name was imported from, when it was. */
function importedFrom(source: Source, name: string): string | undefined {
  let specifier: string | undefined;
  walk(source.root, (node) => {
    if (specifier !== undefined || node.type !== 'ImportDeclaration') return;
    const binds = node.children.some((child) =>
      (child.type === 'ImportSpecifier' || child.type === 'ImportDefaultSpecifier')
      && child.children.some((part) => identifierText(part) === name));
    if (!binds) return;
    const from = node.children.find((child) => literalText(child) !== undefined);
    specifier = from === undefined ? undefined : literalText(from);
  });
  return specifier;
}

interface Collector {
  readonly fields: Set<string>;
  readonly opaque: string[];
  readonly hops: string[];
  readonly visited: Set<string>;
}

/**
 * Every `<param>.<field>` read reachable from `scope`, following each call that
 * hands the whole parameter on. `skip` is a subtree to leave out.
 */
function collectReads(
  source: Source,
  scope: SyntaxNode,
  param: string,
  parsed: ReadonlyMap<string, Source>,
  functions: ReadonlyMap<string, Map<string, SyntaxNode>>,
  into: Collector,
  skip?: SyntaxNode,
): void {
  const at = (node: SyntaxNode): string => `${source.file}:${String(source.lineAt(node.start))}`;
  walkExcept(scope, skip, (node) => {
    if (node.type === 'MemberExpression') {
      const [object, property] = node.children;
      if (object === undefined || identifierText(object) !== param) return;
      const field = property === undefined ? undefined : identifierText(property);
      if (field === undefined) {
        into.opaque.push(`${at(node)} — a computed read of \`${param}\` cannot be attributed to a field name`);
        return;
      }
      into.fields.add(field);
      return;
    }
    if (node.type === 'CallExpression') {
      const [callee, ...args] = node.children;
      for (const [index, argument] of args.entries()) {
        if (identifierText(argument) !== param) continue;
        followHop(source, node, callee, index, parsed, functions, into, at);
      }
      return;
    }
    if (node.type !== 'Identifier' || identifierText(node) !== param) return;
    const parent = node.parent;
    const asMemberObject = parent?.type === 'MemberExpression' && parent.children[0] === node;
    const asArgument = parent?.type === 'CallExpression' && parent.children[0] !== node;
    // The binding itself, not a use of it: every function this walk enters names
    // its own parameter, and reading that as "used whole" would report every hop
    // as unfollowable at exactly the moment it was followed.
    const isBinding = parent !== undefined
      && (parent.type === 'FunctionDeclaration' || parent.type === 'ArrowFunctionExpression'
        || parent.type === 'FunctionExpression');
    if (asMemberObject || asArgument || isBinding) return;
    into.opaque.push(`${at(node)} — \`${param}\` is used whole here, not read field by field`);
  });
}

function followHop(
  source: Source,
  call: SyntaxNode,
  callee: SyntaxNode | undefined,
  index: number,
  parsed: ReadonlyMap<string, Source>,
  functions: ReadonlyMap<string, Map<string, SyntaxNode>>,
  into: Collector,
  at: (node: SyntaxNode) => string,
): void {
  const name = callee === undefined ? undefined : identifierText(callee);
  if (name === undefined) {
    into.opaque.push(`${at(call)} — the whole input is handed to a callee this gate cannot name`);
    return;
  }
  let target = functions.get(source.file)?.get(name);
  let targetSource = source;
  if (target === undefined) {
    const specifier = importedFrom(source, name);
    const resolved = specifier === undefined ? undefined : resolveLocal(source.file, specifier, parsed);
    const imported = resolved === undefined ? undefined : parsed.get(resolved);
    if (imported !== undefined) {
      target = functions.get(imported.file)?.get(name);
      targetSource = imported;
    }
  }
  if (target === undefined) {
    into.opaque.push(`${at(call)} — cannot follow \`${name}(…)\`: not a function declared here`
      + ' or imported from product source, so what it reads off the input is unknown');
    return;
  }
  const parameter = paramsOf(target)[index];
  if (parameter === undefined) {
    into.opaque.push(`${at(call)} — \`${name}(…)\` has no parameter at position ${String(index)}`);
    return;
  }
  if (parameter.type === 'ObjectPattern') {
    for (const property of parameter.node.children) {
      const key = property.type === 'Property' ? declaredName(property) : undefined;
      if (key !== undefined) into.fields.add(key);
    }
    into.hops.push(`${name}(…) [destructured]`);
    return;
  }
  const bound = identifierText(parameter.node);
  if (parameter.type !== 'Identifier' || bound === undefined) {
    into.opaque.push(`${at(call)} — \`${name}(…)\` binds position ${String(index)} to a pattern this gate cannot read`);
    return;
  }
  const key = `${targetSource.file}#${name}#${bound}`;
  if (into.visited.has(key)) return;
  into.visited.add(key);
  into.hops.push(`${name}(…)`);
  const functionsOfTarget = functions;
  collectReads(targetSource, target, bound, parsed, functionsOfTarget, into);
}

export function readHandler(parsed: ReadonlyMap<string, Source>): HandlerReads {
  const tool = parsed.get(AGENTS_TOOL);
  if (tool === undefined) throw new Error(`agents-fields: ${AGENTS_TOOL} is not in the enumerated product source`);
  const functions = new Map<string, Map<string, SyntaxNode>>();
  for (const source of parsed.values()) functions.set(source.file, functionsOf(source));

  const handler = functions.get(AGENTS_TOOL)?.get(HANDLER);
  if (handler === undefined) {
    throw new Error(`agents-fields: ${AGENTS_TOOL} declares no ${HANDLER} — the handler was renamed`);
  }
  const input = paramsOf(handler).map((param) => identifierText(param.node)).find((name) =>
    name !== undefined && name !== 'deps' && name !== 'toolOptions');
  if (input === undefined) throw new Error(`agents-fields: cannot tell which parameter of ${HANDLER} is the input`);

  const dispatch = firstMatching(handler, (node) => {
    if (node.type !== 'SwitchStatement') return false;
    const [discriminant] = node.children;
    if (discriminant?.type !== 'MemberExpression') return false;
    const [object, property] = discriminant.children;
    return identifierText(object) === input && identifierText(property) === DISCRIMINANT;
  });
  if (dispatch === undefined) {
    throw new Error(`agents-fields: ${HANDLER} has no \`switch (${input}.${DISCRIMINANT})\``
      + ' — the per-action relation cannot be derived from anything else');
  }

  const opaque: string[] = [];
  const hops: string[] = [];
  // Reads OUTSIDE the switch. `action` is the discriminant; anything else read
  // before the arms belongs to no action and cannot be held to a field list, so
  // it is a finding rather than a silent attribution to all seven.
  const before: Collector = { fields: new Set(), opaque, hops, visited: new Set() };
  collectReads(tool, handler, input, parsed, functions, before, dispatch);
  for (const field of before.fields) {
    if (field === DISCRIMINANT) continue;
    opaque.push(`${AGENTS_TOOL} — \`${input}.${field}\` is read outside the switch, so no action owns it;`
      + ' move the read into the arm(s) that act on it');
  }

  const byAction = new Map<string, ReadonlySet<string>>();
  for (const clause of dispatch.children) {
    if (clause.type !== 'SwitchCase') continue;
    const [test] = clause.children;
    const action = test === undefined ? undefined : literalText(test);
    if (action === undefined) {
      opaque.push(`${AGENTS_TOOL}:${String(tool.lineAt(clause.start))} — a switch arm with no string test`);
      continue;
    }
    const collector: Collector = { fields: new Set(), opaque, hops, visited: new Set() };
    for (const statement of clause.children.slice(1)) {
      collectReads(tool, statement, input, parsed, functions, collector);
    }
    collector.fields.delete(DISCRIMINANT);
    byAction.set(action, collector.fields);
  }
  return { byAction, opaque, hops };
}

/* ── The verdict ──────────────────────────────────────────────────────────── */

export function audit(declarations: Declarations, reads: HandlerReads): Finding[] {
  const findings: Finding[] = [];
  const parsedFields = new Set(declarations.parseFields);
  const claimed = new Set<string>();

  for (const action of declarations.actions) {
    const read = reads.byAction.get(action);
    if (read === undefined) {
      findings.push({
        kind: 'unhandled-action',
        detail: `"${action}" is on ${PICKLIST} with no \`case\` arm in ${HANDLER}: the model is offered`
          + ' an action nothing dispatches',
      });
    }
    const declared = declarations.actionFields.get(action);
    if (declared === undefined) {
      findings.push({
        kind: 'undeclared-action',
        detail: `"${action}" is on ${PICKLIST} and absent from ${FIELD_MAP}: its fields are declared`
          + ' nowhere, so every one of them reaches the handler ABSENT — indistinguishable from a'
          + ' caller who never sent them',
      });
      continue;
    }
    for (const field of declared) claimed.add(field);
    for (const field of read ?? []) {
      if (declared.includes(field)) continue;
      findings.push({
        kind: 'undeclared-field',
        detail: `${HANDLER} reads \`${field}\` on action "${action}" and ${FIELD_MAP}.${action} does not`
          + ' declare it',
      });
    }
    for (const field of declared) {
      if (read?.has(field)) continue;
      findings.push({
        kind: 'unread-field',
        detail: `${FIELD_MAP}.${action} declares \`${field}\` and the "${action}" arm never reads it:`
          + ' a caller that sets it would be told the call is fine and get nothing',
      });
    }
    for (const field of declared) {
      if (parsedFields.has(field)) continue;
      findings.push({
        kind: 'unparsed-field',
        detail: `action "${action}" declares \`${field}\` and ${INPUT_ENTRIES} does not: the parse drops`
          + ' it, so the handler reads it as absent no matter what the caller sent',
      });
    }
  }

  const actions = new Set(declarations.actions);
  for (const action of declarations.actionFields.keys()) {
    if (actions.has(action)) continue;
    findings.push({
      kind: 'orphan-action',
      detail: `${FIELD_MAP} declares fields for "${action}", which is not on ${PICKLIST}`,
    });
  }
  for (const field of declarations.parseFields) {
    if (claimed.has(field)) continue;
    findings.push({
      kind: 'orphan-field',
      detail: `${INPUT_ENTRIES} declares \`${field}\` and no action claims it: it is parsed, accepted,`
        + ' and read by nothing',
    });
  }
  for (const detail of reads.opaque) findings.push({ kind: 'opaque', detail });
  return findings;
}

if (import.meta.main) {
  const parsed = parseSources(readSources());
  const declarations = readDeclarations(parsed);
  const reads = readHandler(parsed);
  const findings = audit(declarations, reads);

  // Denominators first: a gate that found nothing because it read nothing is the
  // failure this instrument exists to prevent.
  const blank: string[] = [];
  if (declarations.actions.length === 0) blank.push(`read 0 actions from ${PICKLIST}`);
  if (declarations.parseFields.length === 0) blank.push(`read 0 fields from ${INPUT_ENTRIES}`);
  if (reads.byAction.size === 0) blank.push(`derived 0 case arms from ${HANDLER}`);
  const totalReads = [...reads.byAction.values()].reduce((sum, fields) => sum + fields.size, 0);
  if (totalReads === 0) blank.push('derived 0 field reads from the handler — the walk is not matching');
  if (reads.hops.length === 0) {
    blank.push('followed 0 whole-input hand-offs, so the fork arm\'s fields cannot have been seen');
  }
  if (blank.length > 0) {
    for (const problem of blank) console.error(`agents-fields: ${problem}`);
    process.exit(1);
  }

  if (findings.length === 0) {
    console.log(
      `agents-fields: ok — ${declarations.actions.length} action(s), ${declarations.parseFields.length}`
      + ` declared field(s), ${totalReads} field read(s) derived from ${reads.byAction.size} case arm(s)`
      + ` through ${reads.hops.length} whole-input hand-off(s) (${[...new Set(reads.hops)].join(', ')})`,
    );
    console.log(
      '  limits: proves each action\'s declared fields are exactly what its arm READS, and that the'
      + ' parse declares them. Says nothing about what a read is used for, about field TYPES, or about'
      + ' the JSON Schema the model sees — that set is derived from the same map at compile time and'
      + ' asserted under full deps in unit-agents-tool.test.ts.',
    );
    process.exit(0);
  }

  console.error(`agents-fields: ${findings.length} finding(s)\n`);
  for (const finding of findings) console.error(`  [${finding.kind}] ${finding.detail}`);
  console.error(
    '\nAn action\'s fields must be declared where they are read and parsed where they are sent.'
    + '\nA field the parse does not declare is EXCLUDED rather than refused, and the handler then'
    + '\nreads it as absent: on this surface that is a spend cap the caller asked for and nothing'
    + '\napplied. Declare the field in AgentsInputEntries and list it under the action that reads it.',
  );
  process.exit(1);
}
