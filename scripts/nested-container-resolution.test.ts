/**
 * Which `@cloudflare/containers` runtime the deployed Worker artifact binds, and
 * whether every import specifier in that artifact's module graph resolves.
 *
 * KINU-087 asked two questions and could answer neither from the lockfile. The
 * lock holds two resolutions of the same package:
 *
 *     @cloudflare/containers                        0.3.7   direct dependency
 *     @cloudflare/sandbox/@cloudflare/containers     0.3.6   nested dependency
 *
 * A lock entry is not an artifact. Which copy ships is decided by the resolver
 * that produces the bundle, and the emitted JavaScript of both copies imports
 * with EXTENSIONLESS relative specifiers (`export ... from './lib/container'`),
 * which plain Node ESM rejects and a bundler accepts. So "two versions are
 * installed" and "the artifact is broken" are different claims, and only a
 * measurement over the real graph separates them.
 *
 * THE MEASUREMENT. This probe walks the deployed Worker's module graph with
 * esbuild as the resolver, which is the resolver wrangler builds the artifact
 * with. Nothing here is a second implementation of module resolution, and
 * nothing here is a hand-written version literal: the entry point comes from
 * `wrangler.jsonc`, every edge comes from `esbuild.transform` plus the
 * repository's own `syntax.ts` reader, every resolution comes from esbuild, and
 * every version comes from the resolved package's own manifest.
 *
 * The walk owns the traversal instead of letting esbuild link the graph, for one
 * reason: a linker also reports export-shape errors, and an export-shape error
 * yields no metafile. This probe judges RESOLUTION. A half-finished edit in an
 * unrelated file must not be able to make it say nothing.
 *
 * WHAT THIS PROBE CANNOT SEE. The product runs a container image pinned by
 * registry digest in `packages/cf-backend/wrangler.jsonc`
 * (`docker.io/cloudflare/sandbox@sha256:...`). That image is published by
 * Cloudflare and is not built from this tree, so no repository state decides
 * what its own Node loads, and no local build can decide it either. The Worker
 * side is decided here in full.
 */

import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';

import { transformSync, build, type Loader, type PluginBuild } from 'esbuild';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

import { assertMeasured, finding } from './gate-ratchet';
import { parseJsonc } from './jsonc';
import {
  identifierCalleeName, moduleSpecifiers, parse, stringArguments, walk,
} from './syntax';
import { isParseable, trackedFiles } from './sources';

const REPO_ROOT = join(import.meta.dir, '..');

/** The package this probe is about. A name, never a version: every version in
 *  this file is read from a resolved manifest. */
const CONTAINERS = '@cloudflare/containers';

/** A deployed Worker config: `packages/<name>/wrangler.jsonc`. Bench and probe
 *  fixtures live under `bench/` and `scripts/fixtures/`, and neither ships. */
const DEPLOYED_CONFIG = /^packages\/[^/]+\/wrangler\.jsonc$/;

/** A workspace manifest, which is where a direct dependency is pinned. */
const WORKSPACE_MANIFEST = /^packages\/[^/]+\/package\.json$/;

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

/* ── The graph ──────────────────────────────────────────────────────────── */

/** One import edge, with the syntax it was written in. The kind is what decides
 *  a package's `exports` branch, so a `require` edge must not be resolved as an
 *  `import` edge. */
interface Edge {
  readonly specifier: string;
  readonly kind: 'import-statement' | 'require-call';
}

/** An import the resolver refused, named by both ends. */
export interface Unresolved {
  /** Repository-relative path of the file holding the specifier. */
  readonly file: string;
  readonly specifier: string;
  readonly reason: string;
}

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

export interface DeployedGraph {
  /** Repository-relative entry points, from the deployed wrangler configs. */
  readonly entries: readonly string[];
  /** Absolute path of every module the resolver reached. */
  readonly modules: readonly string[];
  /** Every specifier the resolver refused. */
  readonly unresolved: readonly Unresolved[];
  /** Files the graph reached and could not read as a module. Reported rather
   *  than swallowed: an unreadable file is a hole in the measurement. */
  readonly unreadable: readonly Unresolved[];
}

const ContainerSchema = v.object({
  class_name: v.optional(v.string()),
  image: v.optional(v.string()),
});

