/**
 * Client-graph gate — the browser must never load the worker's runtime.
 *
 * On 2026-09-06 the root barrel gained four SQLite-backed slate stores whose
 * modules import the vendored `@agent-core/core` runtime. That runtime touches
 * `node:util` at module scope, so `bun run dev` served a client graph that
 * died before React mounted — while the production build stayed green by
 * tree-shaking the unreached exports, and every source-reading gate stayed
 * green by never reading the graph at all. Dev serves modules as written and
 * does not tree-shake, which is why only dev broke.
 *
 * So this gate reads the graph: from each client entry it follows every
 * value-carrying import — `import … from`, `export … from`, and literal
 * `import(…)` — through relative paths, the `@/` alias, and the workspace
 * subpath maps, and fails naming the full chain when any path reaches a
 * worker-only runtime module. `import type` and `export type` are erased under
 * `verbatimModuleSyntax` (compiler-enforced) and carry no runtime edge, so
 * they are not followed.
 */

import * as v from 'valibot';
import { assertMeasured } from './gate-ratchet';
import { isManifest, readMatching, readRepositoryFile, readSources } from './sources';
import { literalText, parse, walk } from './syntax';
import type { Parsed, SyntaxNode } from './syntax';

const root = new URL('..', import.meta.url).pathname;

const GATE = 'client-graph';

/** The three browser entries. `index.tsx` is the signed-in app, `landing.tsx`
 *  the public landing (served at `/` for a visitor with no session),
 *  `gallery.tsx` the signed-in component gallery. */
const ENTRIES: readonly string[] = [
  'packages/cf-backend/src/index.tsx',
  'packages/cf-backend/src/landing.tsx',
  'packages/cf-backend/src/gallery.tsx',
];

/** Specifiers no client-reachable module may load at runtime. */
function isForbidden(specifier: string): boolean {
  return specifier === '@agent-core/core'
    || specifier.startsWith('@agent-core/core/')
    || specifier === 'bun:sqlite';
}

interface Edge {
  readonly specifier: string;
  readonly line: number;
}

/** Every runtime-carrying module reference in one file: value imports,
 *  value re-exports, and literal dynamic imports. */
function runtimeEdges(parsed: Parsed): Edge[] {
  const edges: Edge[] = [];
  walk(parsed.root, (node: SyntaxNode) => {
    const raw = node.raw;

    if (raw.type === 'ImportDeclaration') {
      if (raw.importKind === 'type') return;
      edges.push({ specifier: raw.source.value, line: parsed.lineAt(node.start) });

      return;
    }

    if (raw.type === 'ExportNamedDeclaration' || raw.type === 'ExportAllDeclaration') {
      if (raw.exportKind === 'type' || raw.source === null || raw.source === undefined) return;
      edges.push({ specifier: raw.source.value, line: parsed.lineAt(node.start) });

      return;
    }

    if (raw.type === 'ImportExpression') {
      const source = literalText(node.children.find((child) => child.raw.type === 'Literal') ?? node);

      if (source !== undefined) edges.push({ specifier: source, line: parsed.lineAt(node.start) });
    }
  });

  return edges;
}

interface PackageDir {
  readonly directory: string;
  readonly exports: Readonly<Record<string, string>>;
  readonly main: string | undefined;
}

const ManifestSchema = v.object({
  name: v.optional(v.string()),
  main: v.optional(v.string()),
  exports: v.optional(v.record(v.string(), v.string()), {}),
});

/** Workspace package dirs by name, with the subpath maps that back them.
 *  Read from the manifests, never written down beside them: a renamed package
 *  or a repointed subpath repoints this gate instead of silently misreading.
 *  The vendored agent-core runtime is out — its exports map carries per-condition
 *  objects this string schema rejects, and it needs no resolution anyway: its
 *  specifiers are forbidden edges, never walk targets. */
function readWorkspace(): ReadonlyMap<string, PackageDir> {
  const out = new Map<string, PackageDir>();

  for (const [file, text] of readMatching(isManifest)) {
    const segments = file.split('/');

    if (segments.length !== 3 || segments[0] !== 'packages' || !file.endsWith('/package.json')) continue;

    if (file.startsWith('packages/agent-core/')) continue;
    const parsed = v.parse(ManifestSchema, JSON.parse(text));

    if (parsed.name === undefined || !parsed.name.startsWith('@')) continue;
    out.set(parsed.name, { directory: file.slice(0, -'package.json'.length), exports: parsed.exports, main: parsed.main });
  }

  if (out.size === 0) throw new Error(`${GATE}: no workspace manifests in the corpus — a gate that resolves nothing cannot fail`);

  return out;
}

