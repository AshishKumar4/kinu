/**
 * What the Worker bundles. REVIEWED_ADVISORIES (security-scanner.ts) accepts extract-zip's advisories on one
 * condition: neither it nor @puppeteer/browsers, which requires it, enters the Worker. So this bundles the
 * Worker's own entry (wrangler.jsonc's `main`) as its build resolves it, with the Cloudflare vite plugin's
 * conditions, and reads the build's list of inputs. An import of either, direct or through any package, turns
 * it red. `virtual:kinu-slate-vendor` is data (the slates' react and capnweb, as a string) and stays external.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { builtinModules } from 'node:module';
import { build, stop } from 'esbuild';
import { readWranglerConfig } from './release-manifest';

const WORKER = 'packages/cf-backend';

const UNREACHABLE = ['@puppeteer/browsers', 'extract-zip'];

/** `@cloudflare/vite-plugin`'s `defaultConditions`, with the build's mode. */
const WORKER_CONDITIONS = ['workerd', 'worker', 'module', 'browser', 'production'];

/** The last `node_modules` segment of a bundled input names its package; a repository file names none. */
function packageOf(input: string): string | null {
  const at = input.lastIndexOf('node_modules/');

  if (at < 0) return null;
  const [scope, name] = input.slice(at + 'node_modules/'.length).split('/');

  return scope?.startsWith('@') === true ? `${scope}/${name}` : scope ?? null;
}

/** The packages the Worker's entry is built from, with `planted` imported beside it. */
async function bundledPackages(planted = ''): Promise<Set<string>> {
  const main = readWranglerConfig().main;

  if (main === undefined) throw new Error('wrangler.jsonc names no `main`');

  const { metafile } = await build({
    stdin: { contents: `import './${main}';\n${planted}`, resolveDir: WORKER, loader: 'ts' },
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'neutral',
    conditions: WORKER_CONDITIONS,
    mainFields: ['module', 'main'],
    external: ['cloudflare:*', 'virtual:*', ...builtinModules.flatMap((name) => [name, `node:${name}`])],
    loader: { '.wasm': 'empty' },
    logLevel: 'silent',
  });

  return new Set(Object.keys(metafile.inputs).map(packageOf).filter((name) => name !== null));
}

// esbuild answers from a service process of its own, which a test file ends.
afterAll(async () => { await stop(); });

describe("the Worker's bundle", () => {
  test('holds @cloudflare/puppeteer, and neither @puppeteer/browsers nor extract-zip', async () => {
    const packages = await bundledPackages();

    expect(packages).toContain('@cloudflare/puppeteer');

    for (const name of UNREACHABLE) expect(packages).not.toContain(name);
  });

  test('is red for a direct import of extract-zip', async () => {
    expect(await bundledPackages("import extract from 'extract-zip';\nexport { extract };")).toContain('extract-zip');
  });

  test("is red for both through another package: @cloudflare/puppeteer's Node launcher", async () => {
    const packages = await bundledPackages("export * from '@cloudflare/puppeteer/internal/node/ChromeLauncher.js';");

    for (const name of UNREACHABLE) expect(packages).toContain(name);
  });
});
