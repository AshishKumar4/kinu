// Devbox must not import the product's core. Asserted on the module graph the bundler resolves from every
// entry the repository declares for the package, so an import, a re-export and a dynamic import all count.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import * as v from 'valibot';
import { DEVBOX_SCRATCH_PREFIX } from '../packages/devbox/tests/support/scratch';
import { isParseable, isTestFile, trackedFiles } from './sources';

/** Only the manifest fields this test reads, parsed rather than asserted: a manifest on disk
 *  is input. */
const ManifestSchema = v.object({
  name: v.optional(v.string()),
  dependencies: v.optional(v.record(v.string(), v.string())),
  devDependencies: v.optional(v.record(v.string(), v.string())),
});

function manifest(path: string): v.InferOutput<typeof ManifestSchema> {
  const parsed = v.safeParse(ManifestSchema, JSON.parse(readFileSync(path, 'utf8')));

  if (!parsed.success) throw new Error(`${path} is not a manifest this test can read`);

  return parsed.output;
}

const PACKAGE_DIR = join(import.meta.dir, '..', 'packages', 'devbox');

/** Read from the sibling manifest, not hardcoded: after a rename, a guard checking a stale
 *  name passes silently. */
function forbiddenScope(): string {
  const name = manifest(join(PACKAGE_DIR, '..', 'core', 'package.json')).name;

  if (name === undefined || !name.startsWith('@') || !name.includes('/')) {
    throw new Error(
      `the sibling core package declares no scoped name (${JSON.stringify(name)}), so this `
      + 'test cannot know what to forbid',
    );
  }

  return name;
}

const REPOSITORY = join(PACKAGE_DIR, '..', '..');

const Exports = v.object({ exports: v.record(v.string(), v.string()) });

const KnipWorkspaces = v.object({ knip: v.object({ workspaces: v.record(v.string(), v.object({ entry: v.array(v.string()) })) }) });

const WorkerConfig = v.object({ main: v.string() });

/**
 * Every file the repository declares as an entry of this package, read from configuration and never from source:
 * its manifest's exports, the production entries (`!`) the root's knip config names for it, and the `main` of each
 * Worker it deploys from `bench/`. A module no entry reaches ships nowhere, and knip names it unused.
 */
function declaredEntries(): readonly string[] {
  const exported = Object.values(v.parse(Exports, JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))).exports);
  const knip = v.parse(KnipWorkspaces, JSON.parse(readFileSync(join(REPOSITORY, 'package.json'), 'utf8')));

  const production = (knip.knip.workspaces[relative(REPOSITORY, PACKAGE_DIR)]?.entry ?? [])
    .filter((entry) => entry.endsWith('!')).map((entry) => entry.slice(0, -1));

  const workers = trackedFiles().filter(path => /^packages\/devbox\/bench\/wrangler[^/]*\.jsonc$/.test(path))
    .map(config => join("bench", v.parse(WorkerConfig, Bun.JSONC.parse(readFileSync(join(REPOSITORY, config), "utf8"))).main));

  return [...new Set([...exported, ...production, ...workers].map((entry) => join(PACKAGE_DIR, entry)))].sort();
}

/**
 * Every module of the package that is not a test: an entry of the graph too. A module only scripts or tests import
 * (`bench/c3-result.ts`, `bench/seeded.ts`) is reached by no declared entry, and it still must not import the core.
 */
function everyModule(): readonly string[] {
  return trackedFiles().filter(path => path.startsWith('packages/devbox/') && isParseable(path) && !isTestFile(path))
    .map(path => join(REPOSITORY, path));
}

describe('package independence', () => {
  const scope = forbiddenScope();

  test('nothing any entry of the package reaches imports the product core', async () => {
    const entries = [...new Set([...declaredEntries(), ...everyModule()])].sort();
    const crossing: Record<string, readonly string[]> = {};

    // The manifest's main entry and a module only scripts import are among them, so an empty reading cannot pass.
    expect(entries).toEqual(expect.arrayContaining([join(PACKAGE_DIR, 'src', 'index.ts'), join(PACKAGE_DIR, 'bench', 'seeded.ts')]));

    for (const entry of entries) {
      const core = (await bundledSpecifiers(entry)).filter((specifier) => specifier === scope || specifier.startsWith(`${scope}/`));

      if (core.length > 0) crossing[relative(PACKAGE_DIR, entry)] = core;
    }

    expect(crossing).toEqual({});
  });

  test('the manifest declares no dependency on any workspace package', () => {
    const own = manifest(join(PACKAGE_DIR, 'package.json'));

    const declared = [
      ...Object.keys(own.dependencies ?? {}),
      ...Object.keys(own.devDependencies ?? {}),
    ];

    expect(declared.filter(name => name.startsWith(`${scope.split('/')[0]}/`))).toEqual([]);
    // Catches a workspace package aliased under another name, which the scope check misses.
    const ranges = Object.values({ ...own.dependencies, ...own.devDependencies });
    expect(ranges.filter(range => range.startsWith('workspace:'))).toEqual([]);
  });

  test('the graph reading can fail: an entry re-exporting the core reaches it', async () => {
    const scratch = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}independence-`));

    try {
      writeFileSync(join(scratch, 'reexport.ts'), `export { tolerate } from '${scope}/obs';\n`);
      writeFileSync(join(scratch, 'entry.ts'), "export * from './reexport';\n");

      expect(await bundledSpecifiers(join(scratch, 'entry.ts'))).toContain(`${scope}/obs`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

/** Package specifiers resolve as external, so the walk stays inside this package's sources
 *  while still recording every name crossing out of them. */
async function bundledSpecifiers(entrypoint: string): Promise<readonly string[]> {
  const reached = new Set<string>();

  const built = await Bun.build({
    entrypoints: [entrypoint],
    target: 'node',
    plugins: [{
      name: 'record-bare-specifiers',
      setup(build) {
        build.onResolve({ filter: /^[^./]/ }, (args) => {
          reached.add(args.path);

          return { path: args.path, external: true };
        });
      },
    }],
  });

  if (!built.success) throw new AggregateError(built.logs, `${entrypoint} does not bundle`);

  return [...reached].sort();
}

describe('the Worker admits nothing the Workers runtime cannot load', () => {
  test('the deployed Worker reaches no bun: builtin', async () => {
    // `bun:ffi` matters most: a module opening a native helper carries it into a runtime
    // without it, failing the deploy for code nothing in the Worker calls.
    const reached = await bundledSpecifiers(join(PACKAGE_DIR, 'bench', 'worker.ts'));
    expect(reached.filter(name => name.startsWith('bun:'))).toEqual([]);
  });

  test('the builder resolves what a module really imports, so the check above is not vacuous',
    async () => {
      const entry = join(PACKAGE_DIR, 'bench', 'worker.ts');
      expect(await bundledSpecifiers(entry)).toContain('valibot');
    });
});