const TsconfigSchema = v.object({
  compilerOptions: v.optional(v.object({
    paths: v.optional(v.record(v.string(), v.array(v.string()))),
  })),
});

/** The `@/` prefix cf-backend's own tsconfig declares, read from that file so
 *  a repointed alias repoints this gate instead of silently mis-resolving. */
function readCfAlias(): string {
  const file = 'packages/cf-backend/tsconfig.json';
  const parsed = v.parse(TsconfigSchema, JSON.parse(readRepositoryFile(root, file)));
  const target = parsed.compilerOptions?.paths?.['@/*']?.[0];

  if (target === undefined || !target.endsWith('/*')) {
    throw new Error(`${GATE}: ${file} declares no @/* path — the client alias cannot be resolved`);
  }

  return `packages/cf-backend/${target.slice(0, -1)}`;
}

const CANDIDATES: readonly string[] = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

/** A specifier this gate does not follow: third-party code, assets, and
 *  scheme-qualified runtimes are leaves — nothing past them is this tree. */
type Resolved = { readonly kind: 'leaf' } | { readonly kind: 'file'; readonly path: string };

function collapse(base: string): string {
  return base.split('/').reduce((parts: string[], part) => {
    if (part === '..') parts.pop();
    else if (part !== '.' && part !== '') parts.push(part);

    return parts;
  }, []).join('/');
}

/** A relative-or-aliased base path to a corpus file, or undefined for a stylesheet,
 *  image, font, or data asset — leaves with no runtime edge. A non-asset that
 *  resolves to nothing is FATAL rather than skipped: a dropped local edge
 *  shrinks the graph in silence, which is exactly how this defect class
 *  survived every gate. */
function probe(base: string, from: string, specifier: string, universe: ReadonlySet<string>): string | undefined {
  const collapsed = collapse(base);

  if (collapsed.endsWith('.css') || collapsed.endsWith('.json') || collapsed.endsWith('.svg')
    || collapsed.endsWith('.png') || collapsed.endsWith('.webp') || collapsed.endsWith('.woff2')) {
    return undefined;
  }

  const candidate = CANDIDATES.map((suffix) => collapsed + suffix).find((path) => universe.has(path));

  if (candidate === undefined) {
    throw new Error(`${GATE}: ${from} names ${specifier}, which resolves to no parsed source`);
  }

  return candidate;
}

/** Resolve a specifier from one importing file. A LOCAL edge — relative, the
 *  `@/` alias, or a workspace package — that names no file in the corpus is
 *  FATAL rather than skipped: a dropped local edge shrinks the graph in
 *  silence, which is exactly how this defect class survived every gate. */
function resolve(
  specifier: string,
  from: string,
  universe: ReadonlySet<string>,
  workspace: ReadonlyMap<string, PackageDir>,
  cfAlias: string,
): Resolved {
  if (specifier.includes('?') || specifier.includes('#')) return { kind: 'leaf' };

  if (specifier.includes('/node_modules/')) return { kind: 'leaf' };

  // The `@/` alias BEFORE the workspace branch: it also starts with `@`, and
  // treating it as a package name drops the whole aliased subgraph as leaves.
  if (specifier.startsWith('@/')) {
    const path = probe(cfAlias + specifier.slice(2), from, specifier, universe);

    if (path === undefined) return { kind: 'leaf' };

    return { kind: 'file', path };
  }

  if (specifier.startsWith('@') || specifier.startsWith('#')) {
    // A scoped name is two segments (`@kinu.run/core`); an unscoped one is
    // one. Splitting on the first slash turns the scope into the name and
    // every workspace lookup misses — the gate goes green over the poison.
    const segments = specifier.split('/');
    const name = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0] ?? specifier;
    const rest = `.${specifier.slice(name.length)}`;
    const pkg = workspace.get(name);

    if (pkg === undefined) return { kind: 'leaf' };
    const target = pkg.exports[rest] ?? (rest === '.' ? pkg.main : undefined);

    if (target === undefined) {
      throw new Error(`${GATE}: ${from} names ${specifier}, which is no subpath of ${name}`);
    }

    const candidate = `${pkg.directory}${target.startsWith('./') ? target.slice(2) : target}`;

    if (!universe.has(candidate)) {
      throw new Error(`${GATE}: ${from} names ${specifier}, which resolves to ${candidate} outside the corpus`);
    }

    return { kind: 'file', path: candidate };
  }

  if (!specifier.startsWith('.')) return { kind: 'leaf' };
  const path = probe(`${from.slice(0, from.lastIndexOf('/') + 1)}/${specifier}`, from, specifier, universe);

  if (path === undefined) return { kind: 'leaf' };

  return { kind: 'file', path };
}

