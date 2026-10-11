/**
 * Root-branches census (design v2 §9). Every place product code decides by whether an agent is the workspace's own is
 * a root branch: an id compared to the root's (`actorHandle().actorId`), a parent that is null (`parentActorId`,
 * `parentKey`, `parentRelay`), the `'system'` origin, or the ActorPolicy facts that name it (`workspaceAgent` read, a
 * null `hirer`). `scripts/root-branches.json` lists each by file and enclosing declaration with its count, as J (kept:
 * policy data, and why) or H (to go: the design step that removes it, and why).
 *
 * A branch the list lacks fails: a new root branch is classified before it lands. An entry no branch reproduces, or
 * reproduces at another count, fails too: a removed branch leaves the list in the same commit. A design step closes
 * only once no H entry naming it is left, so the list is that step's proof.
 *
 * `--list` prints the branches found, in the list's shape, for classifying.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { readSources } from './sources';
import { declaredName, literalString, parse, walk, type SyntaxNode } from './syntax';

const root = new URL('..', import.meta.url).pathname;

export const CENSUS = 'scripts/root-branches.json';

/** A member that names the root by a null parent. */
const PARENT_MEMBERS: ReadonlySet<string> = new Set(['parentActorId', 'parentKey', 'parentRelay', 'hirer']);

const EntrySchema = v.union([
  v.strictObject({ count: v.number(), kind: v.literal('J'), why: v.pipe(v.string(), v.nonEmpty()) }),
  v.strictObject({ count: v.number(), kind: v.literal('H'), until: v.pipe(v.string(), v.regex(/^step [1-9]$/u)), why: v.pipe(v.string(), v.nonEmpty()) }),
]);

const CensusSchema = v.record(v.string(), EntrySchema);

export type CensusEntry = v.InferOutput<typeof EntrySchema>;

/** An ESTree node as the parser hands it over: read by its fields, which differ by `type`. */
type Raw = SyntaxNode['raw'];

/** What a name or member holds, where it is one of the three a branch reads. */
type Held = 'rootId' | 'policy' | 'parent';

/**
 * What one file binds to a root id, a policy or a parent: a variable or class member whose value is one, a parameter,
 * variable or getter typed `ActorPolicy`, and a name destructured out of one. A name resolves to its nearest binding,
 * function scope by function scope, so a rename or an alias does not take a branch out of the census and the same name
 * bound to something else elsewhere is not one.
 */
interface Aliases {
  /** Each function scope's (and the module's) bindings: what each holds, or null for anything else. */
  readonly scopes: Map<SyntaxNode, Map<string, Held | null>>;
  /** `this.<name>` members, class by class alike. */
  readonly members: Map<string, Held>;
  readonly nodes: Map<Raw, SyntaxNode>;
}

const FUNCTIONS: ReadonlySet<string> = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** The function (or module) a node's names are bound in. */
function scopeOf(node: SyntaxNode): SyntaxNode {
  let up = node.parent;

  while (up?.parent !== undefined && !FUNCTIONS.has(up.raw.type)) up = up.parent;

  return up ?? node;
}

const nameOf = (raw: Raw | null | undefined): string | undefined => (raw?.type === 'Identifier' ? raw.name : undefined);

function memberOf(raw: Raw | null | undefined): string | undefined {
  if (raw?.type !== 'MemberExpression' || raw.computed) return undefined;

  return nameOf(raw.property);
}

const isNull = (raw: Raw | undefined): boolean => raw?.type === 'Literal' && 'value' in raw && raw.value === null;

/** What `raw` holds through a name or a `this` member bound to one. */
function heldBy(raw: Raw | null | undefined, aliases: Aliases): Held | null {
  if (raw === null || raw === undefined) return null;

  if (raw.type === 'MemberExpression' && raw.object.type === 'ThisExpression') return aliases.members.get(memberOf(raw) ?? '') ?? null;
  const name = nameOf(raw);
  const node = aliases.nodes.get(raw);

  if (name === undefined || node === undefined) return null;

  for (let scope: SyntaxNode | undefined = scopeOf(node); scope !== undefined; scope = scope.parent === undefined ? undefined : scopeOf(scope)) {
    const bound = aliases.scopes.get(scope)?.get(name);

    if (bound !== undefined) return bound;

    if (scope.parent === undefined) break;
  }

  return null;
}

/** `….actorHandle().actorId`, or a name bound to one. */
function isRootId(raw: Raw | null | undefined, aliases: Aliases): boolean {
  if (raw?.type === 'MemberExpression' && memberOf(raw) === 'actorId' && raw.object.type === 'CallExpression') {
    return memberOf(raw.object.callee) === 'actorHandle';
  }

  return heldBy(raw, aliases) === 'rootId';
}

