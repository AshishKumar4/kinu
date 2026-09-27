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

/** Measured 2026-09-26 at {@link STEP} (2.4 MB of answers): 9.8 MB live in the parked step; 7.3 MB once the Workers
 *  AI fetch stopped copying the request; 4.8 MB once our own prompt text left no character above U+00FF, so V8
 *  keeps the request JSON one byte per character. */
export const STEP_LIVE_BOUND_BYTES = 5_500_000;

/** Measured 2026-09-27 at {@link HEADS}: 7.7 MB on main 20cacf3423, every released head's runtime held by the
 *  workspace's mount table; 1.1 MB once release unmounts it: Nimbus's inode cache of the homes still on disk and
 *  code compiled for the heads, neither of them per released actor. */
export const HEADS_RETAINED_BOUND_BYTES = 1_500_000;

/** Measured 2026-09-27 at {@link LONG_TURN}, after the setup, step and heads above in the same isolate: 104-116 MB
 *  used over 3 runs on main 20cacf3423, 99-115 MB over 8 once no step keeps its request body. The collector decides
 *  when garbage goes, hence the spread; 120 MB leaves 8 MB under the 128 MB isolate. */
export const LONG_TURN_PEAK_BOUND_BYTES = 120_000_000;

/** Measured 2026-09-27 at {@link LONG_TURN}: 7.7 MB on main 20cacf3423, where the AI SDK's record of every step
 *  kept its request body, a full copy of the message list; 3.6-4.0 MB over 10 runs once the body stays off the record. */
export const LONG_TURN_GROWTH_BOUND_BYTES = 5_000_000;

/** Measured 2026-09-26 at {@link STEP} before any copy fix: 13.5 MB, the transcript and, whole, the last request. */
export const IDLE_RETAINED_BOUND_BYTES = 14_500_000;

const WranglerSchema = v.object({
  compatibility_date: v.string(),
  compatibility_flags: v.array(v.string()),
  vars: v.record(v.string(), v.string()),
  r2_buckets: v.array(v.object({ binding: v.string() })),
  kv_namespaces: v.array(v.object({ binding: v.string() })),
  durable_objects: v.object({ bindings: v.array(v.object({ name: v.string(), class_name: v.string() })) }),
});

const TargetsSchema = v.array(v.object({ id: v.string(), webSocketDebuggerUrl: v.string() }));

const ManifestSchema = v.record(v.string(), v.object({ file: v.string(), assets: v.optional(v.array(v.string())) }));

