/**
 * What the Worker bundles from @cloudflare/puppeteer. The package pins @puppeteer/browsers, whose browser
 * download unpacks archives with extract-zip, and REVIEWED_ADVISORIES (security-scanner.ts) accepts
 * extract-zip's advisories on one condition: neither enters the Worker. So this bundles each specifier the
 * Worker's sources import from the package, resolved as the Worker build resolves it (the Cloudflare vite
 * plugin's conditions), and reads the build's own list of inputs. An upgrade or an import that pulls either
 * package in turns it red.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { builtinModules } from 'node:module';
import { build, stop } from 'esbuild';
import { moduleEdges } from './import-graph';
import { isParseable, readMatching } from './sources';
import { parse } from './syntax';

const WORKER = 'packages/cf-backend';

const PACKAGE = '@cloudflare/puppeteer';

const UNREACHABLE = ['@puppeteer/browsers', 'extract-zip'];

/** `@cloudflare/vite-plugin`'s `defaultConditions`, with the build's mode. */
const WORKER_CONDITIONS = ['workerd', 'worker', 'module', 'browser', 'production'];

/** Every value import of the package in the Worker's sources. */
function workerSpecifiers(): string[] {
  const found = new Set<string>();

  for (const [file, text] of readMatching((path) => path.startsWith(`${WORKER}/src/`) && isParseable(path))) {
    for (const edge of moduleEdges(parse(file, text)).edges) {
      if (edge.kind === 'value' && (edge.specifier === PACKAGE || edge.specifier.startsWith(`${PACKAGE}/`))) found.add(edge.specifier);
    }
  }

  return [...found].sort();
}

/** The last `node_modules` segment of a bundled input names its package; a repository file names none. */
function packageOf(input: string): string | null {
  const at = input.lastIndexOf('node_modules/');

  if (at < 0) return null;
  const [scope, name] = input.slice(at + 'node_modules/'.length).split('/');

  return scope?.startsWith('@') === true ? `${scope}/${name}` : scope ?? null;
}

/** The packages a bundle of these specifiers is built from. */
async function bundledPackages(specifiers: readonly string[]): Promise<Set<string>> {
  const { metafile } = await build({
    stdin: { contents: specifiers.map((specifier, index) => `export * as m${String(index)} from '${specifier}';`).join('\n'), resolveDir: WORKER },
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'neutral',
    conditions: WORKER_CONDITIONS,
    mainFields: ['module', 'main'],
    external: builtinModules.flatMap((name) => [name, `node:${name}`]),
    logLevel: 'silent',
  });

  return new Set(Object.keys(metafile.inputs).map(packageOf).filter((name) => name !== null));
}

// esbuild answers from a service process of its own, which a test file ends.
afterAll(async () => { await stop(); });

describe('the Worker bundle reaches @cloudflare/puppeteer only through its workers entry', () => {
  test('neither @puppeteer/browsers nor extract-zip enters the Worker', async () => {
    const specifiers = workerSpecifiers();

    expect(specifiers).toEqual([PACKAGE]);
    const packages = await bundledPackages(specifiers);

    expect(packages).toContain(PACKAGE);

    for (const name of UNREACHABLE) expect(packages).not.toContain(name);
  });

  test('the Node launcher, one export away, reaches both, so the check can see them', async () => {
    const packages = await bundledPackages([`${PACKAGE}/internal/node/ChromeLauncher.js`]);

    for (const name of UNREACHABLE) expect(packages).toContain(name);
  });
});