/** `actorPolicy(…)`, or a name bound or typed to one. */
function isPolicy(raw: Raw | null | undefined, aliases: Aliases): boolean {
  if (raw?.type === 'CallExpression') return nameOf(raw.callee) === 'actorPolicy';

  return heldBy(raw, aliases) === 'policy';
}

/** A parent: a member naming one, or a name destructured out of one. */
const isParent = (raw: Raw, aliases: Aliases): boolean => PARENT_MEMBERS.has(memberOf(raw) ?? '') || heldBy(raw, aliases) === 'parent';

/** What a value holds, read through the aliases known so far. */
function heldIn(value: Raw | null | undefined, aliases: Aliases): Held | null {
  if (isRootId(value, aliases)) return 'rootId';

  return isPolicy(value, aliases) ? 'policy' : null;
}

/** The value a getter yields: its one `return`'s argument. */
function yielded(fn: Raw): Raw | undefined {
  if (fn.type !== 'FunctionExpression' || fn.body?.type !== 'BlockStatement') return undefined;
  const [only] = fn.body.body;

  return only?.type === 'ReturnStatement' ? only.argument ?? undefined : undefined;
}

/** Every name a binding pattern binds, with the key it was destructured by, if any. */
function boundNames(pattern: Raw, key?: string): { readonly name: string; readonly key: string | undefined; readonly typed: Raw | undefined }[] {
  if (pattern.type === 'Identifier') return [{ name: pattern.name, key, typed: pattern.typeAnnotation ?? undefined }];

  if (pattern.type === 'AssignmentPattern') return boundNames(pattern.left, key);

  if (pattern.type === 'ObjectPattern') {
    return pattern.properties.flatMap((property) => (property.type === 'Property' && !property.computed
      ? boundNames(property.value, nameOf(property.key))
      : []));
  }

  return [];
}

/** A file's aliases, to a fixed point: an alias of an alias is one too. */
function aliasesOf(tree: SyntaxNode, text: string): Aliases {
  const aliases: Aliases = { scopes: new Map(), members: new Map(), nodes: new Map() };
  const typedPolicy = (raw: Raw | undefined): boolean => raw !== undefined && /\bActorPolicy\b/u.test(text.slice(raw.start, raw.end));

  walk(tree, (node) => { aliases.nodes.set(node.raw, node); });

  const bind = (scope: SyntaxNode, name: string, held: Held | null): boolean => {
    const names = aliases.scopes.get(scope) ?? new Map<string, Held | null>();
    const before = names.get(name);

    aliases.scopes.set(scope, names);
    // A name bound twice in one scope is what either binding holds: the census over-counts rather than misses.
    names.set(name, before ?? held);

    return before === undefined || (before === null && held !== null);
  };

  const pattern = (scope: SyntaxNode, id: Raw, init: Raw | null | undefined): boolean => boundNames(id).map(({ name, key, typed }) => {
    if (typedPolicy(typed)) return bind(scope, name, 'policy');

    if (key === undefined) return bind(scope, name, heldIn(init, aliases));

    if (key === 'actorId' && init?.type === 'CallExpression' && memberOf(init.callee) === 'actorHandle') return bind(scope, name, 'rootId');

    return bind(scope, name, PARENT_MEMBERS.has(key) ? 'parent' : null);
  }).some(Boolean);

  // A class field holds what its value does; a getter what it yields, or a policy where it is typed one.
  const memberHeld = (raw: Raw): Held | null => {
    if (raw.type === 'PropertyDefinition') return heldIn(raw.value, aliases);

    if (raw.type !== 'MethodDefinition' || raw.kind !== 'get') return null;

    return typedPolicy(raw.value.returnType ?? undefined) ? 'policy' : heldIn(yielded(raw.value), aliases);
  };

  for (let changed = true; changed;) {
    changed = false;
    walk(tree, (node) => {
      const { raw } = node;

      if (raw.type === 'VariableDeclarator') changed = pattern(scopeOf(node), raw.id, raw.init) || changed;

      if (FUNCTIONS.has(raw.type) && 'params' in raw) {
        for (const param of raw.params) changed = (param.type !== 'TSParameterProperty' && pattern(node, param, undefined)) || changed;
      }

      const member = raw.type === 'PropertyDefinition' || raw.type === 'MethodDefinition' ? nameOf(raw.key) : undefined;
      const held = memberHeld(raw);

      if (member !== undefined && held !== null && !aliases.members.has(member)) {
        aliases.members.set(member, held);
        changed = true;
      }
    });
  }

  return aliases;
}

