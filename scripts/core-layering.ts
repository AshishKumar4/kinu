/**
 * Core layering gate — `packages/core` is three layers, and imports point down.
 *
 * Measured 2026-09-10: 40 of core's 42 source directories form ONE strongly
 * connected component. Only `obs` and `checkpoints` sit outside the cycle.
 * `types/` imports a dozen feature directories, `state/agent-stores.ts`
 * constructs every feature's store, `vfs/context-plane.ts` is orchestrator
 * logic, and `identity/workspace-schema.ts` (since moved to `state/`) assembled DDL from `evolution`,
 * `mcts`, `strategy` and `tools`. None of that is inseparable design; it is
 * misplaced files. But a package split cannot start while it stands, and
 * nothing today refuses one more upward import.
 *
 * So the layers are declared here, every import that points UP is a finding,
 * and today's findings are locked so the set can only shrink. Type-only
 * imports count: a package boundary needs its contract types below it just as
 * much as its runtime, so they are keyed apart and reported apart, because
 * they are the cheap half of the debt.
 */

import { assertMeasured, reconcile, report, writeLock } from './gate-ratchet';
import { collapsePath, IMPORT_CANDIDATES, parse, walk } from './syntax';
import type { Parsed, SyntaxNode } from './syntax';
import { isParseable, isTestFile, readMatching } from './sources';

const root = new URL('..', import.meta.url).pathname;

const GATE = 'core-layering';

const LOCK = `${root}scripts/core-layering.lock.json`;

const CORE = 'packages/core/src/';

/** Platform owns the workspace, its files, its executors, its events and its
 *  model providers; tools are the model-facing surface over the platform; the
 *  harness is Kinu's own loop and everything that exists only to drive it.
 *  A directory absent here is the harness: a new feature directory is harness
 *  until somebody argues it down a layer. */
export const LAYERS: ReadonlyMap<string, 0 | 1 | 2> = new Map<string, 0 | 1 | 2>([
  ['obs', 0], ['utils', 0], ['types', 0], ['checkpoints', 0], ['credentials', 0], ['providers', 0],
  ['config', 0], ['identity', 0], ['vfs', 0], ['execution', 0], ['events', 0], ['memory', 0],
  ['safety', 0], ['slates', 0],
  ['tools', 1], ['craft', 1], ['web', 1],
  // Root files, by name: the six primitives and their accounting are platform,
  // the loop's assembly is harness. A root file absent here is harness.
  ['platform-catalog.ts', 0], ['usage.ts', 0], ['llm.ts', 0], ['config.ts', 0], ['cloud-wire.ts', 0],
  ['context-budget.ts', 0], ['context-meter.ts', 0], ['context-window.ts', 0], ['turn-failure.ts', 0],
  ['mission-budget.ts', 0],
]);

export const LAYER_NAMES: readonly string[] = ['platform', 'tools', 'harness'];

export function layerOf(file: string): 0 | 1 | 2 {
  const rel = file.slice(CORE.length);

  return LAYERS.get(rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : rel) ?? 2;
}

export interface Edge {
  readonly specifier: string;
  readonly line: number;
  readonly typeOnly: boolean;
}

/** Every module reference in one file. Only a declaration-level `import type`
 *  or `export type` is erased under `verbatimModuleSyntax`; `import { type X }`
 *  emits `import {} from` and still loads the module, so it is a value edge. */
export function edgesOf(parsed: Parsed): Edge[] {
  const edges: Edge[] = [];
  walk(parsed.root, (node: SyntaxNode) => {
    const raw = node.raw;

    if (raw.type === 'ImportDeclaration') {
      edges.push({ specifier: raw.source.value, line: parsed.lineAt(node.start), typeOnly: raw.importKind === 'type' });
    } else if ((raw.type === 'ExportNamedDeclaration' || raw.type === 'ExportAllDeclaration') && raw.source) {
      edges.push({ specifier: raw.source.value, line: parsed.lineAt(node.start), typeOnly: raw.exportKind === 'type' });
    }
  });

  return edges;
}

