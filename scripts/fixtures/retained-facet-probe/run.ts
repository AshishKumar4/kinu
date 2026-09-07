import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { Miniflare } from 'miniflare';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';

const built = await build({
  entryPoints: [join(import.meta.dir, 'worker.mjs')], bundle: true, write: false,
  format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'], target: 'es2022', keepNames: true,
  alias: Object.fromEntries(builtinModules.filter((name) => !name.startsWith('node:')).map((name) => [name, `node:${name}`])),
  external: ['cloudflare:*', 'node:*'],
});
const source = built.outputFiles[0];
if (!source) throw new Error('The probe build produced no module');
const runtime = new Miniflare({
  workers: [{ config: {
    name: "retained-facet-proof", type: "worker",
    manifest: { mainModule: "worker.mjs", modulesRoot: "/", modules: { "worker.mjs": { type: "esm", contents: source.text } } },
    compatibilityDate: "2025-12-01", compatibilityFlags: ["nodejs_compat"],
    exports: { FacetReadRoot: { type: "durable-object", storage: "sqlite" } },
    env: { FacetReadRoot: { type: "durable-object", worker: "retained-facet-proof", exportName: "FacetReadRoot" } },
  } }],
});
try {
  const retained = (starts: number, recovered: number, owed: number) => JSON.stringify({
    kind: "retained", marker: "retained",
    state: [...(recovered ? [{ kind: "recovered", value: recovered }] : []), { kind: "starts", value: starts }], owed,
  });
  const cases = [
    { operation: "missing", expected: '{"present":false,"registry":0}' },
    { operation: "seed", expected: retained(1, 0, 1) },
    { operation: "raw", expected: retained(1, 0, 1) },
    { operation: "normal", expected: retained(1, 0, 1) },
    { operation: "abort", expected: '{"aborted":true}' },
    { operation: "raw", expected: retained(1, 0, 1) },
    { operation: "normal", expected: retained(2, 1, 0) },
    { operation: "normal", expected: retained(2, 1, 0) },
    { operation: "nested-seed", expected: retained(1, 0, 1) },
    { operation: "nested-raw", expected: retained(1, 0, 1) },
    { operation: "abort", expected: '{"aborted":true}' },
    { operation: "nested-raw", expected: retained(1, 0, 1) },
    { operation: "nested-normal", expected: retained(2, 1, 0) },
    { operation: "wipe", expected: '{"wiped":true}' },
    { operation: "abort", expected: '{"aborted":true}' },
    { operation: "raw", expected: '{"kind":"missing-history"}' },
  ];
  for (const entry of cases) {
    const response = await runtime.dispatchFetch(`http://probe/${entry.operation}`);
    const result = await response.text();
    assert.equal(response.status, 200, result);
    assert.equal(result, entry.expected, entry.operation);
    console.log(JSON.stringify({ operation: entry.operation, result, passed: true }));
  }
} finally {
  await runtime.dispose();
}
