/**
 * What the Worker bundles. REVIEWED_ADVISORIES (security-scanner.ts) accepts extract-zip's advisories on one
 * condition: neither it nor @puppeteer/browsers, which requires it, enters the Worker. So this bundles the
 * Worker's own entry (wrangler.jsonc's `main`) as its build resolves it, with the Cloudflare vite plugin's
 * conditions, and reads the build's list of inputs. An import of either, direct or through any package, turns
 * it red. `virtual:kinu-slate-vendor` is data (the slates' react and capnweb, as a string) and stays external.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import * as v from 'valibot';
import { runToExit, scratchDir } from '@kinu.run/test-utils';
import { deployedConfig } from './infra-manifest';

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

const MetafileSchema = v.object({ inputs: v.record(v.string(), v.unknown()) });

/**
 * The packages the Worker's entry is built from, with `planted` imported beside it. The build is esbuild's own binary,
 * a child this test awaits: the JS API answers from a long-lived service whose `stop()` signals it and returns before
 * it exits, which the preload's leak check then found still running (2026-10-08, on 03007fcdb).
 */
async function bundledPackages(planted = ''): Promise<Set<string>> {
  const main = deployedConfig('production').main;

  if (main === undefined) throw new Error('wrangler.jsonc names no `main`');
  const metafile = join(scratchDir('worker-bundle-reach'), 'meta.json');

  const externals = ['cloudflare:*', 'virtual:*', ...builtinModules.flatMap((name) => [name, `node:${name}`])];

  const built = await runToExit([
    join(import.meta.dir, '..', 'node_modules', '.bin', 'esbuild'),
    '--bundle', '--format=esm', '--platform=neutral', '--loader=ts', '--loader:.wasm=empty', '--log-level=error',
    `--conditions=${WORKER_CONDITIONS.join(',')}`, '--main-fields=module,main', `--metafile=${metafile}`, '--outfile=/dev/null',
    ...externals.map((name) => `--external:${name}`),
  ], { cwd: join(import.meta.dir, '..', WORKER), stdin: `import './${main}';\n${planted}` });

  if (built.exitCode !== 0) throw new Error(`esbuild exited ${String(built.exitCode)}: ${built.stderr.trim()}`);
  const { inputs } = v.parse(MetafileSchema, JSON.parse(readFileSync(metafile, 'utf8')));

  return new Set(Object.keys(inputs).map(packageOf).filter((name) => name !== null));
}

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