/** A relative specifier resolved inside core, or undefined for anything that
 *  leaves the package. A relative edge naming no corpus file is FATAL: a
 *  dropped edge shrinks the graph in silence. */
function resolveLocal(specifier: string, from: string, universe: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = collapsePath(`${from.slice(0, from.lastIndexOf('/'))}/${specifier}`);

  for (const suffix of IMPORT_CANDIDATES) {
    const candidate = `${base}${suffix}`;

    if (universe.has(candidate)) return candidate;
  }

  throw new Error(`${GATE}: ${from} imports ${specifier}, which names no file in the corpus`);
}

export interface Violation {
  readonly from: string;
  readonly to: string;
  readonly line: number;
  readonly typeOnly: boolean;
}

export function findViolations(sources: ReadonlyMap<string, string>): Violation[] {
  const universe = new Set(sources.keys());
  const violations: Violation[] = [];

  for (const [file, text] of sources) {
    const fromLayer = layerOf(file);

    for (const edge of edgesOf(parse(file, text))) {
      const to = resolveLocal(edge.specifier, file, universe);

      if (to === undefined || layerOf(to) <= fromLayer) continue;
      violations.push({ from: file, to, line: edge.line, typeOnly: edge.typeOnly });
    }
  }

  return violations.sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line);
}

/** Keyed without the line, so an unrelated edit above an import does not read
 *  as new debt; keyed with the kind, so narrowing a value import to a type
 *  import is progress the lock records. */
export const keyOf = (v: Violation): string =>
  `${v.from} -> ${v.to} (${v.typeOnly ? 'type' : 'value'})`;

export const BLIND_SPOTS: readonly string[] = [
  'CROSS-PACKAGE EDGES — OUT OF SCOPE. A core file importing `@kinu.run/compaction` or a '
  + 'backend importing a core internal is a manifest question, owned by `gate:undeclared-imports`.',
  'THE LAYER MAP IS AN ASSERTION. A directory listed at the wrong layer makes every edge '
  + 'into it read right or wrong by declaration; the map is the thing to review, not the count.',
  'DYNAMIC IMPORTS — NOT READ. `import(…)` is deliberate laziness here and a literal one '
  + 'still crosses a layer; it is not counted until a boundary is a package boundary.',
];

if (import.meta.main) {
  const sources = readMatching((file) => isParseable(file) && file.startsWith(CORE) && !isTestFile(file));
  const violations = findViolations(sources);

  const measured = assertMeasured(GATE, [
    ['core source files parsed', sources.size],
    ['layers declared', LAYER_NAMES.length],
    ['directories and root files assigned below the harness', LAYERS.size],
  ]);

  const detail = new Map(violations.map((v) => [keyOf(v), [
    `  ${v.from}:${String(v.line)}`,
    `    must:      ${LAYER_NAMES[layerOf(v.from)]} imports nothing from ${LAYER_NAMES[layerOf(v.to)]}`,
    `    found:     ${v.typeOnly ? 'type-only' : 'value'} import of ${v.to}`,
    `    silently:  the file is fenced into one package with the thing it imports`,
    `    fix:       ${v.typeOnly ? 'move the contract type down a layer' : 'move the file up, or the dependency down'}`,
  ].join('\n')]));

  const keys = [...detail.keys()];

  if (process.argv.includes('--lock')) {
    console.log(`${GATE}: locked ${String(writeLock(keys, LOCK))} upward edge(s) over ${measured}`);
    process.exit(0);
  }

  const code = report(GATE, reconcile(keys, LOCK), detail, 'bun scripts/core-layering.ts --lock', measured);

  if (code === 0) {
    const types = violations.filter((v) => v.typeOnly).length;
    console.log(`  ${String(keys.length)} locked upward edge(s): ${String(types)} type-only, ${String(keys.length - types)} value`);

    for (const spot of BLIND_SPOTS) console.log(`  blind: ${spot}`);
  }

  process.exit(code);
}
