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
 * on. Literal text is abstracted too, so a copy whose units, keys, numbers or
 * messages were edited is still one group. Two kinds of text stay, because they
 * decide what the code does rather than how it reads: query text handed to the
 * SQL port (a tagged template, or the first argument of `.exec`), and intrinsic
 * JSX tags (`<dt>` is the string `'dt'` to React).
 *
 * Measured 2026-09-25 over 1,130 files at the 26-node floor: literal text kept
 * found 0 groups; every literal abstracted found 47, and 16 of those differ
 * only in their query or their markup (rowid cursors in `fork-transfer.ts`,
 * single-row reads in `hub/log.ts`, two JSX wrappers with different tags, and
 * six methods of the blueprint and live-share stores over parallel tables).
 * Keeping query text and intrinsic tags found 31, each read and each merged at
 * its source, including `seededRandom` copied into the gallery with its hex
 * constant respelled and `base64Url` twice in core.
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
 * The limit that follows from keeping query text: two stores whose methods
 * differ only in table and column names are not reported. See BLIND_SPOTS.
 *
 * WHAT `--lock` MAY WRITE. The lock only shrinks or is re-keyed. A group that
 * was fixed drops out and a group that lost a copy is recorded with the copies
 * it has left; a group the lock has never held is refused, and a refused run
 * writes nothing at all. The one arrival `--lock` accepts is one a departure
 * pays for at the same copy count or higher, which is the rename and the file
 * move — both change the key of a duplicate nobody made worse. So the way to
 * clear a finding here is to delete the copy, never to re-record it.
 */

import { createHash } from 'node:crypto';

import {
  assertMeasured, readLock, reconcile, refuseLock, report, shrinkOnly, writeLock,
  type LockRefusal,
} from './gate-ratchet';
import { readSources } from './sources';
import {
  blockBodyOf, declaredName, functionOwner, identifierCalleeName, identifierText,
  literalText, memberCalleeName, methodKind, parse, type Parsed, type SyntaxNode, walk,
} from './syntax';

const root = new URL('..', import.meta.url).pathname;

const LOCK = `${root}scripts/ast-duplication.lock.json`;

/**
 * The smallest body worth calling a duplicate, in AST nodes. ESTree carries
 * fewer wrapper nodes for the same code than the TypeScript AST (no
 * `VariableDeclarationList`, no `Parameter` around each parameter), so bodies
 * count about 13% fewer here (measured across the groups this gate reports:
 * 52→45, 61→55, 72→64, 105→96). 26 is the largest floor at which every group
 * the old floor of 30 found is still found: the measured image of that floor
 * under the new unit, not a taste.
 */
export const MIN_NODES = 26;

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

/** One function body: where it lives and its identifier-normalised structure. */
export interface Unit extends DuplicateMember {
  readonly size: number;
  /** Structure with literal text kept: a body another file repeats verbatim. */
  readonly hash: string;
  /** Structure with literal text abstracted except SQL: what this gate groups by. */
  readonly likeness: string;
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
  readonly likeness: string;
  readonly size: number;
}

/**
 * Text handed to the SQL port: a tagged template (`SqlExecutor`) or the first
 * argument of `.exec(...)` (`SqlExec`). Two getters over different tables are
 * different queries, so this text stays in the likeness fingerprint.
 */
function isQueryText(n: SyntaxNode): boolean {
  const text = n.type === 'TemplateElement' ? n.parent : n;
  const holder = text?.parent;

  if (holder?.type === 'TaggedTemplateExpression') return true;

  return holder?.type === 'CallExpression' && holder.children[1] === text && memberCalleeName(holder) === 'exec';
}

/**
 * Structure, with identifiers reduced to first-use order so a renamed copy still
 * matches. `hash` keeps every literal's text. `likeness` keeps only query text and
 * intrinsic JSX tags (`<dt>` is the string `'dt'` to React, not a binding), so a
 * copy whose units, keys, numbers or messages were edited still matches. The node
 * type is the stable string name, not TypeScript's numeric `SyntaxKind`, which
 * moved between compiler versions.
 */
