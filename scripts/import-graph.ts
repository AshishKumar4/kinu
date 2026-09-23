/**
 * The one module-graph walker: which files a file loads, resolved the way the
 * runtime resolves them.
 *
 * Extracted from `scripts/client-graph.ts`, which walked the browser entries
 * with a resolver of its own, so that the ladder's input-closure derivation
 * (`scripts/ladder-closure.ts`) reads the graph through the same edges and the
 * same resolution rather than a second walker that could disagree with the
 * first. Two walkers over one tree is the drift `gate:set-equality` exists to
 * refuse, one level up.
 *
 * Edges: `import … from`, `export … from`, `export * from`, literal `import()`,
 * literal `require()`, and literal `import.meta.resolve()`. Each edge carries
 * its kind — `value`, `type` (erased under `verbatimModuleSyntax`), or `text`
 * (Markdown imported `with { type: 'text' }`, data in Bun, esbuild and the Vite
 * prompt transform) — and the caller decides which kinds to follow. A dynamic
 * import over anything but a string literal is reported as COMPUTED rather than
 * dropped: a walker that drops it shrinks the graph in silence, which is what a
 * cache must never do.
 *
 * Resolution follows relative paths, tsconfig `paths` aliases from the nearest
 * governing tsconfig, and workspace package subpath maps. A workspace package
 * whose exports map is conditional (the vendored `packages/agent-core`) cannot
 * be entered and is returned as a PACKAGE so a caller can hash all of it. A
 * local specifier that names no file is UNRESOLVED, never a leaf.
 */

import * as v from 'valibot';
import { parseJsonc } from './jsonc';
import { isParseable } from './sources';
import { IMPORT_CANDIDATES, collapsePath, literalString, literalText, walk } from './syntax';
import type { Parsed, SyntaxNode } from './syntax';
import { workspaceGlobMatches } from './undeclared-imports';

export type EdgeKind = 'value' | 'type' | 'text';

export interface ModuleEdge {
  readonly specifier: string;
  readonly line: number;
  readonly kind: EdgeKind;
}

export interface ModuleEdges {
  readonly edges: readonly ModuleEdge[];
  /** Lines carrying an `import(expr)` or `require(expr)` over a non-literal. */
  readonly computed: readonly number[];
  /** Lines carrying `import.meta.resolve(expr)` over a non-literal: a path
   *  computed at runtime, which is a read by path rather than a module edge. */
  readonly resolvedByPath: readonly number[];
}

const attributeName = (attribute: { key: { type: string; name?: string; value?: unknown } }): string =>
  attribute.key.type === 'Identifier' ? attribute.key.name ?? '' : String(attribute.key.value);

/** A type-only import is erased; Markdown read `with { type: 'text' }` is data;
 *  everything else loads a module. */
function importEdgeKind(erased: boolean, asText: boolean): EdgeKind {
  if (erased) return 'type';

  return asText ? 'text' : 'value';
}

/** Every module reference in one parsed file, with its kind and line. */
export function moduleEdges(parsed: Parsed): ModuleEdges {
  const edges: ModuleEdge[] = [];
  const computed: number[] = [];
  const resolvedByPath: number[] = [];

  walk(parsed.root, (node: SyntaxNode) => {
    const { raw } = node;
    const line = parsed.lineAt(node.start);

    if (raw.type === 'ImportDeclaration') {
      const asText = raw.source.value.endsWith('.md')
        && raw.attributes.some((attribute) => attributeName(attribute) === 'type' && attribute.value.value === 'text');

      const kind = importEdgeKind(raw.importKind === 'type', asText);

      edges.push({ specifier: raw.source.value, line, kind });

      return;
    }

    if (raw.type === 'ExportNamedDeclaration' || raw.type === 'ExportAllDeclaration') {
      if (raw.source === null || raw.source === undefined) return;
      edges.push({ specifier: raw.source.value, line, kind: raw.exportKind === 'type' ? 'type' : 'value' });

      return;
    }

    if (raw.type === 'ImportExpression') {
      const literal = node.children.find((child) => child.raw.type === 'Literal');
      const source = literal === undefined ? undefined : literalText(literal);

      if (source === undefined || raw.source.type !== 'Literal') computed.push(line);
      else edges.push({ specifier: source, line, kind: 'value' });

      return;
    }

    if (raw.type !== 'CallExpression') return;
    const callee = raw.callee;

    const isRequire = callee.type === 'Identifier' && callee.name === 'require';

    const isMetaResolve = callee.type === 'MemberExpression' && !callee.computed
      && callee.property.type === 'Identifier' && callee.property.name === 'resolve'
      && callee.object.type === 'MetaProperty';

    if (!isRequire && !isMetaResolve) return;
    const [argument] = raw.arguments;
    const specifier = argument === undefined ? undefined : literalString(argument);

    if (specifier === undefined) {
      (isMetaResolve ? resolvedByPath : computed).push(line);

      return;
    }

    edges.push({ specifier, line, kind: 'value' });
  });

  return { edges, computed, resolvedByPath };
}

