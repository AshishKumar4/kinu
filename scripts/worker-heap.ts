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
import { dirname, join, normalize, resolve as resolvePath } from 'node:path';
import { literalString, parse, walk } from './syntax';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import * as v from 'valibot';
import { ownerCaller } from '../packages/core/src/safety/workspace-capability';
import { workersAiBinding } from '../packages/cf-backend/tests/helpers/workers-ai-binding';

const REPO_ROOT = join(import.meta.dir, '..');

const CF_BACKEND = join(REPO_ROOT, 'packages/cf-backend');

const DIST = join(CF_BACKEND, 'dist/kinu');

export const GATE = 'worker-heap';

/** Measured 2026-10-02: 42.7 and 42.6 MB on lane/nimbus-014 2b6eb90d5 (Nimbus 0.14), 42.5 MB on integration 33d93e529
 *  (0.13.1); plus the same 7 MB of room the 48.9 MB in the header had, for the product to grow before this row asks why. */
export const HEAP_AFTER_SETUP_BOUND_BYTES = 50_000_000;

/** Measured 2026-09-26 at {@link STEP} (2.4 MB of answers): 9.8 MB live in the parked step; 7.3 MB once the Workers
 *  AI fetch stopped copying the request; 4.8 MB once our own prompt text left no character above U+00FF, so V8
 *  keeps the request JSON one byte per character. */
export const STEP_LIVE_BOUND_BYTES = 5_500_000;

/** Pre-header cost, measured 2026-09-29 with the native Ai binding and the same 12-answer transcript: 7.2 MB
 * live, including two serialized requests (2,466,160 and 2,466,104 bytes). The platform's
 * `cloudflare-internal:ai-api.#generateFetch` holds its inputs JSON until HTTP headers arrive; the product's
 * retry frame holds init.body until it can read the response status. A snapshot after SSE headers found neither
 * serialized request nor a live #generateFetch frame; the mid-stream step's measured delta was -0.1 MB. Bound unchanged.
 * So the step is read once the product reports the answer's first byte, not at the driver's park: on 2026-09-30 a
 * loaded CI tier read the park before the headers arrived and found 7.1 MB. */

/** Measured 2026-09-27 at {@link HEADS}: 7.7 MB on main 20cacf3423, every released head's runtime held by the
 *  workspace's mount table; 1.1 MB once release unmounts it: Nimbus's inode cache of the homes still on disk and
 *  code compiled for the heads, neither of them per released actor. */
export const HEADS_RETAINED_BOUND_BYTES = 1_500_000;

/** Measured 2026-09-27 at {@link HELPERS}: 0.8 MB on main 905d6665d4, each helper's chat room keeping its whole
 *  streamed answer; 0.0-0.1 MB over 3 runs once no room keeps an answer. */
export const PER_HELPER_RETAINED_BOUND_BYTES = 250_000;

/** Measured 2026-09-27 at {@link HELPERS}, one helper held on its fourth model call: 4.0 and 3.9 MB on main
 *  905d6665d4, where the Workers AI fetch kept its parsed copy of the request for the whole call; 2.7-3.3 MB over 3
 *  runs once only the binding's inputs hold it. The rest is the transcript three ways: the session's rows, the AI
 *  SDK's record of the call's response messages, and the request JSON the retry wrapper keeps for a resend. */
export const HELPER_TURN_LIVE_BOUND_BYTES = 3_600_000;

/** Measured 2026-09-29 at {@link HELPERS}, a helper with 4 pages of 1 MB whose turn ended waiting on its own hire, held:
 *  8.1-8.8 MB over 8 runs on integration 36aa590761. Every figure before this row waited on its hire's runner read a
 *  stale park (1-2 MB, before the tree started) or the helper's own next step (16-17 MB, mid-turn over its pages). */
export const WAITING_PARENT_LIVE_BOUND_BYTES = 14_500_000;

