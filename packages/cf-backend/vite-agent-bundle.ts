/** The agent bundle: `src/agent-facet/agent-facet.ts` alone, built apart from the Worker and served from assets (D9). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import type { Plugin } from 'vite';
import { unstable_readConfig } from 'wrangler';
import * as v from 'valibot';

const deployment = unstable_readConfig({ config: resolve(import.meta.dirname, 'wrangler.jsonc'), env: process.env.CLOUDFLARE_ENV });

export const workerCompatibility = {
  compatibilityDate: v.parse(v.string(), deployment.compatibility_date),
  compatibilityFlags: deployment.compatibility_flags,
};

export const AGENT_BUNDLE_ENTRY = resolve(import.meta.dirname, 'src/agent-facet/agent-facet.ts');

const AGENT_BUNDLE_OUTPUT = resolve(import.meta.dirname, 'public/_agent/agent.js');

export function buildAgentBundle(entry: string = AGENT_BUNDLE_ENTRY): string {
  const result = buildSync({
    entryPoints: [entry],
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022',
    mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser'],
    minify: true, keepNames: true, charset: 'ascii', legalComments: 'none',
    alias: Object.fromEntries(builtinModules.filter((name) => !name.startsWith('node:')).map((name) => [name, `node:${name}`])),
    external: ['cloudflare:*', 'node:*'],
  });

  const text = result.outputFiles[0]?.text;

  if (text === undefined) throw new Error('the agent bundle build produced no output');

  return text.replace(/[^\0-\x7f]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function agentBundle(): Plugin {
  let built = false;

  return {
    name: 'kinu:agent-bundle',
    buildStart() {
      if (built) return;
      mkdirSync(dirname(AGENT_BUNDLE_OUTPUT), { recursive: true });
      writeFileSync(AGENT_BUNDLE_OUTPUT, buildAgentBundle());
      writeFileSync(resolve(dirname(AGENT_BUNDLE_OUTPUT), 'compatibility.json'), JSON.stringify(workerCompatibility));
      built = true;
    },
  };
}
