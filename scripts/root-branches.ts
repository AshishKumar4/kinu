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

const isNull = (node: SyntaxNode): boolean => node.raw.type === 'Literal' && 'value' in node.raw && node.raw.value === null;

function memberName(node: SyntaxNode): string | undefined {
  if (node.raw.type !== 'MemberExpression' || node.raw.computed) return undefined;

  return node.raw.property.type === 'Identifier' ? node.raw.property.name : undefined;
}

/** `….actorHandle().actorId`. */
function isRootId(node: SyntaxNode): boolean {
  if (memberName(node) !== 'actorId') return false;
  const [object] = node.children;

  return object?.raw.type === 'CallExpression' && object.children[0] !== undefined && memberName(object.children[0]) === 'actorHandle';
}

/** An ActorPolicy: `actorPolicy(…)`, or a value named `policy`. */
function isPolicy(node: SyntaxNode | undefined): boolean {
  if (node === undefined) return false;

  if (node.raw.type === 'CallExpression') return node.children[0]?.raw.type === 'Identifier' && node.children[0].raw.name === 'actorPolicy';

  return (node.raw.type === 'Identifier' && node.raw.name === 'policy') || memberName(node) === 'policy';
}

function isRootBranch(node: SyntaxNode): boolean {
  if (node.raw.type === 'MemberExpression') return memberName(node) === 'workspaceAgent' && isPolicy(node.children[0]);

  if (node.raw.type !== 'BinaryExpression' || !['===', '!==', '==', '!='].includes(node.raw.operator)) return false;
  const [left, right] = node.children;

  if (left === undefined || right === undefined) return false;

  return [[left, right], [right, left]].some(([side, other]) => isRootId(side)
    || (PARENT_MEMBERS.has(memberName(side) ?? '') && isNull(other))
    || (memberName(side) === 'origin' && literalString(other.raw) === 'system'));
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
    if (!/actorHandle|parentActorId|parentKey|parentRelay|hirer|origin|workspaceAgent/u.test(text)) continue;
    const parsed = parse(file, text);

    walk(parsed.root, (node) => {
      if (isRootBranch(node)) found.push({ key: `${file}#${symbolOf(node)}`, line: parsed.lineAt(node.start), code: text.slice(node.start, node.end) });
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
