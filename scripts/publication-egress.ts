/**
 * Publication egress: every way the settle path makes a result durable is classified.
 *
 * A breached run is sealed: `admitsPublication` refuses it on every member of
 * PUBLICATION_SURFACES, and core's contract-publication-seal suite proves that refusal total.
 * No type can say which of the settle path's writes ARE publication, so this gate holds
 * `packages/core/src/mcts/convergence.ts` to a declared classification. Each value import, each
 * local helper that writes, each memory write and each table a SQL statement writes is either a
 * publication surface, which the seal must cover, or a disclosure with its reason. A new egress
 * is red until someone classifies it; a classification whose egress is gone is red until removed.
 *
 * The seal covers what carries the claim, never what carries the caveat: suppressing a
 * diagnostic is how a breach goes silent. Specified by docs/EXPLORATION.md, "The publication seal".
 */

import type { Node } from 'oxc-parser';

import { assertMeasured, finding } from './gate-ratchet';
import { readRepositoryFile } from './sources';
import { parse, walk, type SyntaxNode } from './syntax';
import type { PublicationSurface } from '../packages/core/src/types/objective';

export const SETTLE = 'packages/core/src/mcts/convergence.ts';

/** The settle entry point: its direct writes are collected, the function itself is not. */
const ENTRY = 'converge';

const DISCLOSURE = 'disclosure: ';

/** A disclosure reason shorter than this names nothing a reviewer could check. */
const MIN_REASON_CHARS = 9;

export type EgressVerdict = PublicationSurface | `disclosure: ${string}`;

export const SETTLE_EGRESS = {
  // Vector-indexed: an input to future inference.
  'memory.append': 'memory',
  'memory.index': 'memory',
  // A breach on a minimise objective normalises high, so a breach makes this more likely to fire.
  maybeStoreCraftedTool: 'craft',
  // Scaffold error-rate monitoring reads it, so a laundered score can move a scaffold decision.
  recordTaskOutcome: 'task_history',
  'INSERT INTO task_history': 'task_history',
  // Turn-scoped and purged when unclaimed (mcts/takes.ts).
  captureAlternateTakes: 'disclosure: turn-scoped near-ties, purged when unclaimed',
  // A re-derived floor re-evaluates the tree under a new key; sealing it would destroy that path.
  abandonSearchTree: 'disclosure: run-keyed tree status, the re-evaluation input',
  'UPDATE search_nodes': 'disclosure: run-keyed tree status, the re-evaluation input',
  // Declared so a new import cannot arrive unclassified.
  isCraftable: 'disclosure: predicate, writes nothing',
  findNearTiedRivals: 'disclosure: read over the population',
  searchTree: 'disclosure: read of the search tree, writes nothing',
  inPopulation: 'disclosure: predicate, writes nothing',
  selectWinnerByTest: 'disclosure: selection, writes nothing durable',
  DEFAULT_CONFIG: 'disclosure: constants',
  EVIDENCE_BUDGETS: 'disclosure: constants',
  evidenceWindow: 'disclosure: pure truncation',
  isoDate: 'disclosure: pure formatting',
} satisfies Record<string, EgressVerdict>;

export const BLIND_SPOTS: readonly string[] = [
  'what a classified import does inside its own module: `maybeStoreCraftedTool` is classified by '
    + 'name, and a disclosure import that starts writing (say `searchTree`) is not re-derived',
  'egress other than a SQL tagged template, `memory.append` and `memory.index`: a VFS write, a '
    + 'fetch, an RPC or a queue send from this module reads as nothing',
  'SQL assembled at runtime: only a tagged template\'s own text is read, so a statement built by '
    + 'concatenation or handed in from elsewhere is invisible',
  'whether a live writer consults `admitsPublication` before it writes: this gate classifies the '
    + 'writes, it does not prove the seal is asked',
  'the rest of the settle path: only convergence.ts is read, and its imports are classified by '
    + 'name, not followed',
];