/** Measured 2026-10-01 at {@link LONG_TURN}, after the setup, step and heads above in the same isolate: 98.4-104.5 MB
 *  used over 3 runs on lane/staging-fix-1 c7beb9ce1. The collector decides when garbage goes, hence the spread; this
 *  row trips only as the peak nears the 128 MB isolate, and the growth row below is the one that pins what a turn keeps. */
export const LONG_TURN_PEAK_BOUND_BYTES = 124_000_000;

/** Measured 2026-10-01 at {@link LONG_TURN}: 2.9-6.8 MB over 7 runs on lane/staging-fix-1 c7beb9ce1; 32.1-35.2 MB over
 *  2 with each step's request body left on the AI SDK's record (98517e993 reverted), as production 2f660875cc ran.
 *  The `file stat` turn this row measured before read 7.7 MB for that defect against 3.6-4.0 MB: its requests shared
 *  the history's strings, where the hosted providers' path copies them for every request. */
export const LONG_TURN_GROWTH_BOUND_BYTES = 12_000_000;

/** Measured 2026-09-26 at {@link STEP} before any copy fix: 13.5 MB, the transcript and, whole, the last request;
 *  11.1 MB (twice) on 2026-09-27 once the root's chat room no longer keeps each answer; 9.8-10.0 MB over 3 runs on
 *  integration 48fa23c62 (2026-09-30), 7.6-7.8 MB over 4 once a turn keeps its origin as a revision, not a clone. */
export const IDLE_RETAINED_BOUND_BYTES = 8_800_000;

