/**
 * The deployed Worker graph that `nested-container-resolution.test.ts` measures: every module the entry points reach,
 * walked with esbuild as the resolver (the probe's header says why). It runs in a process of its own, which the test
 * awaits. esbuild's stop() only signals its service children and resolves at once, so a test that walked in-process
 * could not await their exit, and under the 2026-09-24 sweep's load the leftover-process check failed the file.
 */

import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, extname, join, relative } from 'node:path';

import { build, stop, transformSync, type Loader, type PluginBuild } from 'esbuild';
import * as v from 'valibot';

import { SLATE_VENDOR_ID } from '../packages/cf-backend/slate-vendor';
import { identifierCalleeName, moduleSpecifiers, parse, stringArguments, walk } from './syntax';

const REPO_ROOT = join(import.meta.dir, '..');

/** Extension to esbuild loader, for the files that can carry an import. A file
 *  with any other extension is a leaf: `.json`, `.css` and `.wasm` name no
 *  module. Inferred and validated with `satisfies` rather than annotated open,
 *  so the key set stays type evidence the guard below can narrow against. */
const LOADERS = {
  '.ts': 'ts', '.tsx': 'tsx', '.mts': 'ts', '.cts': 'ts',
  '.js': 'jsx', '.jsx': 'jsx', '.mjs': 'jsx', '.cjs': 'jsx',
} satisfies Record<string, Loader>;

type ModuleExtension = keyof typeof LOADERS;

/** Narrows an arbitrary extension to a key of {@link LOADERS}, so indexing it
 *  needs no assertion. */
const isModuleExtension = (extension: string): extension is ModuleExtension =>
  Object.hasOwn(LOADERS, extension);

const BUILTINS: ReadonlySet<string> = new Set(builtinModules);

/** Specifiers the runtime supplies rather than the graph. `cloudflare:` and
 *  `bun:` are runtime namespaces, and a bare Node builtin reaches workerd
 *  through `nodejs_compat`. */
function isRuntimeProvided(specifier: string): boolean {
  return specifier.startsWith('cloudflare:')
    || specifier.startsWith('node:')
    || specifier.startsWith('bun:')
    || BUILTINS.has(specifier);
}

/** One import edge, with the syntax it was written in. The kind is what decides
 *  a package's `exports` branch, so a `require` edge must not be resolved as an
 *  `import` edge. */
interface Edge {
  readonly specifier: string;
  readonly kind: 'import-statement' | 'require-call';
}

/** An import the resolver refused, named by both ends. */
const UnresolvedSchema = v.object({
  /** Repository-relative path of the file holding the specifier. */
  file: v.string(),
  specifier: v.string(),
  reason: v.string(),
});

type Unresolved = v.InferOutput<typeof UnresolvedSchema>;

/**
 * How esbuild reports a file it could not read. Its `message` is only the
 * summary line, `Transform failed with 1 error:`, and the position lives in
 * `errors[].location`. A reason built from `message` alone names the file and
 * hides the line, which is the difference between a fail-closed report someone
 * can act on and one they have to reproduce. Narrowed with a schema rather than
 * asserted: a thrown value is whatever the thrower chose.
 */
const TransformFailureSchema = v.object({
  errors: v.array(v.object({
    text: v.string(),
    location: v.nullish(v.object({ line: v.number(), column: v.number() })),
  })),
});

const DeployedGraphSchema = v.object({
  /** Repository-relative entry points, from the deployed wrangler configs. */
  entries: v.array(v.string()),
  /** Absolute path of every module the resolver reached. */
  modules: v.array(v.string()),
  /** Every specifier the resolver refused. */
  unresolved: v.array(UnresolvedSchema),
  /** Files the graph reached and could not read as a module. Reported rather
   *  than swallowed: an unreadable file is a hole in the measurement. */
  unreadable: v.array(UnresolvedSchema),
});

export type DeployedGraph = v.InferOutput<typeof DeployedGraphSchema>;

/**
 * Every module `source` imports, as written. TypeScript is lowered first because
 * a type-only import names a module the artifact never loads, and esbuild's own
 * transform is what decides that on the deploy path. `require` calls are
 * collected too: a CommonJS dependency in the graph still has edges, and a walk
 * that dropped them would under-report which copies ship.
 */
function importEdges(file: string, source: string, loader: Loader): readonly Edge[] {
  const lowered = transformSync(source, { loader, jsx: 'automatic', format: 'esm' }).code;
  const parsed = parse(`${file}.lowered.ts`, lowered);
  const edges = new Map<string, Edge>();

  for (const specifier of moduleSpecifiers(parsed.root)) {
    edges.set(specifier, { specifier, kind: 'import-statement' });
  }

  walk(parsed.root, (node) => {
    if (identifierCalleeName(node) !== 'require') return;

    for (const specifier of stringArguments(node)) {
      if (!edges.has(specifier)) edges.set(specifier, { specifier, kind: 'require-call' });
    }
  });

  return [...edges.values()];
}