const SQL_WRITE = /\b(INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/gi;

const MEMORY_WRITES: ReadonlySet<string> = new Set(['append', 'index']);

const identifierName = (raw: Node | null | undefined): string | undefined =>
  raw?.type === 'Identifier' ? raw.name : undefined;

/** The name a property access ends in (`a.b` answers `b`), or a bare identifier's. */
const accessedName = (raw: Node): string | undefined =>
  raw.type === 'MemberExpression' && !raw.computed ? identifierName(raw.property) : identifierName(raw);

/** The durable writes one node performs: a SQL tagged template's statements, a memory write. */
function writesOf(node: SyntaxNode): readonly string[] {
  const { raw } = node;

  if (raw.type === 'TaggedTemplateExpression' && accessedName(raw.tag) === 'sql') {
    const text = raw.quasi.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join(' ');

    return [...text.matchAll(SQL_WRITE)].map(([, verb = '', table = '']) =>
      `${verb.replaceAll(/\s+/gu, ' ').toUpperCase()} ${table}`);
  }

  if (raw.type === 'CallExpression' && raw.callee.type === 'MemberExpression' && !raw.callee.computed) {
    const method = identifierName(raw.callee.property);

    if (method !== undefined && MEMORY_WRITES.has(method) && accessedName(raw.callee.object) === 'memory') {
      return [`memory.${method}`];
    }
  }

  return [];
}

/** The top-level function a node sits in, by name; undefined outside any named one. */
function topLevelFunction(node: SyntaxNode): string | undefined {
  let statement = node;

  while (statement.parent !== undefined && statement.parent.raw.type !== 'Program') statement = statement.parent;
  const { raw } = statement;
  const declaration = raw.type === 'ExportNamedDeclaration' ? raw.declaration : raw;

  if (declaration?.type === 'FunctionDeclaration') return identifierName(declaration.id);

  if (declaration?.type === 'VariableDeclaration') {
    const [declarator] = declaration.declarations;

    return identifierName(declarator?.id);
  }

  return undefined;
}

/** One module's egress: what it imports as values, which of its helpers write, and what is written. */
export interface Egress {
  readonly imports: readonly string[];
  readonly writers: readonly string[];
  readonly writes: readonly string[];
}

export function egressOf(file: string, text: string): Egress {
  const { root } = parse(file, text);
  const imports = new Set<string>();
  const writers = new Set<string>();
  const writes = new Set<string>();

  for (const statement of root.children) {
    const { raw } = statement;

    if (raw.type !== 'ImportDeclaration' || raw.importKind === 'type') continue;

    for (const specifier of raw.specifiers) {
      if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') continue;
      const local = identifierName(specifier.local);

      if (local !== undefined) imports.add(local);
    }
  }

  walk(root, (node) => {
    const found = writesOf(node);

    if (found.length === 0) return;

    for (const write of found) writes.add(write);
    const helper = topLevelFunction(node);

    if (helper !== undefined && helper !== ENTRY) writers.add(helper);
  });

  return { imports: [...imports].sort(), writers: [...writers].sort(), writes: [...writes].sort() };
}

/** Every name the classification must hold, once. */
export const egressNames = (egress: Egress): string[] =>
  [...new Set([...egress.imports, ...egress.writers, ...egress.writes])].sort();

export interface EgressProblem {
  readonly egress: string;
  readonly kind: 'unclassified' | 'stale' | 'unreasoned disclosure';
}

/** Holds what a module does against what is declared about it, in both directions. A publication
 *  verdict is a PUBLICATION_SURFACES member by type; a disclosure's reason is only a string, so its
 *  length is checked here. */
export function auditEgress(
  observed: readonly string[],
  declared: Readonly<Record<string, EgressVerdict>>,
): EgressProblem[] {
  const problems: EgressProblem[] = [];

  for (const egress of observed) {
    if (!(egress in declared)) problems.push({ egress, kind: 'unclassified' });
  }

  for (const [egress, verdict] of Object.entries(declared)) {
    if (!observed.includes(egress)) problems.push({ egress, kind: 'stale' });

    if (verdict.startsWith(DISCLOSURE) && verdict.length - DISCLOSURE.length < MIN_REASON_CHARS) {
      problems.push({ egress, kind: 'unreasoned disclosure' });
    }
  }

  return problems;
}

const CONSEQUENCE: Record<EgressProblem['kind'], { readonly silently: string; readonly fix: string }> = {
  unclassified: {
    silently: 'a breached run may publish through it: nothing says whether the seal must cover it',
    fix: 'classify it in SETTLE_EGRESS (scripts/publication-egress.ts) as a publication surface or '
      + 'as a disclosure with its reason',
  },
  stale: {
    silently: 'the classification describes a settle path that no longer exists, so it reads as coverage',
    fix: 'remove the entry from SETTLE_EGRESS',
  },
  'unreasoned disclosure': {
    silently: 'a disclosure with no reason is an exemption nobody can check',
    fix: 'state why this egress carries no claim a later run reads',
  },
};

if (import.meta.main) {
  const root = new URL('..', import.meta.url).pathname;
  const egress = egressOf(SETTLE, readRepositoryFile(root, SETTLE));
  const problems = auditEgress(egressNames(egress), SETTLE_EGRESS);

  if (problems.length > 0) {
    console.error(`publication-egress: ${String(problems.length)} settle-path egress problem(s)\n`);

    for (const problem of problems) {
      console.error(finding({
        invariant: 'every egress of the settle path is classified as a publication surface or a reasoned disclosure',
        at: `${SETTLE}: ${problem.egress}`,
        found: problem.kind,
        ...CONSEQUENCE[problem.kind],
      }));
    }

    process.exit(1);
  }

  const reached = new Set(Object.values(SETTLE_EGRESS).filter((verdict) => !verdict.startsWith(DISCLOSURE)));

  const measured = assertMeasured('publication-egress', [
    ['value imports', egress.imports.length],
    ['writing helpers', egress.writers.length],
    ['durable writes', egress.writes.length],
    ['publication surfaces reached', reached.size],
  ]);

  console.log(`publication-egress: ok — ${measured}`);

  for (const blind of BLIND_SPOTS) console.log(`  blind: ${blind}`);
}
