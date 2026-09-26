/**
 * The built Worker's heap after one workspace's setup, in workerd, before any turn: what every Durable Object
 * isolate pays out of its 128 MB before it serves. The product bundle is the one `vite build` writes for the
 * deploy (`packages/cf-backend/dist/kinu`), loaded in an isolate of its own; `scripts/worker-heap/driver.ts`
 * claims a workspace and sets its soul and model through the product's RPC, and V8's own count is read over
 * the inspector.
 *
 * Measured 2026-09-26 on main abbd2c74b5, this harness: 76.4 MB used as the deploy then built it (unminified,
 * one module holding 5,231 characters above U+00FF, so V8 kept its 10.7 M characters two bytes each), 58.1 MB
 * minified, 48.9 MB minified with ASCII-only output. esbuild's 11.9 MB wasm, then instantiated at load by a
 * static import, is outside V8's count; its absence is checked on the module graph instead.
 *
 * `--no-build` reads the existing `dist/kinu` (a deploy already built it).
 */

import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, normalize } from 'node:path';
import { literalString, parse, walk } from './syntax';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import * as v from 'valibot';
import { ownerCaller } from '../packages/core/src/safety/workspace-capability';

const REPO_ROOT = join(import.meta.dir, '..');

const CF_BACKEND = join(REPO_ROOT, 'packages/cf-backend');

const DIST = join(CF_BACKEND, 'dist/kinu');

export const GATE = 'worker-heap';

/** 48.9 MB measured (header), plus room for the product to grow before this row asks why. */
export const HEAP_AFTER_SETUP_BOUND_BYTES = 56_000_000;

const WranglerSchema = v.object({
  compatibility_date: v.string(),
  compatibility_flags: v.array(v.string()),
  vars: v.record(v.string(), v.string()),
  r2_buckets: v.array(v.object({ binding: v.string() })),
  kv_namespaces: v.array(v.object({ binding: v.string() })),
  durable_objects: v.object({ bindings: v.array(v.object({ name: v.string(), class_name: v.string() })) }),
});

const TargetsSchema = v.array(v.object({ id: v.string(), webSocketDebuggerUrl: v.string() }));

const HeapUsageSchema = v.object({ id: v.number(), result: v.object({ usedSize: v.number() }) });

const ManifestSchema = v.record(v.string(), v.object({ file: v.string(), assets: v.optional(v.array(v.string())) }));

/** Every module the build emitted, as Vite's manifest lists them: the chunks and the assets they import. */
function productModules(): { type: 'ESModule' | 'CompiledWasm'; path: string; contents: string | Uint8Array }[] {
  const manifest = v.parse(ManifestSchema, JSON.parse(readFileSync(join(DIST, '.vite/manifest.json'), 'utf8')));
  // The entry first: Miniflare runs the first module as the Worker's main.
  const emitted = new Set(['index.js', ...Object.values(manifest).flatMap((entry) => [entry.file, ...(entry.assets ?? [])])]);

  return [...emitted].filter((file) => file.endsWith('.js') || file.endsWith('.wasm')).map((file) => file.endsWith('.js')
    ? { type: 'ESModule' as const, path: join(DIST, file), contents: readFileSync(join(DIST, file), 'utf8') }
    : { type: 'CompiledWasm' as const, path: join(DIST, file), contents: readFileSync(join(DIST, file)) });
}

/** The specifiers `source` imports statically: the modules an isolate instantiates with it at load. */
function staticSpecifiers(file: string, source: string): readonly string[] {
  const found: string[] = [];

  walk(parse(file, source).root, ({ raw }) => {
    const declares = raw.type === 'ImportDeclaration' || raw.type === 'ExportNamedDeclaration' || raw.type === 'ExportAllDeclaration';
    const specifier = declares && raw.source !== null && raw.source !== undefined ? literalString(raw.source) : undefined;

    if (specifier !== undefined) found.push(specifier);
  });

  return found;
}

/** Every module `index.js` reaches by static import: each one is instantiated when an isolate loads. */
export function staticGraph(dist: string): readonly string[] {
  const reached = new Set<string>();
  const pending = ['index.js'];

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (reached.has(next)) continue;
    reached.add(next);

    if (!next.endsWith('.js')) continue;
    const base = dirname(next);

    for (const specifier of staticSpecifiers(next, readFileSync(join(dist, next), 'utf8'))) {
      if (specifier.startsWith('./')) pending.push(normalize(join(base, specifier)));
    }
  }

  return [...reached];
}

async function driverModule(): Promise<string> {
  const bundled = await build({
    entryPoints: [join(import.meta.dir, 'worker-heap/driver.ts')], bundle: true, write: false, format: 'esm',
    platform: 'neutral', mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser'], target: 'es2022',
    alias: Object.fromEntries(builtinModules.filter((name) => !name.startsWith('node:')).map((name) => [name, `node:${name}`])),
    external: ['cloudflare:*', 'node:*'], logLevel: 'silent',
  });

  const [output] = bundled.outputFiles;

  if (output === undefined) throw new Error('worker-heap: esbuild produced no driver module');

  return output.text;
}

const OwnerCallerSchema = v.object({ ownerToken: v.string() });

const BoundAddressSchema = v.object({ port: v.number() });

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = v.parse(BoundAddressSchema, server.address());
  await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });

  return address.port;
}

