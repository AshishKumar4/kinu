import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { Miniflare, convertV4MiniflareOptions, type V4ModuleDefinition } from 'miniflare';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import * as v from 'valibot';
import { SubordinateInspectionResultSchema } from '@kinu.run/core';

const built = await build({
  entryPoints: [join(import.meta.dir, 'production.mjs')], outfile: join(import.meta.dir, 'compiled/worker.mjs'),
  bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'], target: 'es2022', keepNames: true,
  alias: Object.fromEntries(builtinModules.filter((name) => !name.startsWith('node:')).map((name) => [name, `node:${name}`])),
  external: ['cloudflare:*', 'node:*'], loader: { '.wasm': 'copy' },
});
const modules = built.outputFiles.map((file) => file.path.endsWith('.wasm')
  ? { type: 'CompiledWasm', path: file.path, contents: file.contents } satisfies V4ModuleDefinition
  : { type: 'ESModule', path: file.path, contents: file.text } satisfies V4ModuleDefinition);
modules.sort((left, right) => Number(left.type === 'CompiledWasm') - Number(right.type === 'CompiledWasm'));
const runtime = new Miniflare(convertV4MiniflareOptions({
  modules, compatibilityDate: '2025-12-01', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true } },
}));
try {
  const countsSchema = v.object({ events: v.number(), fibers: v.number(), callable: v.boolean() });
  const request = async (operation: string) => {
    const response = await runtime.dispatchFetch(`http://probe/${operation}`);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  await request('seed');
  const before = v.parse(countsSchema, await request('counts'));
  assert.equal(before.events, 2);
  assert.equal(before.callable, false);
  await request('abort');
  const result = v.parse(SubordinateInspectionResultSchema, await request('inspect'));
  assert.equal(result.view, 'events');
  if (result.view !== 'events') throw new Error('The retained event read failed');
  assert.equal(result.page.status, 'more');
  assert.equal(result.page.items[0]?.type, 'run_start');
  const after = v.parse(countsSchema, await request('counts'));
  assert.deepEqual(after, before);
  console.log(JSON.stringify({ passed: true, before, after, view: result.view, page: result.page.status }));
} finally {
  await runtime.dispose();
}
