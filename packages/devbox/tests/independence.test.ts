// Devbox must not import the product's core; asserted by scanning files on disk for every path.
// Worker graph is checked by building it: re-exported specifiers escape a source scan.
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';

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

const PACKAGE_DIR = join(import.meta.dir, '..');

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

function sourceFiles(dir: string): readonly string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }

    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) found.push(path);
  }

  return found;
}

describe('package independence', () => {
  const scope = forbiddenScope();

  test('the shipped source imports nothing from the product core', () => {
    const offenders: string[] = [];

    for (const dir of ['src', 'bench']) {
      for (const file of sourceFiles(join(PACKAGE_DIR, dir))) {
        const text = readFileSync(file, 'utf8');

        // Import, re-export and dynamic import all reach the same module, so
        // the check is for the specifier rather than for one syntax.
        if (text.includes(`'${scope}`) || text.includes(`"${scope}`)) {
          offenders.push(file.slice(PACKAGE_DIR.length + 1));
        }
      }
    }

    expect(offenders).toEqual([]);
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

  test('the guard itself can fail, proved against a known-bad specifier', () => {
    // An always-green guard cannot tell "no violations" from "check broken"; this runs
    // the same predicate as the test above against text it must catch.
    const bad = `import { thing } from '${scope}/obs';`;
    expect(bad.includes(`'${scope}`)).toBe(true);
    const good = "import { Sandbox } from '@cloudflare/sandbox';";
    expect(good.includes(`'${scope}`)).toBe(false);
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