/**
 * Walk the deployed graph, resolving every edge with the bundler that emits the
 * artifact. esbuild is used as a resolver only: the traversal is a worklist here
 * so that no linking happens and no unrelated export-shape error can suppress
 * the result.
 */
async function walkDeployedGraph(entries: readonly string[]): Promise<DeployedGraph> {
  const visited = new Set<string>();
  const unresolved: Unresolved[] = [];
  const unreadable: Unresolved[] = [];

  const traverse = async (resolver: PluginBuild): Promise<void> => {
    const queue = entries.map((entry) => join(REPO_ROOT, entry));

    while (queue.length > 0) {
      const file = queue.pop() ?? '';

      if (visited.has(file)) continue;
      visited.add(file);
      const extension = extname(file);

      if (!isModuleExtension(extension)) continue;
      const loader: Loader = LOADERS[extension];
      let edges: readonly Edge[];

      try {
        edges = importEdges(file, readFileSync(file, 'utf8'), loader);
      } catch (error) {
        const failure = v.safeParse(TransformFailureSchema, error);

        const located = failure.success
          ? failure.output.errors.map((one) => (one.location === null || one.location === undefined
            ? one.text
            : `${String(one.location.line)}:${String(one.location.column)}: ${one.text}`))
          : [];

        const thrown = error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error);

        unreadable.push({
          file: relative(REPO_ROOT, file),
          specifier: '',
          reason: located.length > 0 ? located.join('; ') : thrown,
        });
        continue;
      }

      for (const edge of edges) {
        if (isRuntimeProvided(edge.specifier)) continue;

        const found = await resolver.resolve(edge.specifier, {
          resolveDir: dirname(file), kind: edge.kind,
        });

        if (found.errors.length > 0 || found.path === '') {
          unresolved.push({
            file: relative(REPO_ROOT, file),
            specifier: edge.specifier,
            reason: found.errors[0]?.text ?? 'the resolver returned no path',
          });
          continue;
        }

        if (!found.external) queue.push(found.path);
      }
    }
  };

  await build({
    stdin: { contents: "import 'kinu-graph-root';", resolveDir: REPO_ROOT },
    absWorkingDir: REPO_ROOT,
    bundle: true, write: false, logLevel: 'silent',
    platform: 'browser', mainFields: ['module', 'main'],
    conditions: ['workerd', 'worker', 'browser'],
    plugins: [{
      name: 'kinu-graph',
      setup(resolver) {
        // No `u` flag: esbuild compiles a plugin filter with Go's regexp
        // engine, which rejects the `(?u)` prefix JavaScript adds for it.
        resolver.onResolve({ filter: /^kinu-graph-root$/ }, () => ({
          path: 'root', namespace: 'kinu-graph',
        }));
        // The slate vendor module is generated by a Vite plugin from the
        // installed React and capnweb bytes: data with no imports. The walk
        // records it as a leaf, the way a `.json` file is, so the artifact's
        // graph reads as Vite emits it.
        resolver.onResolve({ filter: new RegExp(`^${SLATE_VENDOR_ID}$`) }, () => ({
          path: SLATE_VENDOR_ID, namespace: 'kinu-vite-virtual',
        }));
        resolver.onLoad({ filter: /.*/, namespace: 'kinu-graph' }, async () => {
          await traverse(resolver);

          return { contents: '', loader: 'js' };
        });
      },
    }],
  });

  return {
    entries: [...entries],
    modules: [...visited].sort(),
    unresolved,
    unreadable,
  };
}

/** The graph `entries` reach, walked by this file in a process of its own. */
export async function readDeployedGraph(entries: readonly string[]): Promise<DeployedGraph> {
  const walker = Bun.spawn([process.execPath, import.meta.path, ...entries], { stdout: 'pipe', stderr: 'inherit' });
  const [text, code] = await Promise.all([new Response(walker.stdout).text(), walker.exited]);

  if (code !== 0) throw new Error(`walking the deployed graph (${import.meta.path}) exited with ${String(code)}`);

  return v.parse(v.pipe(v.string(), v.parseJson(), DeployedGraphSchema), text);
}

if (import.meta.main) {
  const graph = await walkDeployedGraph(process.argv.slice(2));

  await stop();
  process.stdout.write(JSON.stringify(graph));
}