const DeployedConfigSchema = v.object({
  main: v.string(),
  containers: v.optional(v.array(ContainerSchema)),
  env: v.optional(v.record(v.string(), v.object({
    containers: v.optional(v.array(ContainerSchema)),
  }))),
});

/** One container a deployed config binds, and where the config binds it. */
export interface ContainerBinding {
  /** `top level`, or `env.<name>` for an environment override. */
  readonly where: string;
  readonly className: string;
  /** The `image` field verbatim: a registry reference, or a path this tree
   *  builds. */
  readonly image: string;
}

export interface DeployedConfig {
  /** Repository-relative config path. */
  readonly file: string;
  /** Repository-relative Worker entry point. */
  readonly entry: string;
  /** Every container the config binds, at the top level and per environment. */
  readonly containers: readonly ContainerBinding[];
}

/**
 * What this repository deploys, read from the configs that deploy it. Every
 * environment is read as well as the top level: an environment override is a
 * different deployment of the same entry point, and a container declared only
 * there is still a container this tree ships.
 */
export function deployedConfigs(
  files: readonly string[] = trackedFiles(),
): readonly DeployedConfig[] {
  return files.filter((file) => DEPLOYED_CONFIG.test(file)).map((file) => {
    const config = parseJsonc(
      readFileSync(join(REPO_ROOT, file), 'utf8'), DeployedConfigSchema, file,
    );
    const blocks: readonly (readonly [string, readonly v.InferOutput<typeof ContainerSchema>[]])[] = [
      ['top level', config.containers ?? []],
      ...Object.entries(config.env ?? {}).map(
        ([name, block]) => [`env.${name}`, block.containers ?? []] as const,
      ),
    ];
    return {
      file,
      entry: join(dirname(file), config.main),
      containers: blocks.flatMap(([where, declared]) => declared.map((container) => ({
        where,
        className: container.class_name ?? 'no class_name',
        image: container.image ?? 'no image',
      }))),
    };
  });
}

/**
 * Every module `source` imports, as written. TypeScript is lowered first because
 * a type-only import names a module the artifact never loads, and esbuild's own
 * transform is what decides that on the deploy path. `require` calls are
 * collected too: a CommonJS dependency in the graph still has edges, and a walk
 * that dropped them would under-report which copies ship.
 */
export function importEdges(file: string, source: string, loader: Loader): readonly Edge[] {
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
export async function deployedGraph(
  configs: readonly DeployedConfig[] = deployedConfigs(),
): Promise<DeployedGraph> {
  const entries = configs.map((config) => config.entry);
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
        unreadable.push({
          file: relative(REPO_ROOT, file),
          specifier: '',
          reason: located.length > 0
            ? located.join('; ')
            : (error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)),
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
        resolver.onLoad({ filter: /.*/, namespace: 'kinu-graph' }, async () => {
          await traverse(resolver);
          return { contents: '', loader: 'js' };
        });
      },
    }],
  });

  return {
    entries,
    modules: [...visited].sort(),
    unresolved,
    unreadable,
  };
}

/* ── The copies ─────────────────────────────────────────────────────────── */

/** One installed copy of a package that the artifact binds. */
export interface PackageCopy {
  /** Repository-relative directory of the copy. */
  readonly dir: string;
  readonly version: string;
  /** Repository-relative directory of the package that owns the nesting, or
   *  undefined for a top-level copy. */
  readonly parent: string | undefined;
  /** Repository-relative module paths of this copy that the graph reached. */
  readonly modules: readonly string[];
}

const ManifestSchema = v.object({
  name: v.optional(v.string()),
  version: v.optional(v.string()),
  dependencies: v.optional(v.record(v.string(), v.string())),
});

type Manifest = v.InferOutput<typeof ManifestSchema>;