export interface PackageDir {
  /** Repo-relative directory with a trailing slash. */
  readonly directory: string;
  /** Subpath map; `undefined` when the manifest's map is conditional and the
   *  package cannot be entered file by file. */
  readonly exports: Readonly<Record<string, string>> | undefined;
  readonly main: string | undefined;
}

const FlatExports = v.record(v.string(), v.string());

const ManifestSchema = v.object({
  name: v.optional(v.string()),
  main: v.optional(v.string()),
  exports: v.optional(v.record(v.string(), v.unknown()), {}),
  workspaces: v.optional(v.array(v.string()), []),
});

/**
 * Workspace package dirs by name, read from the manifests the root's
 * `workspaces` globs claim. Never written down beside them: a renamed package
 * or a repointed subpath repoints every walker instead of silently misreading.
 */
export function readWorkspace(manifests: ReadonlyMap<string, string>): ReadonlyMap<string, PackageDir> {
  const rootText = manifests.get('package.json');

  if (rootText === undefined) throw new Error('import-graph: no root package.json in the corpus');
  const rootManifest = v.parse(ManifestSchema, JSON.parse(rootText));
  const out = new Map<string, PackageDir>();

  for (const [file, text] of manifests) {
    if (file === 'package.json' || !file.endsWith('/package.json')) continue;
    const directory = file.slice(0, -'package.json'.length);

    if (!rootManifest.workspaces.some((glob) => workspaceGlobMatches(glob, directory.slice(0, -1)))) continue;
    const parsed = v.parse(ManifestSchema, JSON.parse(text));

    if (parsed.name === undefined) continue;
    // A flat map is `{ '.': './x.ts' }`; a conditional one nests objects per
    // condition, which this resolver does not model and so does not enter.
    const flat = v.safeParse(FlatExports, parsed.exports);
    const exports = flat.success ? flat.output : undefined;

    out.set(parsed.name, { directory, exports, main: parsed.main });
  }

  return out;
}

export interface Alias {
  /** Directory (trailing slash, `''` for the root) whose files the alias governs. */
  readonly under: string;
  /** The specifier prefix before the pattern's `*`. */
  readonly prefix: string;
  /** Repo-relative replacement for that prefix. */
  readonly target: string;
}

const TsconfigSchema = v.object({
  compilerOptions: v.optional(v.object({
    paths: v.optional(v.record(v.string(), v.array(v.string())), {}),
  }), { paths: {} }),
});

/** Every `paths` alias a tracked tsconfig declares, keyed by the directory it
 *  governs, so `@/x` in cf-backend resolves through cf-backend's own file. */
export function readAliases(tsconfigs: ReadonlyMap<string, string>): readonly Alias[] {
  const aliases: Alias[] = [];

  for (const [file, text] of tsconfigs) {
    if (!file.endsWith('tsconfig.json')) continue;
    const under = file.slice(0, -'tsconfig.json'.length);
    const { compilerOptions } = parseJsonc(text, TsconfigSchema, file);

    for (const [pattern, targets] of Object.entries(compilerOptions.paths)) {
      const [target] = targets;

      if (target === undefined || !pattern.endsWith('*') || !target.endsWith('/*')) continue;
      aliases.push({ under, prefix: pattern.slice(0, -1), target: collapsePath(`${under}${target.slice(0, -1)}`) });
    }
  }

  return aliases.sort((a, b) => b.prefix.length - a.prefix.length);
}

/** Extensions that are data, never a module to walk, when the universe does
 *  not hold them. Markdown is deliberately absent: without `with { type:
 *  'text' }` a `.md` import is a module import of prose, and reporting it as
 *  data would hide the edge. */
const ASSET = /\.(css|json|svg|png|webp|woff2|wgsl)$/;

export type Resolution =
  /** Third-party code, a builtin, a scheme-qualified runtime, or a data asset
   *  outside the universe: nothing past it is this tree. */
  | { readonly kind: 'leaf' }
  /** A parseable file in the universe. */
  | { readonly kind: 'file'; readonly path: string }
  /** A file in the universe that is data, not a module: hashed, not walked. */
  | { readonly kind: 'asset'; readonly path: string }
  /** A workspace package the resolver cannot enter. */
  | { readonly kind: 'package'; readonly directory: string }
  /** A local specifier naming nothing the universe holds. */
  | { readonly kind: 'unresolved'; readonly why: string };

