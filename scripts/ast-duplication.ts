/**
 * Duplicate-implementation gate — the same logic written twice.
 *
 * This is the "X never worked on Y backend" defect at its source: when a piece
 * of logic exists in `packages/core` AND again in a backend, fixing one leaves
 * the other wrong, and the 08-11 hoist audit measured 10,167 lines of
 * should-be-core logic sitting in the backends. `unit-backend-twins.test.ts`
 * already catches one shape of this — a METHOD NAME present on both backend
 * classes — but it is blind to duplication under different names, to free
 * functions, and to duplication inside a single package. This gate covers the
 * rest.
 *
 * It compares abstract syntax, not text. Every function body is reduced to a
 * fingerprint over node kinds where identifiers are replaced by their order of
 * first appearance, so renaming every variable, parameter and callee does not
 * hide a copy — which is what a token- or line-similarity tool (jscpd) matches
 * on. Literal TEXT is kept, deliberately: two functions that differ only in a
 * SQL statement, an error message or a line of UI copy are not the same
 * function, and leaving those tokens out fingerprinted an INSERT and an
 * INSERT … ON CONFLICT identically.
 *
 * MIN_NODES = 26 is measured, not chosen, and it was re-measured after the
 * parser changed. Against the TypeScript AST the floor was 30; ESTree carries
 * fewer wrapper nodes for the same code (no `VariableDeclarationList`, no
 * `Parameter` around each parameter), so bodies count ~13% fewer — 105 -> 96,
 * 72 -> 64, 61 -> 55, 30 -> 26 on the groups this gate reports. Leaving the
 * floor at 30 would have silently stopped detecting 4 duplicates that were
 * already locked, including `lineSpan`/`lineCount`, whose bodies are BYTE
 * IDENTICAL. A gate that quietly detects less is the failure mode this repo has
 * already shipped once, so 26 is the largest floor at which nothing the old
 * threshold found is lost — the measured image of the old floor, not a taste.
 *
 * At 26 the tree holds 21 groups and every one was read individually: 20 are
 * duplicated logic a reviewer would want removed (`timingSafeEqual` verbatim in
 * cf-backend and core, `getHistory` verbatim in the CLI and core, one JSON
 * config loader verbatim across cli-backend and cli, one cookie-reading loop
 * under two names, one line-counting helper under two names, one event fan-out
 * duplicated across the two agent clients, `parsePositiveInt` three times), 1 is
 * arguable (two adjacent thin RPC wrappers in `actor-agent.ts`), and none is a
 * coincidental shape collision. Going lower stops holding: the groups below 26
 * are mostly SQL-row-fetch and React-handler boilerplate, which is duplication a
 * blocking gate should not die on.
 *
 * The limit that follows from keeping literal text: a near-copy whose literals
 * were also edited is not reported. `fmtSize` in cf-backend and `formatBytes`
 * in the CLI are the same algorithm over different unit strings, and this gate
 * does not see them.
 */

import { createHash } from 'node:crypto';

import { assertMeasured, reconcile, report, writeLock } from './gate-ratchet.ts';
import { readSources } from './sources.ts';
import {
  blockBodyOf, declaredName, functionOwner, identifierCalleeName, identifierText,
  literalText, memberCalleeName, methodKind, parse, type SyntaxNode, walk,
} from './syntax.ts';

const root = new URL('..', import.meta.url).pathname;
const LOCK = `${root}scripts/ast-duplication.lock.json`;

/**
 * The smallest body worth calling a duplicate, in AST nodes. This was 30 while
 * the gate counted TypeScript's AST; ESTree has fewer wrapper nodes for the same
 * code — no `VariableDeclarationList`, no `Parameter` around each parameter — so
 * the same body now counts about 13% fewer (measured across the groups this gate
 * reports: 52→45, 61→55, 72→64, 105→96). 26 is the image of the old floor under
 * the new unit, picked by measurement rather than taste: it is the largest value
 * at which no group the previous implementation reported is lost.
 */
const MIN_NODES = 26;

export type DuplicateKind = 'cross-package' | 'cross-file' | 'same-file';

export interface DuplicateMember {
  readonly file: string;
  readonly line: number;
  readonly name: string;
}

export interface DuplicateGroup {
  readonly key: string;
  readonly kind: DuplicateKind;
  readonly nodes: number;
  readonly members: readonly DuplicateMember[];
}

interface Unit extends DuplicateMember {
  readonly size: number;
  readonly hash: string;
  readonly start: number;
  readonly end: number;
}

function slot(map: Map<string, number>, key: string): number {
  const hit = map.get(key);
  if (hit !== undefined) return hit;
  map.set(key, map.size);
  return map.size - 1;
}

interface Fingerprint {
  readonly hash: string;
  readonly size: number;
}

/**
 * Structure, with identifiers reduced to first-use order so a renamed copy still
 * matches, and literal text kept because it is content rather than plumbing: SQL,
 * prompts, error strings, UI copy. The node type is the stable string name, not
 * TypeScript's numeric `SyntaxKind`, which moved between compiler versions.
 */
