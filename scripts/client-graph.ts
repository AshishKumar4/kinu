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

import { assertMeasured } from './gate-ratchet';
import { moduleEdges, readAliases, readWorkspace, resolveSpecifier, walkModules } from './import-graph';
import type { Alias, ModuleEdge } from './import-graph';
import { isClientDocument, isManifest, readMatching, readRepositoryFile, readSources } from './sources';
import { parse } from './syntax';
import type { Parsed } from './syntax';

const root = new URL('..', import.meta.url).pathname;

const GATE = 'client-graph';

/** The browser entries, DERIVED from the html documents rather than listed:
 *  `index.html` is the signed-in app, `landing.html` the public landing (served
 *  at `/` for a visitor with no session), `gallery.html` the signed-in
 *  component gallery — and a fourth page joins the walk by existing. */
export async function clientEntries(documents: ReadonlyMap<string, string>): Promise<string[]> {
  const entries: string[] = [];

  for (const [file, text] of documents) {
    const directory = file.slice(0, file.lastIndexOf('/') + 1);
    const found: string[] = [];

    const rewriter = new HTMLRewriter().on('script[type="module"]', {
      element(element) {
        const src = element.getAttribute('src');

        if (src === null) throw new Error(`${GATE}: ${file} has an inline module the graph cannot resolve`);
        const url = new URL(src, 'https://client.invalid/');

        if (url.origin !== 'https://client.invalid') throw new Error(`${GATE}: ${file} has an external module the graph cannot resolve`);
        found.push(`${directory}${url.pathname.slice(1)}`);
      },
    });

    await rewriter.transform(new Response(text)).text();

    if (found.length === 0) {
      throw new Error(`${GATE}: ${file} declares no <script type="module"> — a page with no entry cannot be walked`);
    }

    entries.push(...found);
  }

  return entries.sort();
}

/** Specifiers no client-reachable module may load at runtime. */
function isForbidden(specifier: string): boolean {
  return specifier === '@agent-core/core'
    || specifier.startsWith('@agent-core/core/')
    || specifier === 'bun:sqlite';
}

/** Every runtime-carrying module reference in one file: value imports,
 *  value re-exports, and literal dynamic imports. `import type` and
 *  `export type` are erased under `verbatimModuleSyntax` and carry no edge;
 *  Markdown imported as text is data, not an executable edge through its
 *  contents — but an attribute on a forbidden package is no exemption. */
function runtimeEdges(parsed: Parsed): ModuleEdge[] {
  return moduleEdges(parsed).edges
    .filter((edge) => edge.kind === 'value' || (edge.kind === 'text' && isForbidden(edge.specifier)));
}

/** The `@/` alias cf-backend's own tsconfig declares, read from that file so
 *  a repointed alias repoints this gate instead of silently mis-resolving. */
function readCfAliases(): readonly Alias[] {
  const file = 'packages/cf-backend/tsconfig.json';
  const aliases = readAliases(new Map([[file, readRepositoryFile(root, file)]]));

  if (!aliases.some((alias) => alias.prefix === '@/')) {
    throw new Error(`${GATE}: ${file} declares no @/* path — the client alias cannot be resolved`);
  }

  return aliases;
}

export interface Violation {
  readonly chain: readonly string[];
  readonly specifier: string;
}

/** Walk the client graph. Returns one violation per distinct forbidden edge,
 *  each carrying the entry-to-edge chain that loads it. */
export function findViolations(sources: ReadonlyMap<string, string>, entries: readonly string[]): Violation[] {
  if (entries.length === 0) throw new Error(`${GATE}: no client entry — a gate that walks no entry cannot fail`);

  for (const entry of entries) {
    if (!sources.has(entry)) {
      throw new Error(`${GATE}: client entry ${entry} is not in the corpus — a gate that scans no entry cannot fail`);
    }
  }

  const universe = new Set(sources.keys());
  const workspace = readWorkspace(readMatching(isManifest));

  if (workspace.size === 0) throw new Error(`${GATE}: no workspace manifests in the corpus — a gate that resolves nothing cannot fail`);
  const aliases = readCfAliases();
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
  walkModules(entries, (file, chain) => {
    const paths: { path: string; line: number }[] = [];

    for (const edge of runtimeEdges(of(file))) {
      if (isForbidden(edge.specifier)) {
        violations.push({ chain: [...chain, `${file}:${edge.line}`], specifier: edge.specifier });
        continue;
      }

      const next = resolveSpecifier(edge.specifier, file, universe, workspace, aliases);

      // A LOCAL edge that names no file is FATAL rather than skipped: a
      // dropped local edge shrinks the graph in silence, which is exactly how
      // this defect class survived every gate.
      if (next.kind === 'unresolved') throw new Error(`${GATE}: ${next.why}`);

      // A package the resolver cannot enter is the vendored runtime, and every
      // specifier into it is forbidden above; an asset is data with no edge.
      if (next.kind === 'file') paths.push({ path: next.path, line: edge.line });
    }

    return paths;
  });

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
  const entries = await clientEntries(readMatching(isClientDocument));
  const violations = findViolations(sources, entries);

  // Zero violations is the PASSING state, so assertMeasured guards only the
  // denominators that must be non-empty for the walk to mean anything — an
  // empty universe or entry set would report a clean tree over nothing.
  const measured = assertMeasured(GATE, [
    ['client entries walked', entries.length],
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