/** V8's used heap of the product isolate, uncollected, as `Runtime.getHeapUsage` reports it. */
async function usedHeap(port: number): Promise<number> {
  const targets = v.parse(TargetsSchema, await (await fetch(`http://127.0.0.1:${String(port)}/json`)).json());
  const product = targets.find((target) => target.id === 'core:user:kinu');

  if (product === undefined) throw new Error(`worker-heap: no inspector target for the product among ${targets.map((t) => t.id).join(', ')}`);
  const socket = new WebSocket(product.webSocketDebuggerUrl);
  const answer = Promise.withResolvers<number>();

  socket.addEventListener('message', (event) => {
    const parsed = v.safeParse(HeapUsageSchema, JSON.parse(String(event.data)));

    if (parsed.success && parsed.output.id === 1) answer.resolve(parsed.output.result.usedSize);
  });
  socket.addEventListener('error', () => { answer.reject(new Error('worker-heap: the inspector socket failed')); });
  socket.addEventListener('open', () => { socket.send(JSON.stringify({ id: 1, method: 'Runtime.getHeapUsage' })); });

  try {
    return await answer.promise;
  } finally {
    socket.close();
  }
}

export async function measure(): Promise<number> {
  const wrangler = v.parse(WranglerSchema, JSON.parse(readFileSync(join(DIST, 'wrangler.json'), 'utf8')));
  const key = btoa('worker-heap-credential-key-32byt');
  const port = await freePort();
  const compat = { compatibilityDate: wrangler.compatibility_date, compatibilityFlags: wrangler.compatibility_flags };

  const mf = new Miniflare(convertV4MiniflareOptions({
    inspectorPort: port,
    workers: [{
      name: 'kinu', ...compat, modulesRoot: DIST, modules: productModules(), workerLoaders: { LOADER: {} },
      bindings: { ...wrangler.vars, CREDENTIAL_ENCRYPTION_KEY: key },
      serviceBindings: { AI: { name: 'driver', entrypoint: 'RefusingAI' } },
      r2Buckets: wrangler.r2_buckets.map((bucket) => bucket.binding),
      kvNamespaces: wrangler.kv_namespaces.map((namespace) => namespace.binding),
      durableObjects: Object.fromEntries(wrangler.durable_objects.bindings.map((binding) =>
        [binding.name, { className: binding.class_name, useSQLite: true }])),
      outboundService: (request) => { throw new Error(`worker-heap: setup reached the network at ${request.url}`); },
    }, {
      name: 'driver', ...compat,
      modules: [{ type: 'ESModule', path: join(DIST, 'worker-heap-driver.js'), contents: await driverModule() }],
      bindings: { OWNER_TOKEN: v.parse(OwnerCallerSchema, await ownerCaller({ CREDENTIAL_ENCRYPTION_KEY: key })).ownerToken },
      durableObjects: {
        HEAP_DRIVER: { className: 'HeapDriver', useSQLite: true },
        OrchestratorAgent: { className: 'OrchestratorAgent', scriptName: 'kinu', useSQLite: true },
        UserDO: { className: 'UserDO', scriptName: 'kinu', useSQLite: true },
      },
    }],
  }));

  try {
    const response = await (await mf.getWorker('driver')).fetch('http://driver.invalid/?workspace=heap');

    if (response.status !== 204) throw new Error(`worker-heap: setup answered ${String(response.status)}: ${await response.text()}`);

    return await usedHeap(port);
  } finally {
    await mf.dispose();
  }
}

/** UTF-8 spends one byte per character only when every character is ASCII. */
function isWide(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') !== text.length;
}

async function main(args: readonly string[]): Promise<number> {
  if (!args.includes('--no-build')) {
    const built = Bun.spawnSync(['bunx', 'vite', 'build'], { cwd: CF_BACKEND, stdout: 'ignore', stderr: 'inherit' });

    if (built.exitCode !== 0) return built.exitCode;
  }

  const graph = staticGraph(DIST);
  const wasm = graph.filter((module) => module.endsWith('.wasm'));

  // One character above U+00FF stores a whole module's retained source two bytes per character.
  const wide = graph.filter((module) => module.endsWith('.js') && isWide(readFileSync(join(DIST, module), 'utf8')));
  const used = await measure();
  const findings: string[] = [];

  if (wide.length > 0) findings.push(`${wide.join(', ')} carry characters outside ASCII, which V8 keeps two bytes each`);

  if (wasm.length > 0) findings.push(`index.js instantiates ${wasm.join(', ')} at load: a static import reaches it`);

  if (used > HEAP_AFTER_SETUP_BOUND_BYTES) {
    findings.push(`used heap after setup ${(used / 1e6).toFixed(1)} MB exceeds ${(HEAP_AFTER_SETUP_BOUND_BYTES / 1e6).toFixed(1)} MB`);
  }

  if (findings.length > 0) {
    console.error(`${GATE}: ${String(findings.length)} finding(s)\n`);

    for (const each of findings) console.error(`  ${each}`);

    return 1;
  }

  console.log(`${GATE}: ok — ${(used / 1e6).toFixed(1)} MB used after setup (bound ${(HEAP_AFTER_SETUP_BOUND_BYTES / 1e6).toFixed(1)} MB), no wasm on the static graph, every module ASCII`);
  console.log('  blind: heap a turn or a large history adds, and memory outside V8 (compiled wasm, SQLite pages)');

  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