/** Every module the build emitted, as Vite's manifest lists them, behind `worker-heap/product.ts` as the entry. */
async function productModules(): Promise<{ type: 'ESModule' | 'CompiledWasm'; path: string; contents: string | Uint8Array }[]> {
  const manifest = v.parse(ManifestSchema, JSON.parse(readFileSync(join(DIST, '.vite/manifest.json'), 'utf8')));
  const emitted = new Set(['index.js', ...Object.values(manifest).flatMap((entry) => [entry.file, ...(entry.assets ?? [])])]);

  const built = [...emitted].filter((file) => file.endsWith('.js') || file.endsWith('.wasm')).map((file) => file.endsWith('.js')
    ? { type: 'ESModule' as const, path: join(DIST, file), contents: readFileSync(join(DIST, file), 'utf8') }
    : { type: 'CompiledWasm' as const, path: join(DIST, file), contents: readFileSync(join(DIST, file)) });

  // The entry first: Miniflare runs the first module as the Worker's main.
  return [{ type: 'ESModule', path: join(DIST, 'worker-heap-product.js'), contents: await bundled('product.ts') }, ...built];
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

/** One of `worker-heap/`'s modules for workerd; `kinu:product` is the built bundle's `index.js` beside it. */
async function bundled(file: 'driver.ts' | 'product.ts'): Promise<string> {
  const result = await build({
    entryPoints: [join(import.meta.dir, 'worker-heap', file)], bundle: true, write: false, format: 'esm',
    platform: 'neutral', mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser'], target: 'es2022',
    alias: Object.fromEntries(builtinModules.filter((name) => !name.startsWith('node:')).map((name) => [name, `node:${name}`])),
    external: ['cloudflare:*', 'node:*'], logLevel: 'silent',
    plugins: [{
      name: 'kinu-product',
      setup: (plugin) => { plugin.onResolve({ filter: /^kinu:product$/ }, () => ({ path: './index.js', external: true })); },
    }],
  });

  const [output] = result.outputFiles;

  if (output === undefined) throw new Error(`worker-heap: esbuild produced no module for ${file}`);

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

const InspectorReplySchema = v.object({ id: v.number() });

const HeapUsageReplySchema = v.object({ result: v.object({ usedSize: v.number() }) });

const SnapshotChunkSchema = v.object({ method: v.literal('HeapProfiler.addHeapSnapshotChunk'), params: v.object({ chunk: v.string() }) });

const SnapshotSchema = v.object({
  snapshot: v.object({ meta: v.object({ node_fields: v.array(v.string()) }) }),
  nodes: v.array(v.number()),
});

/** One inspector session on the product isolate. */
async function inspect(port: number): Promise<{
  readonly usedHeap: () => Promise<number>;
  readonly liveHeap: () => Promise<number>;
  readonly close: () => void;
}> {
  const targets = v.parse(TargetsSchema, await (await fetch(`http://127.0.0.1:${String(port)}/json`)).json());
  const product = targets.find((target) => target.id === 'core:user:kinu');

  if (product === undefined) throw new Error(`worker-heap: no inspector target for the product among ${targets.map((t) => t.id).join(', ')}`);
  const socket = new WebSocket(product.webSocketDebuggerUrl);
  const opened = Promise.withResolvers<void>();
  const replies = new Map<number, (raw: string) => void>();
  let chunks: string[] = [];
  let next = 0;

  socket.addEventListener('open', () => { opened.resolve(); });
  socket.addEventListener('error', () => { opened.reject(new Error('worker-heap: the inspector socket failed')); });
  socket.addEventListener('message', (event) => {
    const raw = String(event.data);
    const message: unknown = JSON.parse(raw);
    const chunk = v.safeParse(SnapshotChunkSchema, message);

    if (chunk.success) {
      chunks.push(chunk.output.params.chunk);

      return;
    }

    const reply = v.safeParse(InspectorReplySchema, message);

    if (reply.success) replies.get(reply.output.id)?.(raw);
  });
  await opened.promise;

  /** The raw reply, which each caller parses for the field it asked for. */
  const send = (method: string): Promise<string> => {
    next += 1;
    const answer = Promise.withResolvers<string>();
    replies.set(next, answer.resolve);
    socket.send(JSON.stringify({ id: next, method }));

    return answer.promise;
  };

  return {
    // Uncollected: what the isolate holds at this instant, garbage included.
    usedHeap: async () => v.parse(HeapUsageReplySchema, JSON.parse(await send('Runtime.getHeapUsage'))).result.usedSize,
    // A snapshot collects first, so its node sizes add up to what is live.
    liveHeap: async () => {
      chunks = [];
      await send('HeapProfiler.takeHeapSnapshot');
      const snapshot = v.parse(SnapshotSchema, JSON.parse(chunks.join('')));
      chunks = [];
      const fields = snapshot.snapshot.meta.node_fields;
      const size = fields.indexOf('self_size');
      let live = 0;

      for (let at = size; at < snapshot.nodes.length; at += fields.length) live += snapshot.nodes[at] ?? 0;

      return live;
    },
    close: () => { socket.close(); },
  };
}

/** The swarm the release bound is about: WARM heads host every lazy module first, then COUNT come and go. */
export const HEADS = { warm: 5, count: 200 } as const;

/** The long turn the peak bound is about: STEPS model calls, each after a small `file stat` result. */
export const LONG_TURN = { steps: 150 } as const;

/** The step the heap bounds are about: TURNS turns of ANSWER_BYTES each, then one more parked on the model. */
export const STEP = { turns: 12, answerBytes: 200_000 } as const;

export interface HeapMeasurement {
  /** Used heap after one workspace's claim and setup. */
  readonly afterSetup: number;
  /** What a step parked on the model holds live beyond the idle workspace before it, at {@link STEP}. */
  readonly stepLive: number;
  /** What the idle workspace holds after {@link STEP}'s turns beyond right after setup. */
  readonly idleRetained: number;
  /** What a workspace holds live after {@link HEADS} heads were hosted and released, beyond before them. */
  readonly headsRetained: number;
  /** The most used heap (uncollected) read at any model call of {@link LONG_TURN}. */
  readonly longTurnPeak: number;
  /** What {@link LONG_TURN} holds live at its last model call beyond its first. */
  readonly longTurnGrowth: number;
  /** Each character above U+00FF in the requests, with the text before it; the scripted turns write none. */
  readonly wide: readonly string[];
}

export async function measure(): Promise<HeapMeasurement> {
  const wrangler = v.parse(WranglerSchema, JSON.parse(readFileSync(join(DIST, 'wrangler.json'), 'utf8')));
  const key = btoa('worker-heap-credential-key-32byt');
  const port = await freePort();
  const compat = { compatibilityDate: wrangler.compatibility_date, compatibilityFlags: [...wrangler.compatibility_flags, 'enable_abortsignal_rpc'] };

  const mf = new Miniflare(convertV4MiniflareOptions({
    inspectorPort: port,
    workers: [{
      name: 'kinu', ...compat, modulesRoot: DIST, modules: await productModules(), workerLoaders: { LOADER: {} },
      bindings: { ...wrangler.vars, CREDENTIAL_ENCRYPTION_KEY: key },
      serviceBindings: { AI: { name: 'driver', entrypoint: 'ScriptedAI' } },
      r2Buckets: wrangler.r2_buckets.map((bucket) => bucket.binding),
      kvNamespaces: wrangler.kv_namespaces.map((namespace) => namespace.binding),
      durableObjects: Object.fromEntries(wrangler.durable_objects.bindings.map((binding) =>
        [binding.name, { className: binding.class_name, useSQLite: true }])),
      outboundService: (request) => { throw new Error(`worker-heap: the product reached the network at ${request.url}`); },
    }, {
      name: 'driver', ...compat,
      modules: [{ type: 'ESModule', path: join(DIST, 'worker-heap-driver.js'), contents: await bundled('driver.ts') }],
      bindings: { OWNER_TOKEN: v.parse(OwnerCallerSchema, await ownerCaller({ CREDENTIAL_ENCRYPTION_KEY: key })).ownerToken },
      durableObjects: {
        HEAP_DRIVER: { className: 'HeapDriver', useSQLite: true },
        OrchestratorAgent: { className: 'OrchestratorAgent', scriptName: 'kinu', useSQLite: true },
        UserDO: { className: 'UserDO', scriptName: 'kinu', useSQLite: true },
      },
    }],
  }));

  try {
    const driver = await mf.getWorker('driver');

    const ask = async (path: string): Promise<string> => {
      const response = await driver.fetch(`http://driver.invalid${path}`);
      const body = await response.text();

      if (!response.ok) throw new Error(`worker-heap: ${path} answered ${String(response.status)}: ${body}`);

      return body;
    };

    await ask('/?workspace=heap');
    const inspector = await inspect(port);

    try {
      const afterSetup = await inspector.usedHeap();
      const setUp = await inspector.liveHeap();
      await ask(`/model?answerBytes=${String(STEP.answerBytes)}`);

      for (let turn = 0; turn < STEP.turns; turn++) await ask(`/turn?workspace=heap&text=turn-${String(turn)}`);
      const idle = await inspector.liveHeap();
      await ask(`/model?answerBytes=${String(STEP.answerBytes)}&holding=1`);
      const parked = ask('/turn?workspace=heap&text=parked');
      const waiting = v.object({ parked: v.number(), wide: v.array(v.string()) });

      // Each poll is a request to the driver, which answers only once the product's model call is parked.
      while (v.parse(waiting, JSON.parse(await ask(`/model?answerBytes=${String(STEP.answerBytes)}&holding=1`))).parked === 0) {
        await Bun.sleep(20);
      }

      const during = await inspector.liveHeap();
      const { wide } = v.parse(waiting, JSON.parse(await ask(`/model?answerBytes=${String(STEP.answerBytes)}&holding=1`)));
      await ask(`/model?answerBytes=${String(STEP.answerBytes)}`);
      await parked;

      await ask('/?workspace=heads');
      await ask(`/heads?workspace=heads&tag=warm&count=${String(HEADS.warm)}`);
      const beforeHeads = await inspector.liveHeap();
      await ask(`/heads?workspace=heads&tag=swarm&count=${String(HEADS.count)}`);
      const headsRetained = await inspector.liveHeap() - beforeHeads;

      await ask('/?workspace=long');
      await ask(`/model?answerBytes=0&toolSteps=${String(LONG_TURN.steps - 1)}`);
      const long = ask('/turn?workspace=long&text=long');
      let longTurnPeak = 0;
      let firstLive = 0;
      let lastLive = 0;

      // Each model call parks until released, so the read lands at every step of the turn.
      for (let step = 1; step <= LONG_TURN.steps; step++) {
        while (v.parse(v.object({ arrived: v.number() }), JSON.parse(await ask('/model'))).arrived < step) await Bun.sleep(2);
        longTurnPeak = Math.max(longTurnPeak, await inspector.usedHeap());

        if (step === 1) firstLive = await inspector.liveHeap();

        if (step === LONG_TURN.steps) lastLive = await inspector.liveHeap();
        await ask(`/model?released=${String(step)}`);
      }

      await long;

      return { afterSetup, stepLive: during - idle, idleRetained: idle - setUp, headsRetained, longTurnPeak, longTurnGrowth: lastLive - firstLive, wide };
    } finally {
      inspector.close();
    }
  } finally {
    await mf.dispose();
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function transcript(): string {
  return `${String(STEP.turns)} prior answers of ${mb(STEP.answerBytes)}`;
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
  const measured = await measure();
  const findings: string[] = [];

  if (wide.length > 0) findings.push(`${wide.join(', ')} carry characters outside ASCII, which V8 keeps two bytes each`);

  if (wasm.length > 0) findings.push(`index.js instantiates ${wasm.join(', ')} at load: a static import reaches it`);

  if (measured.afterSetup > HEAP_AFTER_SETUP_BOUND_BYTES) {
    findings.push(`used heap after setup ${mb(measured.afterSetup)} exceeds ${mb(HEAP_AFTER_SETUP_BOUND_BYTES)}`);
  }

  if (measured.stepLive > STEP_LIVE_BOUND_BYTES) {
    findings.push(`a parked step holds ${mb(measured.stepLive)} live at ${transcript()}, over ${mb(STEP_LIVE_BOUND_BYTES)}`);
  }

  // Our own prompt, tool and skill text: the owner's and the model's text may still carry such characters.
  for (const context of measured.wide) findings.push(`the request carries a character above U+00FF, so V8 keeps it two bytes each: ${JSON.stringify(context)}`);

  if (measured.idleRetained > IDLE_RETAINED_BOUND_BYTES) {
    findings.push(`the idle workspace holds ${mb(measured.idleRetained)} after ${transcript()}, over ${mb(IDLE_RETAINED_BOUND_BYTES)}`);
  }

  if (measured.headsRetained > HEADS_RETAINED_BOUND_BYTES) {
    findings.push(`${String(HEADS.count)} released heads leave ${mb(measured.headsRetained)} live, over ${mb(HEADS_RETAINED_BOUND_BYTES)}`);
  }

  if (measured.longTurnGrowth > LONG_TURN_GROWTH_BOUND_BYTES) {
    findings.push(`a ${String(LONG_TURN.steps)}-step turn holds ${mb(measured.longTurnGrowth)} more live at its last step than its first, over ${mb(LONG_TURN_GROWTH_BOUND_BYTES)}`);
  }

  if (measured.longTurnPeak > LONG_TURN_PEAK_BOUND_BYTES) {
    findings.push(`a ${String(LONG_TURN.steps)}-step turn peaks at ${mb(measured.longTurnPeak)} used, over ${mb(LONG_TURN_PEAK_BOUND_BYTES)}`);
  }

  if (findings.length > 0) {
    console.error(`${GATE}: ${String(findings.length)} finding(s)\n`);

    for (const each of findings) console.error(`  ${each}`);

    return 1;
  }

  console.log(`${GATE}: ok — ${mb(measured.afterSetup)} used after setup, a parked step holds ${mb(measured.stepLive)} live at `
    + `${transcript()}, the idle workspace holds ${mb(measured.idleRetained)} after them, `
    + `${String(HEADS.count)} released heads leave ${mb(measured.headsRetained)}, a ${String(LONG_TURN.steps)}-step turn peaks at `
    + `${mb(measured.longTurnPeak)} used and grows ${mb(measured.longTurnGrowth)} live; no wasm on the static graph, every module ASCII, every request Latin-1`);
  console.log('  blind: garbage is sampled once per model call, so a spike inside a step is missed; transcripts shaped unlike these; and memory outside V8 (compiled wasm, SQLite pages)');

  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