function found(path: string): Resolution {
  return isParseable(path) ? { kind: 'file', path } : { kind: 'asset', path };
}

/** One specifier to resolve, and the corpus it is resolved against. Strict
 *  resolution refuses what loose resolution is willing to call a leaf. */
export interface ResolutionRequest {
  readonly specifier: string;
  readonly from: string;
  readonly universe: ReadonlySet<string>;
  readonly workspace: ReadonlyMap<string, PackageDir>;
  readonly aliases: readonly Alias[];
  readonly strict?: boolean;
}

/** A declaration file answers a type-only import the way TypeScript resolves
 *  one (`./env` → `./env.d.ts`); no runtime import can name one, so it comes
 *  after every source candidate. */
const DECLARATION_CANDIDATE = '.d.ts';

function probe(base: string, request: ResolutionRequest): Resolution {
  const { from, specifier, universe, strict = false } = request;
  const collapsed = collapsePath(base);
  const candidate = [...IMPORT_CANDIDATES, DECLARATION_CANDIDATE].map((suffix) => collapsed + suffix).find((path) => universe.has(path));

  if (candidate !== undefined) return found(candidate);

  if (!strict && ASSET.test(collapsed)) return { kind: 'leaf' };

  return { kind: 'unresolved', why: `${from} names ${specifier}, which resolves to no parsed source` };
}

/** Resolve one specifier from one importing file. */
export function resolveSpecifier(request: ResolutionRequest): Resolution {
  const { specifier, from, workspace, aliases, universe, strict = false } = request;

  // A path into `node_modules` is a dependency: the lock stands for it, so it
  // is a leaf under both readings. A query or fragment is a bundler feature
  // the resolver does not model, and a closure must not guess at it.
  if (specifier.includes('/node_modules/')) return { kind: 'leaf' };

  if (specifier.includes('?') || specifier.includes('#')) {
    return strict
      ? { kind: 'unresolved', why: `${from} names ${specifier}, whose runtime resolution is not modeled` }
      : { kind: 'leaf' };
  }

  // An alias BEFORE the workspace branch: `@/` also starts with `@`, and
  // treating it as a package name drops the whole aliased subgraph as leaves.
  const alias = aliases.find((entry) => specifier.startsWith(entry.prefix) && from.startsWith(entry.under));

  if (alias !== undefined) return probe(`${alias.target}/${specifier.slice(alias.prefix.length)}`, request);

  if (specifier.startsWith('@') || (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':'))) {
    // A scoped name is two segments (`@kinu.run/core`); an unscoped one is
    // one. Splitting on the first slash turns the scope into the name and
    // every workspace lookup misses.
    const segments = specifier.split('/');
    const name = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0] ?? specifier;
    const rest = `.${specifier.slice(name.length)}`;
    const pkg = workspace.get(name);

    if (pkg === undefined) return { kind: 'leaf' };

    // A conditional exports map picks a file the resolver does not model, but
    // whichever it picks is under the package directory: the whole directory
    // is a sound over-approximation under both readings.
    if (pkg.exports === undefined) return { kind: 'package', directory: pkg.directory };
    const target = pkg.exports[rest] ?? (rest === '.' ? pkg.main : undefined);

    if (target === undefined) return { kind: 'unresolved', why: `${from} names ${specifier}, which is no subpath of ${name}` };
    const candidate = `${pkg.directory}${target.startsWith('./') ? target.slice(2) : target}`;

    if (!universe.has(candidate)) {
      return { kind: 'unresolved', why: `${from} names ${specifier}, which resolves to ${candidate} outside the corpus` };
    }

    return found(candidate);
  }

  if (strict && specifier.startsWith('/')) {
    return { kind: 'unresolved', why: `${from} imports an absolute path outside repository resolution: ${specifier}` };
  }

  if (!specifier.startsWith('.')) return { kind: 'leaf' };

  return probe(`${from.slice(0, from.lastIndexOf('/') + 1)}/${specifier}`, request);
}

/** Shared cycle-safe traversal. The visitor chooses whether an edge belongs
 * to a runtime graph or an input graph; resolution and traversal stay shared. */
export function walkModules(
  entries: readonly string[],
  visit: (file: string, chain: readonly string[]) => readonly { readonly path: string; readonly line: number }[],
): void {
  const seen = new Set<string>();
  const pending: { file: string; chain: readonly string[] }[] = entries.map((file) => ({ file, chain: [] })).reverse();

  while (pending.length > 0) {
    const next = pending.pop();

    if (next === undefined || seen.has(next.file)) continue;
    seen.add(next.file);
    const edges = visit(next.file, next.chain);

    for (const edge of [...edges].reverse()) {
      pending.push({ file: edge.path, chain: [...next.chain, `${next.file}:${String(edge.line)}`] });
    }
  }
}