const WranglerSchema = v.object({
  compatibility_date: v.string(),
  compatibility_flags: v.array(v.string()),
  vars: v.record(v.string(), v.string()),
  r2_buckets: v.array(v.object({ binding: v.string() })),
  kv_namespaces: v.array(v.object({ binding: v.string() })),
  durable_objects: v.object({ bindings: v.array(v.object({ name: v.string(), class_name: v.string() })) }),
  assets: v.object({ binding: v.string(), directory: v.string() }),
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
interface ProfileNode {
  readonly callFrame: { readonly functionName: string; readonly url: string; readonly lineNumber: number };
  readonly selfSize: number;
  readonly children: readonly ProfileNode[];
}

const ProfileNodeSchema: v.GenericSchema<ProfileNode> = v.object({
  callFrame: v.object({ functionName: v.string(), url: v.string(), lineNumber: v.number() }),
  selfSize: v.number(),
  children: v.array(v.lazy(() => ProfileNodeSchema)),
});

const SamplingReplySchema = v.object({ result: v.object({ profile: v.object({ head: ProfileNodeSchema }) }) });

interface Allocations {
  readonly total: number;
  readonly sites: readonly { readonly site: string; readonly bytes: number }[];
}

function frameName(node: ProfileNode): string {
  const { functionName, url, lineNumber } = node.callFrame;

  return `${functionName === '' ? '(anonymous)' : functionName} ${url.split('/').slice(-2).join('/')}:${String(lineNumber + 1)}`;
}

/** Every sampled allocation by the function that made it and its caller, collected or not: the churn, not what stays. */
function allocationSites(head: ProfileNode): Allocations {
  const bySite = new Map<string, number>();
  const pending: { node: ProfileNode; caller: string }[] = [{ node: head, caller: '' }];
  let total = 0;

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const name = frameName(next.node);
    const site = next.caller === '' ? name : `${name}  <-  ${next.caller}`;
    bySite.set(site, (bySite.get(site) ?? 0) + next.node.selfSize);
    total += next.node.selfSize;
    pending.push(...next.node.children.map((node) => ({ node, caller: name })));
  }

  const sites = [...bySite].map(([site, bytes]) => ({ site, bytes })).sort((a, b) => b.bytes - a.bytes).slice(0, 25);

  return { total, sites };
}

async function inspect(port: number): Promise<{
  readonly usedHeap: () => Promise<number>;
  readonly liveHeap: () => Promise<number>;
  readonly sampleAllocations: () => Promise<void>;
  readonly allocations: () => Promise<Allocations>;
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
  const send = (method: string, params?: Readonly<Record<string, number | boolean>>): Promise<string> => {
    next += 1;
    const answer = Promise.withResolvers<string>();
    replies.set(next, answer.resolve);
    socket.send(JSON.stringify({ id: next, method, ...(params !== undefined && { params }) }));

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
    sampleAllocations: async () => {
      await send('HeapProfiler.startSampling', { samplingInterval: 65_536, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    },
    allocations: async () => allocationSites(v.parse(SamplingReplySchema, JSON.parse(await send('HeapProfiler.stopSampling'))).result.profile.head),
    close: () => { socket.close(); },
  };
}

/** The swarm the release bound is about: WARM heads host every lazy module first, then COUNT come and go. */
export const HEADS = { warm: 5, count: 200 } as const;

/** The delegation the helper bound is about: the root hires COUNT task helpers, each working 4 pages of
 *  ANSWER_BYTES (`worker-heap/driver.ts`) before a one-word answer. */
export const HELPERS = { warm: 2, count: 12, answerBytes: 200_000, waitingPageBytes: 1_000_000 } as const;

/**
 * The long turn the peak and growth bounds are about: `steps` model calls on the OpenAI-compatible path, each writing a
 * page of `stepBytes` through the file tool. That path rebuilds every message of the history for each request, with a
 * fresh copy of each earlier call's arguments, so whatever keeps a request keeps the turn so far again.
 */
export const LONG_TURN = { steps: 150, stepBytes: 3000 } as const;

/** The host the product's OpenAI-compatible credential names; its requests go to the driver, any other is refused. */
const COMPAT_HOST = 'model.invalid';

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
  /** What a workspace holds live per finished task helper after {@link HELPERS} settle, beyond before them. */
  readonly perHelperRetained: number;
  /** What one running helper turn holds live, parked on its last working step, beyond the settled workspace. */
  readonly helperTurnLive: number;
  /** What a helper holds live while it waits on a helper of its own, with the root waiting on it, beyond settled. */
  readonly waitingParentLive: number;
  /** The most used heap (uncollected) read at any model call of {@link LONG_TURN}. */
  readonly longTurnPeak: number;
  /** What {@link LONG_TURN} holds live at its last model call beyond its first. */
  readonly longTurnGrowth: number;
  readonly longTurnAllocated: Allocations;
  /** Each character above U+00FF in the requests, with the text before it; the scripted turns write none. */
  readonly wide: readonly string[];
}

export async function measure(): Promise<HeapMeasurement> {
  const wrangler = v.parse(WranglerSchema, JSON.parse(readFileSync(join(DIST, 'wrangler.json'), 'utf8')));
  const key = btoa('worker-heap-credential-key-32byt');
  const port = await freePort();
  const compat = { compatibilityDate: wrangler.compatibility_date, compatibilityFlags: wrangler.compatibility_flags };

  let driver: Awaited<ReturnType<Miniflare['getWorker']>>;

  // The product's own reports that a streamed answer's first byte arrived, counted: only then are its response
  // headers in. The driver's park starts before they leave it.
  let firstBytes = 0;

  // A native Ai binding transports cancellation to this local backend; an RPC fake cannot transport a facet's signal.
  const ai = await workersAiBinding((request) => driver.fetch('http://driver.invalid/ai', {
    method: request.method, body: request.body, signal: request.signal,
  }));

  const mf = new Miniflare(convertV4MiniflareOptions({
    inspectorPort: port,
    // Miniflare's default handler, printing every line as it would, plus the count above.
    handleStructuredLogs: ({ level, message }) => {
      if (message.includes('"event":"workers_ai.direct_stream_first_byte"')) firstBytes += 1;

      if (level === 'error' || level === 'warn') console.error(message);
      else console.log(message);
    },
    workers: [{
      name: 'kinu', ...compat, modulesRoot: DIST, modules: await productModules(), workerLoaders: { LOADER: {} },
      bindings: { ...wrangler.vars, CREDENTIAL_ENCRYPTION_KEY: key },
      ai,
      assets: { binding: wrangler.assets.binding, directory: resolvePath(DIST, wrangler.assets.directory) },
      r2Buckets: wrangler.r2_buckets.map((bucket) => bucket.binding),
      kvNamespaces: wrangler.kv_namespaces.map((namespace) => namespace.binding),
      durableObjects: Object.fromEntries(wrangler.durable_objects.bindings.map((binding) =>
        [binding.name, { className: binding.class_name, useSQLite: true }])),
      outboundService: (request) => {
        if (new URL(request.url).hostname !== COMPAT_HOST) throw new Error(`worker-heap: the product reached the network at ${request.url}`);

        // Its own host header would name no route of the driver's.
        return driver.fetch(request.url, { method: request.method, body: request.body });
      },
    }, {
      name: 'driver', ...compat,
      modules: [{ type: 'ESModule', path: join(DIST, 'worker-heap-driver.js'), contents: await bundled('driver.ts') }],
      bindings: { OWNER_TOKEN: v.parse(OwnerCallerSchema, await ownerCaller({ CREDENTIAL_ENCRYPTION_KEY: key })).ownerToken, COMPAT_HOST },
      durableObjects: {
        HEAP_DRIVER: { className: 'HeapDriver', useSQLite: true },
        OrchestratorAgent: { className: 'OrchestratorAgent', scriptName: 'kinu', useSQLite: true },
        UserDO: { className: 'UserDO', scriptName: 'kinu', useSQLite: true },
      },
    }],
  }));

  try {
    driver = await mf.getWorker('driver');

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
      const answered = firstBytes;
      await ask(`/model?answerBytes=${String(STEP.answerBytes)}&holding=1`);
      const parked = ask('/turn?workspace=heap&text=parked');
      const waiting = v.object({ parked: v.number(), wide: v.array(v.string()) });

      // Parked mid-stream: the driver holds the call, and the product has read the answer's first byte. Read at the
      // park alone, a loaded CI tier caught the step before its headers, holding the pre-header cost (2026-09-30).
      while (firstBytes === answered
        || v.parse(waiting, JSON.parse(await ask(`/model?answerBytes=${String(STEP.answerBytes)}&holding=1`))).parked === 0) {
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

      await ask('/?workspace=long&compat=1');
      await ask(`/model?answerBytes=0&toolSteps=${String(LONG_TURN.steps - 1)}&stepBytes=${String(LONG_TURN.stepBytes)}`);
      await inspector.sampleAllocations();
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
      const longTurnAllocated = await inspector.allocations();

      // A root turn returns once it has hired; its helpers' turns end with their runners, each after its release.
      const noRunners = async (left: number): Promise<void> => {
        while (v.parse(v.number(), JSON.parse(await ask('/runners?workspace=helpers'))) > left) await Bun.sleep(50);
      };

      const HelperStateSchema = v.object({ calls: v.number(), helpersAnswered: v.number() });

      // Settled: every helper answered and no model call arrived for half a second.
      const hire = async (count: number): Promise<void> => {
        await ask(`/model?answerBytes=${String(HELPERS.answerBytes)}&hires=${String(count)}`);
        await ask('/turn?workspace=helpers&text=HIRE-ROOT');
        let last = -1;

        for (;;) {
          const state = v.parse(HelperStateSchema, JSON.parse(await ask('/model')));

          if (state.helpersAnswered >= count && state.calls === last) break;
          last = state.calls;
          await Bun.sleep(500);
        }
      };

      await ask('/?workspace=helpers');
      await hire(HELPERS.warm);
      const beforeHelpers = await inspector.liveHeap();
      await hire(HELPERS.count);
      const settledHelpers = await inspector.liveHeap();
      const perHelperRetained = (settledHelpers - beforeHelpers) / HELPERS.count;

      // One helper held at its last working step: what a running helper turn holds beyond a settled one.
      await ask(`/model?answerBytes=${String(HELPERS.answerBytes)}&hires=1&holdHelper=1`);
      const running = ask('/turn?workspace=helpers&text=HIRE-ROOT');

      while (!v.parse(v.object({ helperParked: v.boolean() }), JSON.parse(await ask('/model'))).helperParked) await Bun.sleep(50);
      const helperTurnLive = await inspector.liveHeap() - settledHelpers;
      await ask('/model?holdHelper=0');
      await running;
      await noRunners(0);

      // The helper, its pages written, hires one of its own, held on its first call: the helper and the root wait.
      await ask(`/model?answerBytes=${String(HELPERS.waitingPageBytes)}&hires=1&nest=1&holdHelper=1`);
      const nested = ask('/turn?workspace=helpers&text=HIRE-ROOT');

      while (!v.parse(v.object({ helperParked: v.boolean() }), JSON.parse(await ask('/model'))).helperParked) await Bun.sleep(50);

      // Waiting: the helper's turn ended with its hire's answer owed, so the held hire's runner is the only one left.
      await noRunners(1);
      const waitingParentLive = await inspector.liveHeap() - settledHelpers;
      await ask('/model?holdHelper=0');
      await nested;
      await noRunners(0);
      await ask('/model?hires=0&nest=0');

      return { afterSetup, stepLive: during - idle, idleRetained: idle - setUp, headsRetained, perHelperRetained, helperTurnLive, waitingParentLive, longTurnPeak, longTurnGrowth: lastLive - firstLive, longTurnAllocated, wide };
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
  // A deployed object dies of allocation bursts, not only of what it keeps (platform-catalog `worker.memory_kill_is_burst_sensitive`),
  // so the long turn's churn is named by the code that makes it.
  console.log(`${GATE}: the ${String(LONG_TURN.steps)}-step turn allocated ${mb(measured.longTurnAllocated.total)}; most by`);

  for (const site of measured.longTurnAllocated.sites) console.log(`  ${mb(site.bytes).padStart(9)}  ${site.site}`);
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

  if (measured.perHelperRetained > PER_HELPER_RETAINED_BOUND_BYTES) {
    findings.push(`each finished task helper leaves ${mb(measured.perHelperRetained)} live, over ${mb(PER_HELPER_RETAINED_BOUND_BYTES)}`);
  }

  if (measured.helperTurnLive > HELPER_TURN_LIVE_BOUND_BYTES) {
    findings.push(`a running helper turn holds ${mb(measured.helperTurnLive)} live, over ${mb(HELPER_TURN_LIVE_BOUND_BYTES)}`);
  }

  if (measured.waitingParentLive > WAITING_PARENT_LIVE_BOUND_BYTES) {
    findings.push(`a helper waiting on its own hire holds ${mb(measured.waitingParentLive)} live, over ${mb(WAITING_PARENT_LIVE_BOUND_BYTES)}`);
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
    + `${String(HEADS.count)} released heads leave ${mb(measured.headsRetained)}, a finished helper `
    + `${mb(measured.perHelperRetained)}, a running helper turn ${mb(measured.helperTurnLive)}, a helper waiting on its `
    + `own hire ${mb(measured.waitingParentLive)}, a ${String(LONG_TURN.steps)}-step turn peaks at `
    + `${mb(measured.longTurnPeak)} used and grows ${mb(measured.longTurnGrowth)} live; no wasm on the static graph, every module ASCII, every request Latin-1`);
  console.log('  blind: garbage is sampled once per model call, so a spike inside a step is missed; transcripts shaped unlike these; and memory outside V8 (compiled wasm, SQLite pages)');

  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