function isRootBranch(node: SyntaxNode, aliases: Aliases): boolean {
  const { raw } = node;

  if (raw.type === 'MemberExpression') return memberOf(raw) === 'workspaceAgent' && isPolicy(raw.object, aliases);

  // `const { workspaceAgent } = actorPolicy(…)` reads it where it destructures it.
  if (raw.type === 'VariableDeclarator' && isPolicy(raw.init, aliases)) return boundNames(raw.id).some(({ key }) => key === 'workspaceAgent');

  if (raw.type !== 'BinaryExpression' || !['===', '!==', '==', '!='].includes(raw.operator) || raw.left.type === 'PrivateIdentifier') return false;
  const sides: readonly (readonly [Raw, Raw])[] = [[raw.left, raw.right], [raw.right, raw.left]];

  return sides.some(([side, other]) => isRootId(side, aliases)
    || (isParent(side, aliases) && isNull(other))
    || (memberOf(side) === 'origin' && literalString(other) === 'system'));
}

/** The enclosing declarations' names, outermost first: `OrchestratorAgent.hostedTaskProfile`. */
function symbolOf(node: SyntaxNode): string {
  const names: string[] = [];

  for (let up = node.parent; up !== undefined; up = up.parent) {
    const name = declaredName(up);

    if (name !== undefined) names.unshift(name);
  }

  return names.join('.') || '(module)';
}

/** One root branch's site: its file and enclosing declaration, and its line and code for a reader classifying it. */
export interface RootBranch {
  readonly key: string;
  readonly line: number;
  readonly code: string;
}

/** Every root branch in `sources`. */
export function rootBranches(sources: ReadonlyMap<string, string>): RootBranch[] {
  const found: RootBranch[] = [];

  for (const [file, text] of sources) {
    // A cheap prefilter: no file without one of the names holds a branch.
    if (!/actorHandle|parentActorId|parentKey|parentRelay|hirer|origin|workspaceAgent|ActorPolicy|actorPolicy/u.test(text)) continue;
    const parsed = parse(file, text);

    const aliases = aliasesOf(parsed.root, text);

    walk(parsed.root, (node) => {
      if (isRootBranch(node, aliases)) found.push({ key: `${file}#${symbolOf(node)}`, line: parsed.lineAt(node.start), code: text.slice(node.start, node.end) });
    });
  }

  return found;
}

/** The root branches counted by `file#symbol`. */
export function censusOf(sources: ReadonlyMap<string, string>): Map<string, number> {
  const found = new Map<string, number>();

  for (const { key } of rootBranches(sources)) found.set(key, (found.get(key) ?? 0) + 1);

  return found;
}

/** What the census and the list disagree on, each as one line a reader can act on. */
export function disagreements(found: ReadonlyMap<string, number>, census: Readonly<Record<string, CensusEntry>>): string[] {
  const lines: string[] = [];

  for (const [key, count] of found) {
    const entry = census[key];

    if (entry === undefined) lines.push(`${key}: ${String(count)} root branch(es) the list does not classify — add it as J (why it stays) or H (the step that removes it)`);
    else if (entry.count !== count) lines.push(`${key}: ${String(count)} root branch(es), the list says ${String(entry.count)} — update its count with the change`);
  }

  for (const key of Object.keys(census)) {
    if (!found.has(key)) lines.push(`${key}: listed, and no root branch reproduces it — remove the entry with the change that removed the branch`);
  }

  return lines.sort();
}

export function readCensus(): Record<string, CensusEntry> {
  return v.parse(CensusSchema, JSON.parse(readFileSync(join(root, CENSUS), 'utf8')));
}

if (import.meta.main) {
  const sources = readSources();
  const found = censusOf(sources);

  if (process.argv.includes('--list')) {
    for (const branch of rootBranches(sources).sort((a, b) => a.key.localeCompare(b.key))) console.log(`${branch.key}:${String(branch.line)}  ${branch.code}`);
  } else {
    const census = readCensus();
    const lines = disagreements(found, census);
    const owed = Object.values(census).filter((entry) => entry.kind === 'H');
    const steps = [...new Set(owed.map((entry) => entry.until))].sort();

    if (lines.length > 0) {
      console.error(`root-branches: ${String(lines.length)} disagreement(s) with ${CENSUS}\n\n  ${lines.join('\n  ')}`);
      process.exit(1);
    }

    console.log(`root-branches: ok — ${String(found.size)} sites, ${String(Object.values(census).filter((entry) => entry.kind === 'J').length)} J, `
      + `${String(owed.length)} H (${steps.map((step) => `${step}: ${String(owed.filter((entry) => entry.until === step).length)}`).join(', ')})`);
  }
}