function readManifest(dir: string): Manifest {
  return v.parse(ManifestSchema, JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')));
}

/** The package directory a module belongs to: the nearest ancestor holding a
 *  `package.json` with a name. */
export function owningPackage(file: string): string | undefined {
  let dir = dirname(file);
  while (isAbsolute(dir) && dir !== sep) {
    if (existsSync(join(dir, 'package.json'))) {
      const name = readManifest(dir).name;
      if (name !== undefined) return dir;
    }
    dir = dirname(dir);
  }
  return undefined;
}

/** The `node_modules` owner a nested copy sits under, or undefined at the top
 *  level. `<owner>/node_modules/<scope>/<name>` yields `<owner>`. */
function nestingParent(dir: string): string | undefined {
  const marker = `${sep}node_modules${sep}`;
  const at = dir.lastIndexOf(marker);
  if (at <= 0) return undefined;
  const above = dir.slice(0, at);
  return above.endsWith(`${sep}node_modules`) || !above.includes(`${sep}node_modules${sep}`)
    ? undefined
    : above;
}

/** Every installed copy of `name` whose modules the deployed graph reached. */
export function boundCopies(graph: DeployedGraph, name: string): readonly PackageCopy[] {
  const byDir = new Map<string, string[]>();
  for (const file of graph.modules) {
    const dir = owningPackage(file);
    if (dir === undefined) continue;
    if (readManifest(dir).name !== name) continue;
    const held = byDir.get(dir) ?? [];
    held.push(relative(REPO_ROOT, file));
    byDir.set(dir, held);
  }
  return [...byDir.entries()]
    .map(([dir, modules]) => {
      const parent = nestingParent(dir);
      return {
        dir: relative(REPO_ROOT, dir),
        version: readManifest(dir).version ?? 'no version in its own manifest',
        parent: parent === undefined ? undefined : relative(REPO_ROOT, parent),
        modules: modules.sort(),
      };
    })
    .sort((left, right) => left.dir.localeCompare(right.dir));
}

/** Where a workspace pins `name` as a direct dependency, and to what. */
export interface Pin {
  /** Repository-relative manifest path. */
  readonly manifest: string;
  readonly range: string;
}

export function declaredPins(
  name: string, files: readonly string[] = trackedFiles(),
): readonly Pin[] {
  const pins: Pin[] = [];
  for (const file of files.filter((candidate) => WORKSPACE_MANIFEST.test(candidate))) {
    const range = readManifest(join(REPO_ROOT, dirname(file))).dependencies?.[name];
    if (range !== undefined) pins.push({ manifest: file, range });
  }
  return pins;
}

/* ── The lockfile ───────────────────────────────────────────────────────── */

/** One resolution `bun.lock` records for a package. */
export interface LockedResolution {
  /** The lock's own key: the bare name at the top level, `<owner>/<name>` for a
   *  resolution nested under a dependent. */
  readonly key: string;
  readonly version: string;
}

/** A `packages` row. Bun writes `[id, registry, meta, integrity]` and the id is
 *  `<name>@<version>`; only the id is read here, so the rest stays a rest. */
const LockRowSchema = v.tupleWithRest([v.string()], v.unknown());

const LOCK = 'bun.lock';

/** `bun.lock` is JSONC — it carries trailing commas — so it is read with the
 *  repository's one JSONC parser rather than `JSON.parse`. Rows are typed, so
 *  nothing here is a dictionary of `unknown`. */
const LockSchema = v.looseObject({
  packages: v.record(v.string(), LockRowSchema),
});

/**
 * Every resolution of `name` the lockfile records, top level and nested.
 *
 * WHY THE LOCK IS ASSERTED SEPARATELY from the installed graph, which is the
 * stronger measurement. `bun install` with a root override rewrote this file to
 * one resolution and did NOT prune the already-installed nested copy: for a while
 * the lock said one version while the artifact still bound another. Each side
 * therefore catches a state the other reports clean — a stale disk under a clean
 * lock, and a reintroduced nested resolution under a disk that happens to be
 * deduped, which is what a fresh `bun install` on another machine would then
 * materialise.
 */
export function lockedResolutions(
  name: string, source = readFileSync(join(REPO_ROOT, LOCK), 'utf8'),
): readonly LockedResolution[] {
  const lock = parseJsonc(source, LockSchema, LOCK);
  return Object.entries(lock.packages)
    .filter(([key]) => key === name || key.endsWith(`/${name}`))
    .map(([key, row]) => {
      const id = row[0];
      return { key, version: id.slice(id.lastIndexOf('@') + 1) };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

/* ── The literal reads ──────────────────────────────────────────────────── */

/** A tracked file naming a module of `name` as a string, and the module it
 *  names. A gate asserting a property of "the shipped SDK" by reading a path is
 *  right only if that path is a module the artifact contains. */
export interface LiteralRead {
  readonly file: string;
  /** Repository-relative module path as written. */
  readonly names: string;
}

/** Only a `.js` module: a `.d.ts` is a type, a `.map` is a sourcemap, and
 *  neither is what the artifact loads. */
const MODULE_LITERAL = /node_modules\/(?:[^"'`\s]*\/)?@cloudflare\/containers\/[^"'`\s:]*\.js/gu;

export function literalModuleReads(
  files: readonly string[] = trackedFiles(),
): readonly LiteralRead[] {
  const reads: LiteralRead[] = [];
  for (const file of files) {
    if (!isParseable(file)) continue;
    const path = join(REPO_ROOT, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    if (!text.includes(CONTAINERS)) continue;
    const parsed = parse(file, text);
    walk(parsed.root, (node) => {
      const raw = node.raw;
      if (raw.type !== 'Literal' && raw.type !== 'TemplateElement') return;
      const written = node.type === 'TemplateElement'
        ? text.slice(node.start, node.end)
        : text.slice(node.start + 1, node.end - 1);
      for (const [named] of written.matchAll(MODULE_LITERAL)) {
        reads.push({ file, names: named });
      }
    });
  }
  return reads;
}

/* ── The verdict ────────────────────────────────────────────────────────── */

const CONFIGS = deployedConfigs();
const GRAPH = await deployedGraph(CONFIGS);
const COPIES = boundCopies(GRAPH, CONTAINERS);
const PINS = declaredPins(CONTAINERS);
const READS = literalModuleReads();
const LOCKED = lockedResolutions(CONTAINERS);
const GRAPH_MODULES: ReadonlySet<string> = new Set(
  GRAPH.modules.map((file) => relative(REPO_ROOT, file)),
);

/** Every container every deployed config binds, flattened with its config. */
const CONTAINERS_BOUND = CONFIGS.flatMap((config) =>
  config.containers.map((container) => ({ config: config.file, container })));

const describeCopy = (copy: PackageCopy): string =>
  `${copy.dir} at ${copy.version}`
  + (copy.parent === undefined ? ' (top level)' : ` (nested under ${copy.parent})`)
  + `, ${String(copy.modules.length)} module(s) in the artifact`;

console.log(`nested-container-resolution: ${assertMeasured('nested-container-resolution', [
  ['deployed Worker entry points', GRAPH.entries.length],
  ['modules in the deployed graph', GRAPH.modules.length],
  [`installed ${CONTAINERS} copies the artifact binds`, COPIES.length],
  [`workspace manifests pinning ${CONTAINERS}`, PINS.length],
  ['containers the deployed configs bind', CONTAINERS_BOUND.length],
  [`${LOCK} resolutions of ${CONTAINERS}`, LOCKED.length],
])}`);
for (const copy of COPIES) console.log(`  binds ${describeCopy(copy)}`);
for (const row of LOCKED) console.log(`  ${LOCK} records ${row.key} at ${row.version}`);

describe('the Containers runtime the deployed artifact binds', () => {
  test('the graph measurement has no holes', () => {
    // A file the walk could not read is an edge it never followed, so every
    // answer below would be quietly narrower than it claims.
    expect(GRAPH.unreadable.map((hole) => `${hole.file}: ${hole.reason}`)).toEqual([]);
    expect(GRAPH.entries.length).toBeGreaterThan(0);
  });

  test('exactly one Containers runtime version reaches the deployed graph', () => {
    const versions = [...new Set(COPIES.map((copy) => copy.version))].sort();
    if (versions.length === 1) return;
    throw new Error(`${CONTAINERS}: ${String(versions.length)} versions reach one artifact\n${
      COPIES.map((copy) => finding({
        at: describeCopy(copy),
        invariant: `one ${CONTAINERS} version reaches the deployed Worker artifact`,
        found: `versions ${versions.join(' and ')} are both bundled`,
        silently: 'two Container base classes, two state machines, and a bug fixed in one '
          + 'copy still live in the other',
        fix: `pin one resolution of ${CONTAINERS} for the whole tree, then reinstall`,
      })).join('\n')}`);
  });

  test('the version the workspaces pin is the version that ships', () => {
    const shipped = [...new Set(COPIES.map((copy) => copy.version))].sort();
    const drifted = PINS.filter((pin) => !shipped.includes(pin.range));
    if (drifted.length === 0) return;
    const exact = /^\d+\.\d+\.\d+$/u;
    throw new Error(`${CONTAINERS}: the pinned version is not the shipped version\n${
      drifted.map((pin) => finding({
        at: `${pin.manifest} pins "${pin.range}"`,
        invariant: `the ${CONTAINERS} version a workspace pins is the version the deployed `
          + 'artifact binds',
        found: exact.test(pin.range)
          ? `the artifact binds ${shipped.join(' and ')}, reached through ${
            COPIES.map((copy) => copy.parent ?? 'the top level').join(' and ')}`
          : `"${pin.range}" is a range, so this probe cannot compare it to a resolved version; `
            + 'pin an exact version or teach this probe the range semantics',
        silently: 'the pin, the lockfile and the docs name one version while the artifact runs '
          + 'another, so every claim made about the SDK is checked against code that never runs',
        fix: 'reconcile the two resolutions, by bumping the nesting parent or by overriding the '
          + 'nested range, so one version is both pinned and bundled',
      })).join('\n')}`);
  });

  test('the manifests, the lockfile, the installed graph and the artifact agree', () => {
    // The four declarations of one version, held equal in one place. Three of
    // them were already asserted here; the lockfile is the fourth, and it is the
    // one an install on another machine reads.
    const shipped = COPIES.map((copy) => copy.version);
    const locked = LOCKED.map((row) => row.version);
    const pinned = PINS.map((pin) => pin.range);
    const versions = [...new Set([...shipped, ...locked, ...pinned])].sort();
    if (versions.length === 1) return;
    throw new Error(`${CONTAINERS}: four declarations, ${String(versions.length)} versions\n${
      finding({
        at: `${LOCK} records ${LOCKED.map((row) => `${row.key}@${row.version}`).join(', ')}; `
          + `${PINS.map((pin) => `${pin.manifest} pins ${pin.range}`).join('; ')}; `
          + `the artifact binds ${[...new Set(shipped)].join(' and ')}`,
        invariant: 'the version the manifests pin, the version the lockfile resolves, the copy '
          + 'installed in the graph and the copy the emitted artifact binds are one version',
        found: `they name ${versions.join(', ')}`,
        silently: 'every claim made about the SDK is checked against a version that does not '
          + 'run, and a fix landed in the pinned version never ships',
        fix: 'reconcile the resolutions with a root `overrides` entry for the version the '
          + 'workspaces pin, reinstall, and remove any nested copy the install leaves behind',
      })}`);
  });

  test(`${LOCK} records one resolution, whatever the installed tree holds`, () => {
    // Set equality above passes a SECOND resolution at the same version, and a
    // second resolution is a second copy in the bundle whether or not the
    // versions differ. It is also the direction the disk cannot show: this is the
    // state `bun install` leaves when it dedupes the lock and keeps the nested
    // directory, and the state a fresh install elsewhere would materialise.
    expect(LOCKED.length, `${LOCK} records no resolution of ${CONTAINERS} at all`)
      .toBeGreaterThan(0);
    const nested = LOCKED.filter((row) => row.key !== CONTAINERS);
    if (nested.length === 0) return;
    throw new Error(`${LOCK}: ${String(nested.length)} nested resolution(s)\n${
      nested.map((row) => finding({
        at: `${LOCK} records "${row.key}" at ${row.version}`,
        invariant: `${LOCK} resolves ${CONTAINERS} once, at the top level`,
        found: 'a dependent carries its own resolution, so an install materialises a second '
          + 'copy under it',
        silently: 'the installed tree on this machine can be deduped while every other machine '
          + 'and CI installs two copies from this file',
        fix: `add or widen the root \`overrides\` entry for ${CONTAINERS} so the dependent's `
          + 'range resolves to the pinned version, then reinstall',
      })).join('\n')}`);
  });

  test(`the ${LOCK} reader sees a nested resolution`, () => {
    // The negative control for the test above, and the reason it is not
    // decoration: the tree is deduped, so there is no nested row left to find.
    // A reader whose nesting arm never matched would return the one bare row,
    // satisfy the denominator, and report "one resolution" forever. The defect
    // and the fixed state would look identical. This holds the reader to the
    // shape the lock actually had before the dedupe, integrity string and all,
    // and it also pins the three decisions the reader makes: an unrelated
    // package is excluded, the version comes from the row's id rather than from
    // its key, and the result is ordered by key.
    const before = JSON.stringify({
      packages: {
        [CONTAINERS]: [`${CONTAINERS}@0.3.7`, '', {}, 'sha512-DM9dm3FnIBSyiSJ1FLavKwl/lk3oAmTaynCzZQ9pZR0ncRPquSxkxd8Nu2MFILxmDDsPkxKsSNEh9mHHMty4Fw=='],
        [`@cloudflare/sandbox/${CONTAINERS}`]: [`${CONTAINERS}@0.3.6`, '', {}, 'sha512-8RrbK/Et165gjvXccui3pgkUuySVWysTC6bJRXfgqmbCA2vAmh8pm7cAKDh2nZFR/GSjW4BgxeKpffCTD8SJEg=='],
        hono: ['hono@4.13.0', '', {}, 'sha512-unrelated'],
      },
    });
    expect(lockedResolutions(CONTAINERS, before).map((row) => `${row.key}@${row.version}`))
      .toEqual([
        '@cloudflare/containers@0.3.7',
        '@cloudflare/sandbox/@cloudflare/containers@0.3.6',
      ]);
  });

  /**
   * The one question this probe cannot answer, kept mechanical rather than
   * written in a comment that could rot. A container built from this tree runs
   * a Node of its own, and unbundled Node ESM rejects the extensionless
   * specifiers these packages emit. Today no deployed container is built here:
   * every `image` is a registry reference, so nothing in this tree decides what
   * that image loads. The moment one becomes a local build, this test fails and
   * names what a human with deploy credentials has to run.
   */
  test('no deployed container image is built from this tree', () => {
    const built = CONTAINERS_BOUND.filter(({ config, container }) =>
      existsSync(join(REPO_ROOT, dirname(config), container.image)));
    if (built.length === 0) return;
    throw new Error(`${String(built.length)} container image(s) are built here, so cold-start `
      + `module loading is undecided\n${built.map(({ config, container }) => finding({
        at: `${config} binds ${container.className} at ${container.where} from ${container.image}`,
        invariant: 'a container this tree builds must have its own module loading proved, because '
          + 'this probe measures only the Worker bundle',
        found: `${container.image} is a path in this repository, not a registry reference`,
        silently: 'an extensionless ESM specifier inside the image fails at container cold start, '
          + 'and no local measurement sees it',
        fix: 'build and cold-start it: `docker build -f '
          + `${join(dirname(config), container.image)} -t kinu-container-probe .\` succeeds, then `
          + '`npx wrangler versions upload --config '
          + `${config}\` and one request that starts ${container.className}; the criterion is that `
          + 'the container reports its own SANDBOX_VERSION and its log holds no module resolution '
          + 'error. Neither command may run here: the upload needs Cloudflare credentials',
      })).join('\n')}`);
  });
});

describe('resolution inside the deployed artifact', () => {
  test('every import specifier in the deployed graph resolves', () => {
    if (GRAPH.unresolved.length === 0) return;
    throw new Error(`${String(GRAPH.unresolved.length)} specifier(s) do not resolve\n${
      GRAPH.unresolved.map((miss) => finding({
        at: `${miss.file} imports '${miss.specifier}'`,
        invariant: 'every import specifier in the deployed Worker graph resolves under the '
          + 'bundler that emits the artifact',
        found: miss.reason,
        silently: 'the build fails, or a lazily imported module fails at cold start',
        fix: 'give the specifier a path the resolver can reach, or install the package it names',
      })).join('\n')}`);
  });

  test('a literal Containers module path names a module the artifact contains', () => {
    const wrong = READS.filter((read) => !GRAPH_MODULES.has(read.names));
    if (wrong.length === 0) return;
    const shipped = COPIES.flatMap((copy) => copy.modules);
    throw new Error(`${String(wrong.length)} literal path(s) name a copy that never ships\n${
      wrong.map((read) => finding({
        at: `${read.file} names ${read.names}`,
        invariant: `a literal ${CONTAINERS} module path names a module the deployed artifact `
          + 'contains',
        found: 'that module is not in the deployed graph',
        silently: 'a gate asserts a property of the shipped SDK by reading a copy the artifact '
          + 'never binds, so it passes while the shipped copy disagrees',
        fix: `read one of the modules the artifact binds: ${shipped.join(', ')}`,
      })).join('\n')}`);
  });
});