function fingerprintOf(body: SyntaxNode): Fingerprint {
  const names = new Map<string, number>();
  const parts: string[] = [];
  let size = 0;
  const visit = (n: SyntaxNode): void => {
    size += 1;
    parts.push('(', n.type);
    const identifier = identifierText(n);
    if (identifier !== undefined) {
      parts.push('#' + slot(names, identifier));
    } else {
      const literal = literalText(n);
      if (literal !== undefined) parts.push('=' + literal);
    }
    for (const child of n.children) visit(child);
    parts.push(')');
  };
  for (const child of body.children) visit(child);
  return { hash: createHash('sha256').update(parts.join('')).digest('hex').slice(0, 16), size };
}

/** A callback passed to `useCallback` or `.map` has no name of its own, and
 *  reporting only the enclosing component sent a reader to the wrong line. */
function nameOf(node: SyntaxNode): string {
  if (methodKind(node) === 'constructor') return 'constructor';
  const own = declaredName(node);
  if (own !== undefined) return own;

  let inner = 'anonymous';
  const { parent } = node;
  if (parent?.type === 'CallExpression') {
    inner = memberCalleeName(parent) ?? identifierCalleeName(parent) ?? inner;
  }
  for (let p = node.parent; p !== undefined; p = p.parent) {
    if (methodKind(p) === 'constructor') return `constructor > ${inner}`;
    const owner = declaredName(p);
    if (owner !== undefined) return `${owner} > ${inner}`;
  }
  return inner;
}

function unitsOf(file: string, text: string): Unit[] {
  const parsed = parse(file, text);
  const units: Unit[] = [];
  walk(parsed.root, (node) => {
    const body = blockBodyOf(node);
    if (body === undefined) return;
    const { hash, size } = fingerprintOf(body);
    // The span and the name come from the member a function implements, not the
    // function expression ESTree hangs off it, so output points at the method.
    const unit = functionOwner(node);
    units.push({
      file,
      line: parsed.lineAt(unit.start),
      name: nameOf(unit),
      size,
      hash,
      start: unit.start,
      end: unit.end,
    });
  });
  return units;
}

function classify(members: readonly DuplicateMember[]): DuplicateKind {
  if (new Set(members.map((m) => m.file.split('/')[1])).size > 1) return 'cross-package';
  return new Set(members.map((m) => m.file)).size > 1 ? 'cross-file' : 'same-file';
}

export function findDuplicateGroups(
  sources: ReadonlyMap<string, string>,
  minNodes = MIN_NODES,
): DuplicateGroup[] {
  const byHash = new Map<string, Unit[]>();
  for (const [file, text] of sources) {
    for (const unit of unitsOf(file, text)) {
      if (unit.size < minNodes) continue;
      const bucket = byHash.get(unit.hash);
      if (bucket) bucket.push(unit); else byHash.set(unit.hash, [unit]);
    }
  }

  const candidates: { group: DuplicateGroup; units: readonly Unit[] }[] = [];
  const seen = new Map<string, number>();
  for (const units of byHash.values()) {
    if (units.length < 2) continue;
    const members = [...units].sort((a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line);
    const kind = classify(members);
    // The key must survive edits inside a duplicated body, so it names members
    // rather than lines or the fingerprint. Two groups can share a member set
    // (four functions of one name in two shapes); the repeat index keeps both.
    const base = `${kind} ${members.map((m) => `${m.file}#${m.name}`).join(' | ')}`;
    const repeat = seen.get(base) ?? 0;
    seen.set(base, repeat + 1);
    candidates.push({
      group: {
        key: repeat === 0 ? base : `${base} [${repeat + 1}]`,
        kind,
        nodes: members[0].size,
        members,
      },
      units: members,
    });
  }

  // Duplicating a whole function duplicates every function nested in it, so an
  // unfiltered pass reports one defect once per nesting level. Only the
  // outermost group is kept: a group whose every member sits inside a member of
  // an already-kept, larger group says nothing new.
  candidates.sort((a, b) => b.group.nodes - a.group.nodes);
  const kept: { group: DuplicateGroup; units: readonly Unit[] }[] = [];
  for (const candidate of candidates) {
    const contained = candidate.units.every((unit) => kept.some((outer) =>
      outer.units.some((o) =>
        o.file === unit.file && o.start <= unit.start && o.end >= unit.end)));
    if (!contained) kept.push(candidate);
  }

  const rank = { 'cross-package': 0, 'cross-file': 1, 'same-file': 2 } satisfies Record<DuplicateKind, number>;
  return kept
    .map((c) => c.group)
    .sort((a, b) => rank[a.kind] - rank[b.kind] || b.nodes - a.nodes);
}

export function describe(group: DuplicateGroup): string {
  const head = `  ${group.kind}, ${group.nodes} AST nodes, ${group.members.length} copies`;
  return [head, ...group.members.map((m) => `    ${m.file}:${m.line} ${m.name}`)].join('\n');
}

if (import.meta.main) {
  const sources = readSources();
  const units = [...sources].reduce((n, [file, text]) => n + unitsOf(file, text).length, 0);
  const measured = assertMeasured('ast-duplication', [
    ['source files', sources.size],
    ['function bodies', units],
  ]);
  const groups = findDuplicateGroups(sources);
  if (process.argv.includes('--lock')) {
    const count = writeLock(groups.map((g) => g.key), LOCK);
    console.log(`ast-duplication: locked ${count} group(s) over ${measured}`);
  } else {
    const detail = new Map(groups.map((g) => [g.key, describe(g)]));
    process.exit(report(
      'ast-duplication',
      reconcile(groups.map((g) => g.key), LOCK),
      detail,
      'bun scripts/ast-duplication.ts --lock',
      measured,
    ));
  }
}
