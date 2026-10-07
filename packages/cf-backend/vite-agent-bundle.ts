/** The agent bundle: `src/agent-facet/agent-facet.ts` alone, built apart from the Worker and served from assets (D9). */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { basename, resolve } from 'node:path';
import { buildSync, stop } from 'esbuild';
import type { Plugin } from 'vite';
import { unstable_readConfig } from 'wrangler';
import * as v from 'valibot';

const deployment = unstable_readConfig({ config: resolve(import.meta.dirname, 'wrangler.jsonc'), env: process.env.CLOUDFLARE_ENV });

export const workerCompatibility = {
  compatibilityDate: v.parse(v.string(), deployment.compatibility_date),
  compatibilityFlags: deployment.compatibility_flags,
};

export const AGENT_BUNDLE_ENTRY = resolve(import.meta.dirname, 'src/agent-facet/agent-facet.ts');

const AGENT_BUNDLE_OUTPUT = resolve(import.meta.dirname, 'public/_agent');

/**
 * The bundle as the module map a Worker Loader takes, `agent.js` its main module, and each module's source map. A
 * dynamic import is its own chunk, so code an agent's turn never imports is never compiled in its isolate.
 */
export function buildAgentBundle(entry: string = AGENT_BUNDLE_ENTRY) {
  const result = buildSync({
    entryPoints: { agent: entry }, outdir: '/', splitting: true, chunkNames: 'chunk-[hash]', sourcemap: 'external',
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022',
    mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser'],
    minify: true, keepNames: true, charset: 'ascii', legalComments: 'none',
    alias: Object.fromEntries(builtinModules.filter((name) => !name.startsWith('node:')).map((name) => [name, `node:${name}`])),
    external: ['cloudflare:*', 'node:*'],
  });

  const ascii = (text: string): string => text.replace(/[^\0-\x7f]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const modules = Object.fromEntries(result.outputFiles.filter((file) => file.path.endsWith('.js')).map((file) => [basename(file.path), ascii(file.text)]));
  const maps = Object.fromEntries(result.outputFiles.filter((file) => file.path.endsWith('.js.map')).map((file) => [basename(file.path), file.text]));

  if (modules['agent.js'] === undefined) throw new Error('the agent bundle build produced no agent.js');

  return { modules, maps };
}

/**
 * Replaces a generated file whole. Concurrent builds and test runs in one checkout rewrite these files while others
 * read them; written in place, a reader caught one empty (a deploy wave's workerd rows, 2026-09-30).
 */
export function writeWhole(path: string, text: string): void {
  const draft = `${path}.${String(process.pid)}`;

  writeFileSync(draft, text);
  renameSync(draft, path);
}

export function agentBundle(): Plugin {
  let built = false;

  return {
    name: 'kinu:agent-bundle',
    async buildStart() {
      if (built) return;
      mkdirSync(AGENT_BUNDLE_OUTPUT, { recursive: true });
      const bundle = buildAgentBundle();
      writeWhole(resolve(AGENT_BUNDLE_OUTPUT, 'modules.json'), JSON.stringify(bundle.modules));

      for (const [name, map] of Object.entries(bundle.maps)) writeWhole(resolve(AGENT_BUNDLE_OUTPUT, name), map);
      writeWhole(resolve(AGENT_BUNDLE_OUTPUT, 'compatibility.json'), JSON.stringify(workerCompatibility));
      // buildSync leaves esbuild's service process running for the life of the process that ran the build.
      await stop();
      built = true;
    },
  };
}