export interface Violation {
  readonly chain: readonly string[];
  readonly specifier: string;
}

/** Walk the client graph. Returns one violation per distinct forbidden edge,
 *  each carrying the entry-to-edge chain that loads it. */
export function findViolations(sources: ReadonlyMap<string, string>): Violation[] {
  for (const entry of ENTRIES) {
    if (!sources.has(entry)) {
      throw new Error(`${GATE}: client entry ${entry} is not in the corpus — a gate that scans no entry cannot fail`);
    }
  }

  const universe = new Set(sources.keys());
  const workspace = readWorkspace();
  const cfAlias = readCfAlias();
  const parsed = new Map<string, Parsed>();

  const of = (file: string): Parsed => {
    const text = sources.get(file);

    if (text === undefined) throw new Error(`${GATE}: ${file} left the corpus mid-walk`);
    let tree = parsed.get(file);

    if (tree === undefined) {
      tree = parse(file, text);
      parsed.set(file, tree);
    }

    return tree;
  };

  const violations: Violation[] = [];
  const seen = new Set<string>();

  const visit = (file: string, chain: readonly string[]): void => {
    for (const edge of runtimeEdges(of(file))) {
      if (isForbidden(edge.specifier)) {
        violations.push({ chain: [...chain, `${file}:${edge.line}`], specifier: edge.specifier });
        continue;
      }

      const next = resolve(edge.specifier, file, universe, workspace, cfAlias);

      if (next.kind === 'leaf' || seen.has(next.path)) continue;
      seen.add(next.path);
      visit(next.path, [...chain, `${file}:${edge.line}`]);
    }
  };

  for (const entry of ENTRIES) {
    seen.add(entry);
    visit(entry, []);
  }

  return violations.sort((a, b) => a.specifier.localeCompare(b.specifier)
    || a.chain.join('').localeCompare(b.chain.join('')));
}

/**
 * What this gate cannot see, printed on the GREEN path. A limitation visible
 * only in red output is invisible exactly when the tree is clean, which is
 * when somebody decides how far to trust the signal.
 */
export const BLIND_SPOTS: readonly string[] = [
  'A COMPUTED SPECIFIER — NOT FOLLOWED. `await import(name)` over a variable names '
  + 'its module where no literal carries it, so a worker-only runtime reached only '
  + 'through a computed import reads as absent.',
  'A BROWSER IMPORT OF A NODE BUILTIN BY NAME — NOT GOVERNED. Only the two worker-only '
  + 'runtimes this edge shipped (`@agent-core/core`, `bun:sqlite`) are forbidden; a '
  + 'direct `node:util` import in client code would break dev the same way through a '
  + 'different edge this gate does not name.',
  'A RESOLUTION VITE SEES AND THIS GATE DOES NOT — NOT MODELED. The walk follows '
  + 'relative paths, the `@/` alias, and workspace subpath maps; a Vite `resolve.alias`, '
  + 'an `optimizeDeps` include, or a plugin virtual module that pulls a worker-only '
  + 'module into the client graph is invisible to it.',
];

if (import.meta.main) {
  const sources = readSources();
  const violations = findViolations(sources);

  // Zero violations is the PASSING state, so assertMeasured guards only the
  // denominators that must be non-empty for the walk to mean anything — an
  // empty universe or entry set would report a clean tree over nothing.
  const measured = assertMeasured(GATE, [
    ['client entries walked', ENTRIES.length],
    ['product source files in the resolution universe', sources.size],
  ]);

  if (violations.length > 0) {
    console.error(`${GATE}: ${violations.length} client-reachable worker-only edge(s) over ${measured}\n`);

    for (const violation of violations) {
      console.error(`  must:      no client entry loads a worker-only runtime module`);
      console.error(`  found:     ${violation.specifier}`);

      for (const link of violation.chain) console.error(`    via:     ${link}`);
      console.error(`  silently:  dev serves the graph as written and dies before mount, `
        + `while the build tree-shakes it green`);
      console.error(`  fix:       move the worker-only module behind a worker-imported subpath\n`);
    }

    process.exit(1);
  }

  console.log(`${GATE}: ok — ${measured}, no client path reaches @agent-core/core or bun:sqlite`);

  for (const spot of BLIND_SPOTS) console.log(`  blind: ${spot}`);
}