function fingerprintOf(body: SyntaxNode): Fingerprint {
  const names = new Map<string, number>();
  const exact: string[] = [];
  const likeness: string[] = [];
  let size = 0;

  const visit = (n: SyntaxNode): void => {
    size += 1;
    exact.push('(', n.type);
    likeness.push('(', n.type);
    const identifier = identifierText(n);

    if (identifier !== undefined) {
      const name = '#' + slot(names, identifier);
      exact.push(name);

      const intrinsic = n.type === 'JSXIdentifier' && /^[a-z]/u.test(identifier)
        && (n.parent?.type === 'JSXOpeningElement' || n.parent?.type === 'JSXClosingElement');

      likeness.push(intrinsic ? '=' + identifier : name);
    } else {
      const literal = literalText(n);

      if (literal !== undefined) {
        exact.push('=' + literal);

        if (isQueryText(n)) likeness.push('=' + literal);
      }
    }

    for (const child of n.children) visit(child);
    exact.push(')');
    likeness.push(')');
  };

  for (const child of body.children) visit(child);

  const digest = (parts: readonly string[]): string =>
    createHash('sha256').update(parts.join('')).digest('hex').slice(0, 16);

  return { hash: digest(exact), likeness: digest(likeness), size };
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

/** Every function body of one parsed file; a caller that already parsed the file passes its tree. */
export function unitsOf(file: string, parsed: Parsed): Unit[] {
  const units: Unit[] = [];
  walk(parsed.root, (node) => {
    const body = blockBodyOf(node);

    if (body === undefined) return;
    const { hash, likeness, size } = fingerprintOf(body);
    // The span and the name come from the member a function implements, not the
    // function expression ESTree hangs off it, so output points at the method.
    const unit = functionOwner(node);
    units.push({
      file,
      line: parsed.lineAt(unit.start),
      name: nameOf(unit),
      size,
      hash,
      likeness,
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
  const byLikeness = new Map<string, Unit[]>();

  for (const [file, text] of sources) {
    for (const unit of unitsOf(file, parse(file, text))) {
      if (unit.size < minNodes) continue;
      const bucket = byLikeness.get(unit.likeness);

      if (bucket) bucket.push(unit); else byLikeness.set(unit.likeness, [unit]);
    }
  }

  const candidates: { group: DuplicateGroup; units: readonly Unit[] }[] = [];
  const seen = new Map<string, number>();

  for (const units of byLikeness.values()) {
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

export interface ShrunkGroups {
  /** What `--lock` writes, or nothing at all when the merge was refused. */
  readonly keys: readonly string[] | undefined;
  readonly refusals: readonly LockRefusal[];
}

/**
 * The lock `--lock` is allowed to write over the one already recorded: a group
 * may vanish or lose copies, and a group the lock has never held is refused
 * unless a vanished group pays for it at the same copy count or higher.
 *
 * The number each group is weighed by is its COPY COUNT, read back out of the
 * key rather than recorded twice: the lock records a group's identity as its
 * kind plus one `file#name` per copy, so the copies are already in there. That
 * is what makes a rename cheap and a third copy expensive — a moved pair
 * re-keys against the pair that left, while a pair that became a trio arrives
 * needing a three-copy departure that never happened.
 */
export function shrinkGroups(
  previous: readonly string[],
  candidate: readonly string[],
): ShrunkGroups {
  const numbered = (keys: readonly string[]): { key: string; value: number }[] =>
    keys.map((key) => ({ key, value: key.split(' | ').length }));

  const { merged, refusals } = shrinkOnly(numbered(previous), numbered(candidate));

  return {
    refusals,
    keys: refusals.length > 0 ? undefined : merged.map(({ key }) => key),
  };
}

/**
 * What this gate cannot see, printed on the GREEN path. A limitation visible
 * only in red output is invisible exactly when the tree is clean, which is
 * when somebody decides how far to trust the signal.
 */
export const BLIND_SPOTS: readonly string[] = [
  'A COPY WHOSE ONLY EDIT IS ITS SQL OR ITS JSX TAGS — NOT DETECTED. Query text '
  + '(a tagged template or the first argument of `.exec`) and intrinsic JSX tags '
  + 'stay in the fingerprint, so one algorithm over two tables is two bodies. '
  + 'Live pairs: `craftedToolRows`/`memoryChunkRows` in '
  + '`packages/core/src/identity/fork-transfer.ts` and '
  + '`stageCraftedTools`/`stageMemoryChunks` in `fork-writer.ts`.',
  'DUPLICATED POLICY IN DIFFERENT CODE SHAPES — NOT DETECTED. Two '
  + 'implementations of one rule with different structure share no fingerprint. '
  + 'Only identical structure is governed here.',
  'BODIES BELOW 26 AST NODES — OUT OF SCOPE. Small shapes collide by '
  + 'coincidence, so the floor keeps the gate from dying on boilerplate. A copy '
  + 'smaller than the floor is invisible here.',
];

if (import.meta.main) {
  const sources = readSources();
  const units = [...sources].reduce((n, [file, text]) => n + unitsOf(file, parse(file, text)).length, 0);

  const measured = assertMeasured('ast-duplication', [
    ['source files', sources.size],
    ['function bodies', units],
  ]);

  const groups = findDuplicateGroups(sources);

  // `--lock` records the census against the lock it already holds: see
  // `shrinkGroups` for the merge, which drops and re-keys and nothing else.
  if (process.argv.includes('--lock')) {
    const { keys, refusals } = shrinkGroups(readLock(LOCK), groups.map((g) => g.key));

    if (keys === undefined) {
      process.exit(refuseLock('ast-duplication', refusals, 'delete the copy or call the original'));
    }

    const count = writeLock(keys, LOCK);
    console.log(`ast-duplication: locked ${count} group(s) over ${measured}`);
  } else {
    const detail = new Map(groups.map((g) => [g.key, describe(g)]));

    const code = report({
      gate: 'ast-duplication',
      ratchet: reconcile(groups.map((g) => g.key), LOCK),
      detail,
      lockCommand: 'bun scripts/ast-duplication.ts --lock',
      measured,
    });

    if (code === 0) {
      for (const spot of BLIND_SPOTS) console.log(`  blind: ${spot}`);
    }

    process.exit(code);
  }
}
