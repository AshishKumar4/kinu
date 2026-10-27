/** The front Worker's build: `src/front.ts` bundled apart from the main Worker, with the config front-config.ts derives. */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import type { Plugin } from 'vite';
import { unstable_readConfig } from 'wrangler';
import { FRONT_DIRECTORY, FRONT_ENTRY, frontConfig } from './front-config';

/** For the environment the main Worker's build is for (`CLOUDFLARE_ENV`), as vite-agent-bundle.ts reads it. */
export function frontWorker(): Plugin {
  let built = false;

  return {
    name: 'kinu:front-worker',
    apply: 'build',
    async buildStart() {
      if (built) return;
      built = true;
      const main = unstable_readConfig({ config: resolve(import.meta.dirname, 'wrangler.jsonc'), env: process.env.CLOUDFLARE_ENV });
      const out = resolve(import.meta.dirname, FRONT_DIRECTORY);

      rmSync(out, { recursive: true, force: true });
      mkdirSync(out, { recursive: true });
      await build({
        entryPoints: { index: resolve(import.meta.dirname, FRONT_ENTRY) }, outdir: out, sourcemap: 'linked',
        bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
        mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser'],
        minify: true, legalComments: 'none',
        alias: Object.fromEntries(builtinModules.filter((name) => !name.startsWith('node:')).map((name) => [name, `node:${name}`])),
        external: ['cloudflare:*', 'node:*'],
      });
      writeFileSync(resolve(out, 'wrangler.json'), JSON.stringify(frontConfig(main)));
    },
  };
}
