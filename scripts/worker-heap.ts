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
 * Measured 2026-10-09 in workerd 1.20260930.2 (miniflare 5.20260926.0-alpha): setup now loads the workspace agent's
 * own isolate, and the workspace hands the Worker Loader the agent bundle's 6.2 MB of module text, garbage once loaded.
 * V8's uncollected count read 31.5 MB on 5681dfd92 (two runs) against 27.2-27.3 MB on e0cd7e435, which keeps the
 * agent in this isolate, while the live heap fell from 28.9 MB to 28.3 MB. So the setup bound is read on the live heap,
 * after the collection a heap snapshot makes, and is derived for that quantity: see {@link HEAP_AFTER_SETUP_BOUND_BYTES}.
 *
 * Since D9 main runs its model loop, transcript, claims and runs in that Worker Loader isolate, which workerd lists as
 * an inspector target of its own. Until 2026-10-09 this gate read the workspace's isolate alone, so a step, a long
 * turn and its churn moved out of every row: on 2ac877244 a parked step read 0.1 MB and the long turn grew 1.2 MB
 * (armada 20261010033405-50dc7e76), while main's isolate, unread, grew 6.5 MB and allocated 95-104 MB. A megabyte
 * planted in main's isolate at each turn's end, 2.1 MB over the step's turns, passed that gate and fails this one
 * (20261010040351-bbe46d65 and -78563353). Each isolate is now read and bounded on its own.
 *
 * `--no-build` reads the existing `dist/kinu` (a deploy already built it).
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { builtinModules } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, normalize, resolve as resolvePath } from 'node:path';
import { literalString, parse, walk } from './syntax';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import * as v from 'valibot';
import { ownerCaller } from '../packages/core/src/safety/workspace-capability';
import { workersAiBinding } from '../packages/cf-backend/tests/helpers/workers-ai-binding';
import { buildAgentBundle } from '../packages/cf-backend/vite-agent-bundle';
import { inspect, inspectAll, type Allocations, type HeapMakeup, type Inspector } from './worker-heap/inspector';

const REPO_ROOT = join(import.meta.dir, '..');

const CF_BACKEND = join(REPO_ROOT, 'packages/cf-backend');

const DIST = join(CF_BACKEND, 'dist/kinu');

export const GATE = 'worker-heap';

/** The live heap after setup, collected first. Measured 2026-10-09 on integration 44b13e946, three runs: 29.2, 28.9 and
 *  29.2 MB live (27.5 MB used each). The highest, 29.2 MB, plus 4 MB of room for the product to grow.
 *
 *  Main's isolate is read since 2026-10-09, once setup has joined the model change's detached call that loads it: on
 *  2ac877244 over 3 runs, 10.8-10.9 MB live there and 29.5 MB in the workspace's (armada 20261010034927-e852fa06).
 *  Each the highest plus the same 4 MB.
 *
 *  Until 2026-10-09 this bounded the used heap, garbage included, at 28.5 MB: 45.4 MB used on b0de8580f, where 15
 *  dependents each bundled their own zod; 35.7-36.5 MB over 3 runs on lane/memory-gap 9875bab49 with one; 26.4-26.5 MB
 *  on 871e789f1, where a module compiles when first imported (`new_module_registry`) and the slate vendor waits for a
 *  slate; 25.5-25.6 MB on a21347229, where a provider SDK loads with its first model; 24.4 MB on a9680b282, where core
 *  declares no import-time effects and passkeys and mail load their libraries per route; plus the same 4 MB. */
export const HEAP_AFTER_SETUP_BOUND_BYTES = { workspace: 33_500_000, main: 14_900_000 } as const;

/** Measured 2026-09-26 at {@link STEP} (2.4 MB of answers): 9.8 MB live in the parked step; 7.3 MB once the Workers
 *  AI fetch stopped copying the request; 4.8 MB once our own prompt text left no character above U+00FF, so V8
 *  keeps the request JSON one byte per character. Since D9 the step runs in main's isolate: on 2ac877244, 0.1 MB in
 *  the workspace's with main's unread; 0.2 MB there and 0.6 MB in main's over 3 runs once both are read
 *  (armada 20261010034927-e852fa06). Snapshots of one isolate vary by 0.3 MB (the heads row's two batches). */
export const STEP_LIVE_BOUND_BYTES = { workspace: 1_000_000, main: 1_500_000 } as const;

/** Pre-header cost, measured 2026-09-29 with the native Ai binding and the same 12-answer transcript: 7.2 MB
 * live, including two serialized requests (2,466,160 and 2,466,104 bytes). The platform's
 * `cloudflare-internal:ai-api.#generateFetch` holds its inputs JSON until HTTP headers arrive; the product's
 * retry frame holds init.body until it can read the response status. A snapshot after SSE headers found neither
 * serialized request nor a live #generateFetch frame; the mid-stream step's measured delta was -0.1 MB. Bound unchanged.
 * So the step is read once the product reports the answer's headers in, not at the driver's park: on 2026-09-30 a
 * loaded CI tier read the park before the headers arrived and found 7.1 MB. */

/** Measured 2026-09-27 at {@link HEADS}: 7.7 MB on main 20cacf3423, every released head's runtime held by the
 *  workspace's mount table; 1.1 MB once release unmounts it: Nimbus's inode cache of the homes still on disk and
 *  code compiled for the heads, neither of them per released actor.
 *
 *  Since 2026-10-09 a full batch warms the path first, so code V8 tiers up while heads come and go is not read as
 *  theirs (the first batch after five warm heads carried +397 compiled functions where integration 44b13e946 carried
 *  +297), and two batches after it are each bounded, so a retention one batch hides shows in the next. The step's
 *  workspace is quiesced before them: its compression pass, in flight in this isolate, read as 0.6 MB of one batch.
 *  Each head's "sandbox.executor_registered" line stays live only because this gate attaches an inspector: its
 *  retainer is the DevTools console's global handle, which V8 caps at 1000 messages; nothing of the product's holds it. */
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

/** Each agent isolate's live heap while the root, a helper and the helper's hire are all open: main's, every helper's
 *  the run hired, and the hire's. Measured 2026-10-10 at 02dab8bc0, three runs: 18 isolates, 12.5 to 17.8 MB, the
 *  largest the same in each; 1.2 MB of room above it. */
export const CONCURRENT_AGENT_LIVE_BOUND_BYTES = 19_000_000;

/** What the first turn of a workspace, parked mid-stream as {@link STEP}'s is, holds live beyond its setup: the cold
 *  step, before any turn warmed either isolate. Measured 2026-10-10 at 02dab8bc0, three runs alike: -0.5 MB in the
 *  workspace's (its setup's garbage collected first), 0.5 MB in main's. Over 36 more runs that day main's read 0.5 MB
 *  or 1.6 MB, both on 555bbf5c3 (2 of 15 at 1.6 MB) and on its successors (8 of 21), and the workspace's 0.3 MB at
 *  most: the highest of each with 1 MB of room. */
export const COLD_STEP_LIVE_BOUND_BYTES = { workspace: 1_300_000, main: 2_600_000 } as const;

/** A turn whose model asks for {@link FAILING_STEPS} reads of files no workspace has: each workspace tool call rejects
 *  back across the port, which the gate counts in main's ledger rather than assumes (a turn may stop short). */
export const FAILING_STEPS = 20;

/** What each isolate keeps of that turn once its workspace is quiet, beyond before it: a rejected call's pipeline and
 *  callbacks must go with it. Measured 2026-10-10 at 02dab8bc0, three runs alike: 0.2 MB in the workspace's, 1.3 MB in
 *  main's, which keeps the 20 refusals in its conversation. Each a step's worth of room above (`STEP_LIVE_BOUND_BYTES`'s
 *  scale): a pipeline kept per call would pass 20 of them. */
export const FAILED_PORT_RETAINED_BOUND_BYTES = { workspace: 1_000_000, main: 2_000_000 } as const;

/** Measured 2026-10-07 at {@link LONG_TURN}: 106.3-112.9 MB used over 3 runs on b0de8580f, 89.2-100.1 MB on
 *  lane/memory-gap 871e789f1. V8 grows the old generation by a factor of what is live, so this row falls only as the
 *  live heap does. Measured 2026-10-01, after the setup, step and heads above in the same isolate: 98.4-104.5 MB
 *  used over 3 runs on lane/staging-fix-1 c7beb9ce1. The collector decides when garbage goes, hence the spread; this
 *  row trips only as the peak nears the 128 MB isolate, and the growth row below is the one that pins what a turn keeps.
 *  Since D9 the turn's model loop runs in main's isolate, which has its own 128 MB: on 2ac877244, 41.9 MB in the
 *  workspace's with main's unread; 41.1-44.0 MB there and 30.6-31.2 MB in main's over 3 runs once both are read. */
export const LONG_TURN_PEAK_BOUND_BYTES = { workspace: 115_000_000, main: 115_000_000 } as const;

/** Measured 2026-10-07 at {@link LONG_TURN}: 6.9-7.1 MB over 3 runs on b0de8580f, about 1 MB of it the chat room's relay
 *  of every chunk body and 2 MB workerd's open-pipe promise chains. Measured 2026-10-01: 2.9-6.8 MB over 7 runs on lane/staging-fix-1
 *  c7beb9ce1; 32.1-35.2 MB over 2 with each step's request body left on the AI SDK's record (98517e993 reverted), as
 *  production 2f660875cc ran.
 *  The `file stat` turn this row measured before read 7.7 MB for that defect against 3.6-4.0 MB: its requests shared
 *  the history's strings, where the hosted providers' path copies them for every request.
 *  Since D9 the turn's history is main's: on 2ac877244, 1.2 MB in the workspace's isolate with main's unread; 1.1 MB
 *  there and 6.5 MB in main's over 3 runs once both are read (armada 20261010034927-e852fa06). */
export const LONG_TURN_GROWTH_BOUND_BYTES = { workspace: 2_500_000, main: 8_000_000 } as const;

/** Measured 2026-10-07 at {@link LONG_TURN}, sampled from its start to its settlement: 491-499 MB over 3 runs on
 *  b0de8580f, 351-362 MB on lane/memory-gap 9875bab49 once a tool's JSON Schema is built once and only a decode walks the
 *  SDK's message schema, 347-348 MB on a21347229 once a sealed step's own message skips it too, 360 MB in a whole-tier
 *  run; 316-321 MB on 3e0c5614c once a context revision touches only the entries it changed; 305-319 MB on e0f89081e
 *  once image-free prompts, file-free answers and an append-only step's cache pass untouched; 301.8-303.7 MB on
 *  4a6fee13c once replay normalization resumes per turn and inline payloads skip the runner; 289.0-301.0 MB on ed23aab1c
 *  once written events, render copies, frozen leaves and the context fill stop re-reading what they hold; 292.3-299.4 MB
 *  with the tool catalog (99cda9db0), 274.5-285.5 MB on c5c559cbe once steering, the context head's ids, settling, the
 *  sanitizer, the codec, the seal check, inline payloads, argument digests, span attributes and the agents sql stop
 *  copying or re-walking per step. The sampler's spread is about 15 MB; past this row, a per-step rebuild came back.
 *  Since D9 the turn runs in two isolates, of which this row read the workspace's alone until 2026-10-09: on 2ac877244
 *  over 3 runs, 145.8-153.1 MB together, 47.7-50.8 MB in the workspace's and 95.0-104.3 MB in main's
 *  (armada 20261010034927-e852fa06). A step moved from one isolate to the other is the same work.
 *  Until 2026-10-10 the read raced the turn's tail, about 20 MB in main's isolate and 10 MB in the workspace's: 143-154 MB
 *  in 7 of 9 runs before the turn-surface work (b9c667740) and 165-169 MB in 2, as on 5724b7472. Read at settlement, its
 *  sleep-time lane off: 171.6-183.0 MB over 15 runs on 0d3f6491a, 54-60 MB in the workspace's and 116-125 MB in main's. */
export const LONG_TURN_ALLOCATED_BOUND_BYTES = 195_000_000;

/** Measured 2026-09-26 at {@link STEP} before any copy fix: 13.5 MB, the transcript and, whole, the last request;
 *  11.1 MB (twice) on 2026-09-27 once the root's chat room no longer keeps each answer; 9.8-10.0 MB over 3 runs on
 *  integration 48fa23c62 (2026-09-30), 7.6-7.8 MB over 4 once a turn keeps its origin as a revision, not a clone.
 *  Since D9 the transcript is main's: on 2ac877244, 1.9 MB in the workspace's isolate with main's unread; 1.1 MB
 *  there and 2.6-2.7 MB in main's over 3 runs once setup joins main's load and both are read. */
export const IDLE_RETAINED_BOUND_BYTES = { workspace: 2_500_000, main: 4_000_000 } as const;

const WranglerSchema = v.object({
  compatibility_date: v.string(),
  compatibility_flags: v.array(v.string()),
  vars: v.record(v.string(), v.string()),
  r2_buckets: v.array(v.object({ binding: v.string() })),
  kv_namespaces: v.array(v.object({ binding: v.string() })),
  durable_objects: v.object({ bindings: v.array(v.object({ name: v.string(), class_name: v.string() })) }),
  assets: v.object({ binding: v.string(), directory: v.string() }),
});

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

/** The swarm the release bound is about: WARM heads host every lazy module and tier up the code they run first, then
 *  COUNT come and go, twice, each batch bounded. */
export const HEADS = { warm: 200, count: 200 } as const;

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

/** A figure in each isolate a root turn runs in: the workspace's, which every workspace object here shares, and main's
 *  own Worker Loader isolate, which keeps its model loop, transcript, claims and runs (D9). Each has its own 128 MB.
 *  Each workspace's main has an isolate of its own: the step's figures are its workspace's main, the long turn's its. */
export interface Isolates<T> {
  readonly workspace: T;
  readonly main: T;
}

const ISOLATES = ['workspace', 'main'] as const;

const ISOLATE_NAMES = { workspace: "the workspace's isolate", main: "main's isolate" } as const;

/** Main's Worker Loader isolate (D9): its loader key carries its workspace's object id, and main is the one agent a
 *  workspace has before it hires (`agent-facets.ts`, `agentFacet`). */
function mainOf(workspace: string): (id: string) => boolean {
  return (id) => id.startsWith('LOADER:') && id.includes(`:${workspace}:`);
}

/** `read` in each isolate, the workspace's first. */
async function inEach<T>(sessions: Isolates<Inspector>, read: (session: Inspector) => Promise<T>): Promise<Isolates<T>> {
  return { workspace: await read(sessions.workspace), main: await read(sessions.main) };
}

/** What each isolate holds beyond `before`. */
function beyond(after: Isolates<number>, before: Isolates<number>): Isolates<number> {
  return { workspace: after.workspace - before.workspace, main: after.main - before.main };
}

/**
 * Planted in each isolate in turn at the end of the run and read back: a gate that read the wrong isolate, or none,
 * would bound nothing there. Bigger than any step's bound, so a misread one is not lost in the noise of a turn.
 */
export const PLANTED_BYTES = 4_000_000;

/** The built assets with main's isolate swapped for the shipped facet plus `plant` (`tests/workerd/heap-plant-agent.ts`). */
function plantingAssets(directory: string): string {
  const assets = mkdtempSync(join(tmpdir(), 'kinu-worker-heap-assets-'));

  cpSync(directory, assets, { recursive: true });
  writeFileSync(join(assets, '_agent/modules.json'), JSON.stringify(buildAgentBundle(join(CF_BACKEND, 'tests/workerd/heap-plant-agent.ts')).modules));

  return assets;
}

export interface HeapMeasurement {
  /** What a step parked on the model holds live beyond the idle workspace before it, at {@link STEP}. */
  readonly stepLive: Isolates<number>;
  /** What the idle workspace holds after {@link STEP}'s turns beyond right after setup. */
  readonly idleRetained: Isolates<number>;
  /** What a workspace holds live after each of two batches of {@link HEADS} heads was hosted and released, beyond before it. */
  readonly headsRetained: readonly number[];
  /** What a workspace holds live per finished task helper after {@link HELPERS} settle, beyond before them. */
  readonly perHelperRetained: number;
  /** What one running helper turn holds live, parked on its last working step, beyond the settled workspace. */
  readonly helperTurnLive: number;
  /** What a helper holds live while it waits on a helper of its own, with the root waiting on it, beyond settled. */
  readonly waitingParentLive: number;
  /** Each agent isolate's live heap at that wait, main's and each helper's: every one of them is open at once. */
  readonly concurrentAgentsLive: readonly number[];
  /** What a turn of failing workspace tool calls left live once quiet, beyond before it. */
  readonly failedPortRetained: Isolates<number>;
  /** That turn's tool calls that came back failed, as main's ledger records them. */
  readonly failedPortCalls: number;
  /** What a fresh workspace's first turn, parked mid-stream, holds live beyond its setup. */
  readonly coldStepLive: Isolates<number>;
  /** The most used heap (uncollected) read at any model call of {@link LONG_TURN}. */
  readonly longTurnPeak: Isolates<number>;
  /** What {@link LONG_TURN} holds live at its last model call beyond its first. */
  readonly longTurnGrowth: Isolates<number>;
  readonly longTurnAllocated: Isolates<Allocations>;
  readonly setupMakeup: Isolates<HeapMakeup>;
  /** Live (collected) heap: after setup, and at the long turn's first and last steps. */
  readonly live: { readonly setUp: Isolates<number>; readonly longTurnFirst: Isolates<number>; readonly longTurnLast: Isolates<number> };
  /** What {@link STEP}'s turns allocated on the Workers AI binding path, collected or not. */
  readonly bindingTurnsAllocated: Isolates<Allocations>;
  /** Each character above U+00FF in the requests, with the text before it; the scripted turns write none. */
  readonly wide: readonly string[];
  /** For each isolate {@link PLANTED_BYTES} were planted in, the live heap it added in each isolate. */
  readonly planted: Isolates<Isolates<number>>;
}

export async function measure(): Promise<HeapMeasurement> {
  const wrangler = v.parse(WranglerSchema, JSON.parse(readFileSync(join(DIST, 'wrangler.json'), 'utf8')));
  const key = btoa('worker-heap-credential-key-32byt');
  const port = await freePort();
  const compat = { compatibilityDate: wrangler.compatibility_date, compatibilityFlags: wrangler.compatibility_flags };
  // Removed with the run, below: one a run cut short is left to preflight, which counts `kinu-`.
  const assets = plantingAssets(resolvePath(DIST, wrangler.assets.directory));

  let driver: Awaited<ReturnType<Miniflare['getWorker']>>;

  // The product's own reports that a streamed answer's headers are in, counted. The driver's park starts before they
  // leave it.
  let streamsOpened = 0;

  // A native Ai binding transports cancellation to this local backend; an RPC fake cannot transport a facet's signal.
  const ai = await workersAiBinding((request) => driver.fetch('http://driver.invalid/ai', {
    method: request.method, body: request.body, signal: request.signal,
  }));

  const mf = new Miniflare(convertV4MiniflareOptions({
    inspectorPort: port,
    // Miniflare's default handler, printing every line as it would, plus the count above.
    handleStructuredLogs: ({ level, message }) => {
      if (message.includes('"event":"provider.stream_opened"')) streamsOpened += 1;

      if (level === 'error' || level === 'warn') console.error(message);
      else console.log(message);
    },
    workers: [{
      name: 'kinu', ...compat, modulesRoot: DIST, modules: await productModules(), workerLoaders: { LOADER: {} },
      bindings: { ...wrangler.vars, CREDENTIAL_ENCRYPTION_KEY: key },
      ai,
      assets: { binding: wrangler.assets.binding, directory: assets },
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

    const stepWorkspace = await ask('/?workspace=heap');
    const sessions: Inspector[] = [];

    try {
      const workspace = await inspect(port, ISOLATE_NAMES.workspace, (id) => id === 'core:user:kinu');
      sessions.push(workspace);
      const stepIsolates = { workspace, main: await inspect(port, `${ISOLATE_NAMES.main} in the step's workspace`, mainOf(stepWorkspace)) };
      sessions.push(stepIsolates.main);
      const setUp = await inEach(stepIsolates, async (session) => await session.liveHeap());
      const setupMakeup = await inEach(stepIsolates, async (session) => await session.makeup());
      await ask(`/model?answerBytes=${String(STEP.answerBytes)}`);
      await inEach(stepIsolates, async (session) => { await session.sampleAllocations(); });

      for (let turn = 0; turn < STEP.turns; turn++) await ask(`/turn?workspace=heap&text=turn-${String(turn)}`);
      const bindingTurnsAllocated = await inEach(stepIsolates, async (session) => await session.allocations());
      const idle = await inEach(stepIsolates, async (session) => await session.liveHeap());
      const answered = streamsOpened;
      await ask(`/model?answerBytes=${String(STEP.answerBytes)}&holding=1`);
      const parked = ask('/turn?workspace=heap&text=parked');
      const waiting = v.object({ parked: v.number(), wide: v.array(v.string()) });

      // Parked mid-stream: the driver holds the call, and the product has the answer's headers. Read at the
      // park alone, a loaded CI tier caught the step before its headers, holding the pre-header cost (2026-09-30).
      while (streamsOpened === answered
        || v.parse(waiting, JSON.parse(await ask(`/model?answerBytes=${String(STEP.answerBytes)}&holding=1`))).parked === 0) {
        await Bun.sleep(20);
      }

      const during = await inEach(stepIsolates, async (session) => await session.liveHeap());
      const { wide } = v.parse(waiting, JSON.parse(await ask(`/model?answerBytes=${String(STEP.answerBytes)}&holding=1`)));
      await ask(`/model?answerBytes=${String(STEP.answerBytes)}`);
      await parked;

      // The same step, but a fresh workspace's first: its main isolate has run no turn.
      const coldWorkspace = await ask('/?workspace=cold');
      const coldIsolates = { workspace, main: await inspect(port, `${ISOLATE_NAMES.main} in the cold workspace`, mainOf(coldWorkspace)) };
      sessions.push(coldIsolates.main);
      const coldSetUp = await inEach(coldIsolates, async (session) => await session.liveHeap());
      const coldAnswered = streamsOpened;
      await ask(`/model?answerBytes=${String(STEP.answerBytes)}&holding=1`);
      const coldParked = ask('/turn?workspace=cold&text=cold');

      while (streamsOpened === coldAnswered
        || v.parse(waiting, JSON.parse(await ask(`/model?answerBytes=${String(STEP.answerBytes)}&holding=1`))).parked === 0) {
        await Bun.sleep(20);
      }

      const coldStepLive = beyond(await inEach(coldIsolates, async (session) => await session.liveHeap()), coldSetUp);
      await ask(`/model?answerBytes=${String(STEP.answerBytes)}`);
      await coldParked;
      await ask('/quiesce?workspace=cold');

      await ask('/?workspace=heads');
      // The step's workspace compresses its turns on a cadence of its own, in this isolate: none of it is the heads'.
      await ask('/quiesce?workspace=heap');
      await ask(`/heads?workspace=heads&tag=warm&count=${String(HEADS.warm)}`);
      const headsRetained: number[] = [];

      for (const batch of ['swarm', 'swarm-again']) {
        const beforeHeads = await workspace.liveHeap();
        await ask(`/heads?workspace=heads&tag=${batch}&count=${String(HEADS.count)}`);
        headsRetained.push(await workspace.liveHeap() - beforeHeads);
      }

      const longWorkspace = await ask('/?workspace=long&compat=1');
      const longIsolates = { workspace, main: await inspect(port, `${ISOLATE_NAMES.main} in the long turn's workspace`, mainOf(longWorkspace)) };
      sessions.push(longIsolates.main);
      // Its sleep-time lane off from the start: the pass a settled turn owes is not the turn's, and switched off only at the
      // settle below it would run or not as the two raced (1-2 MB in main's isolate over 9 runs each way).
      await ask('/quiesce?workspace=long');
      await ask(`/model?answerBytes=0&toolSteps=${String(LONG_TURN.steps - 1)}&stepBytes=${String(LONG_TURN.stepBytes)}`);
      await inEach(longIsolates, async (session) => { await session.sampleAllocations(); });
      const long = ask('/turn?workspace=long&text=long');
      let longTurnPeak = { workspace: 0, main: 0 };
      let firstLive = { workspace: 0, main: 0 };
      let lastLive = firstLive;

      // Each model call parks until released, so the read lands at every step of the turn.
      for (let step = 1; step <= LONG_TURN.steps; step++) {
        while (v.parse(v.object({ arrived: v.number() }), JSON.parse(await ask('/model'))).arrived < step) await Bun.sleep(2);
        const used = await inEach(longIsolates, async (session) => await session.usedHeap());
        longTurnPeak = { workspace: Math.max(longTurnPeak.workspace, used.workspace), main: Math.max(longTurnPeak.main, used.main) };

        if (step === 1) firstLive = await inEach(longIsolates, async (session) => await session.liveHeap());

        if (step === LONG_TURN.steps) lastLive = await inEach(longIsolates, async (session) => await session.liveHeap());
        await ask(`/model?released=${String(step)}`);
      }

      // Sampled to its settlement: main's isolate and the workspace settle before the profile is read, and a call past the
      // turn's last release is answered rather than left parked.
      await long;
      await ask('/model?released=1000000');
      await ask('/main-idle?workspace=long');
      await ask('/quiesce?workspace=long');
      const longTurnAllocated = await inEach(longIsolates, async (session) => await session.allocations());

      await ask('/model?answerBytes=0&toolSteps=0');
      const failedBefore = v.parse(v.number(), JSON.parse(await ask('/failed-tool-calls?workspace=long')));
      const beforeFailing = await inEach(longIsolates, async (session) => await session.liveHeap());
      await ask(`/model?failingSteps=${String(FAILING_STEPS)}`);
      await ask('/turn?workspace=long&text=failing');
      // Read once the turn has ended in main's isolate, which it is running once its first failing call is answered;
      // the asks a turn that stopped short left are cleared, so no later phase serves one.
      await ask('/failing-started');
      await ask('/main-idle?workspace=long');
      await ask('/model?failingSteps=0');
      await ask('/quiesce?workspace=long');
      const failedPortRetained = beyond(await inEach(longIsolates, async (session) => await session.liveHeap()), beforeFailing);
      const failedPortCalls = v.parse(v.number(), JSON.parse(await ask('/failed-tool-calls?workspace=long'))) - failedBefore;

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

      const helpersWorkspace = await ask('/?workspace=helpers');
      await hire(HELPERS.warm);
      // A helper counts as answered before its final stream ends, so a snapshot waits for its runner to release too.
      await noRunners(0);
      const beforeHelpers = await workspace.liveHeap();
      await hire(HELPERS.count);
      await noRunners(0);
      const settledHelpers = await workspace.liveHeap();
      const perHelperRetained = (settledHelpers - beforeHelpers) / HELPERS.count;

      // One helper held at its last working step: what a running helper turn holds beyond a settled one.
      await ask(`/model?answerBytes=${String(HELPERS.answerBytes)}&hires=1&holdHelper=1`);
      const running = ask('/turn?workspace=helpers&text=HIRE-ROOT');

      while (!v.parse(v.object({ helperParked: v.boolean() }), JSON.parse(await ask('/model'))).helperParked) await Bun.sleep(50);
      const helperTurnLive = await workspace.liveHeap() - settledHelpers;
      await ask('/model?holdHelper=0');
      await running;
      await noRunners(0);

      // The helper, its pages written, hires one of its own, held on its first call: the helper and the root wait.
      await ask(`/model?answerBytes=${String(HELPERS.waitingPageBytes)}&hires=1&nest=1&holdHelper=1`);
      const nested = ask('/turn?workspace=helpers&text=HIRE-ROOT');

      while (!v.parse(v.object({ helperParked: v.boolean() }), JSON.parse(await ask('/model'))).helperParked) await Bun.sleep(50);

      // Waiting: the helper's turn ended with its hire's answer owed, so the held hire's runner is the only one left.
      await noRunners(1);
      const waitingParentLive = await workspace.liveHeap() - settledHelpers;
      const agents = await inspectAll(port, mainOf(helpersWorkspace));
      const concurrentAgentsLive: number[] = [];

      try {
        for (const agent of agents) concurrentAgentsLive.push(await agent.liveHeap());
      } finally {
        for (const agent of agents) agent.close();
      }

      await ask('/model?holdHelper=0');
      await nested;
      await noRunners(0);
      await ask('/model?hires=0&nest=0');

      // Last, so nothing measured above carries it: each isolate's planted bytes, read in both.
      const plant = async (isolate: (typeof ISOLATES)[number]): Promise<Isolates<number>> => {
        const before = await inEach(stepIsolates, async (session) => await session.liveHeap());

        await ask(`/plant?workspace=heap&isolate=${isolate}&bytes=${String(PLANTED_BYTES)}`);

        return beyond(await inEach(stepIsolates, async (session) => await session.liveHeap()), before);
      };

      const planted = { workspace: await plant('workspace'), main: await plant('main') };

      return { planted, concurrentAgentsLive, failedPortRetained, failedPortCalls, coldStepLive, stepLive: beyond(during, idle), idleRetained: beyond(idle, setUp), headsRetained, perHelperRetained, helperTurnLive, waitingParentLive, longTurnPeak, longTurnGrowth: beyond(lastLive, firstLive), longTurnAllocated, bindingTurnsAllocated, setupMakeup, live: { setUp, longTurnFirst: firstLive, longTurnLast: lastLive }, wide };
    } finally {
      for (const session of sessions) session.close();
    }
  } finally {
    await mf.dispose();
    rmSync(assets, { recursive: true, force: true });
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function printAllocations(workload: string, allocated: Allocations): void {
  console.log(`${GATE}: ${workload} allocated ${mb(allocated.total)}; most by`);

  for (const site of allocated.sites) console.log(`  ${mb(site.bytes).padStart(9)}  ${site.site}`);
}

/** A figure in the workspace's isolate, then in main's. */
function inEachIsolate(figures: Isolates<number>): string {
  return `${mb(figures.workspace)} (main's isolate ${mb(figures.main)})`;
}

function transcript(): string {
  return `${String(STEP.turns)} prior answers of ${mb(STEP.answerBytes)}`;
}

/** UTF-8 spends one byte per character only when every character is ASCII. */
function isWide(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') !== text.length;
}

/** The workloads beyond a step and a long turn: a fresh workspace's first turn, a port whose calls fail, and every agent
 *  isolate open at once. */
function workloadFindings(measured: HeapMeasurement): string[] {
  const out: string[] = [];

  console.log(`${GATE}: with the root, a helper and its hire open, the agent isolates hold ${measured.concurrentAgentsLive.map(mb).join(', ')} live`);
  console.log(`${GATE}: a turn of ${String(measured.failedPortCalls)} workspace tool calls rejected across the port (of the ${String(FAILING_STEPS)} its `
    + `model asked for) leaves ${inEachIsolate(measured.failedPortRetained)} live once quiet`);

  // None, and the turn bounded nothing about a rejected call; a turn that stops short of its model's asks measures fewer.
  if (measured.failedPortCalls < 1 || measured.failedPortCalls > FAILING_STEPS) {
    out.push(`the failing turn's ledger records ${String(measured.failedPortCalls)} rejected tool calls, not 1 to ${String(FAILING_STEPS)}`);
  }

  console.log(`${GATE}: a fresh workspace's first turn, parked, holds ${inEachIsolate(measured.coldStepLive)} live beyond its setup`);

  for (const isolate of ISOLATES) {
    if (measured.coldStepLive[isolate] > COLD_STEP_LIVE_BOUND_BYTES[isolate]) {
      out.push(`a fresh workspace's first turn, parked, holds ${mb(measured.coldStepLive[isolate])} live in ${ISOLATE_NAMES[isolate]}, `
        + `over ${mb(COLD_STEP_LIVE_BOUND_BYTES[isolate])}`);
    }
  }

  for (const isolate of ISOLATES) {
    if (measured.failedPortRetained[isolate] > FAILED_PORT_RETAINED_BOUND_BYTES[isolate]) {
      out.push(`a turn of ${String(measured.failedPortCalls)} rejected workspace tool calls leaves ${mb(measured.failedPortRetained[isolate])} live in `
        + `${ISOLATE_NAMES[isolate]} once quiet, over ${mb(FAILED_PORT_RETAINED_BOUND_BYTES[isolate])}`);
    }
  }

  // Main's, the helper's and its hire's: fewer, and the wait was read with an isolate missing.
  if (measured.concurrentAgentsLive.length < 3) {
    out.push(`the root, a helper and its hire were open in ${String(measured.concurrentAgentsLive.length)} agent isolate(s), not 3`);
  }

  for (const live of measured.concurrentAgentsLive) {
    if (live > CONCURRENT_AGENT_LIVE_BOUND_BYTES) {
      out.push(`an agent isolate holds ${mb(live)} live while the root, a helper and its hire are open, over ${mb(CONCURRENT_AGENT_LIVE_BOUND_BYTES)}`);
    }
  }

  return out;
}

/** The gate reads each isolate it bounds: a buffer planted in one shows there, and not in the other. */
function plantedFindings(planted: HeapMeasurement['planted']): string[] {
  return ISOLATES.flatMap((isolate) => {
    const other = isolate === 'workspace' ? 'main' : 'workspace';
    const seen = planted[isolate];
    const read = `${mb(seen[isolate])} there and ${mb(seen[other])} in ${ISOLATE_NAMES[other]}`;

    console.log(`${GATE}: ${mb(PLANTED_BYTES)} planted in ${ISOLATE_NAMES[isolate]} read as ${read}`);

    return seen[isolate] < PLANTED_BYTES * 0.9 || seen[other] > PLANTED_BYTES * 0.25
      ? [`${mb(PLANTED_BYTES)} planted in ${ISOLATE_NAMES[isolate]} read as ${read}: the gate does not read that isolate alone`]
      : [];
  });
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
  const steps = `${String(LONG_TURN.steps)}-step turn`;

  for (const isolate of ISOLATES) {
    const where = ISOLATE_NAMES[isolate];
    // A deployed object dies of allocation bursts, not only of what it keeps (platform-catalog `worker.memory_kill_is_burst_sensitive`),
    // so each workload's churn is named by the code that makes it.
    printAllocations(`the ${steps} on the OpenAI-compatible path, in ${where},`, measured.longTurnAllocated[isolate]);
    printAllocations(`${transcript()} on the Workers AI binding, in ${where},`, measured.bindingTurnsAllocated[isolate]);
    console.log(`${GATE}: in ${where}, live heap ${mb(measured.live.setUp[isolate])} after setup, ${mb(measured.live.longTurnFirst[isolate])} at the long `
      + `turn's first step, ${mb(measured.live.longTurnLast[isolate])} at its last; it peaked at ${mb(measured.longTurnPeak[isolate])} used, garbage included`);
    console.log(`${GATE}: the live heap after setup in ${where}, by kind`);

    for (const each of measured.setupMakeup[isolate].kinds) console.log(`  ${mb(each.bytes).padStart(9)}  ${String(each.count).padStart(7)}  ${each.kind}`);

    for (const each of measured.setupMakeup[isolate].strings) console.log(`  ${mb(each.bytes).padStart(9)}  one string: ${JSON.stringify(each.head)}`);
  }

  const findings: string[] = [...plantedFindings(measured.planted)];

  if (wide.length > 0) findings.push(`${wide.join(', ')} carry characters outside ASCII, which V8 keeps two bytes each`);

  if (wasm.length > 0) findings.push(`index.js instantiates ${wasm.join(', ')} at load: a static import reaches it`);

  // Our own prompt, tool and skill text: the owner's and the model's text may still carry such characters.
  for (const context of measured.wide) findings.push(`the request carries a character above U+00FF, so V8 keeps it two bytes each: ${JSON.stringify(context)}`);

  // Each isolate has its own 128 MB, so each is bounded on its own: a figure moved from one to the other moves to
  // the other's bound.
  for (const isolate of ISOLATES) {
    const where = ISOLATE_NAMES[isolate];

    if (measured.live.setUp[isolate] > HEAP_AFTER_SETUP_BOUND_BYTES[isolate]) {
      findings.push(`live heap after setup in ${where} ${mb(measured.live.setUp[isolate])} exceeds ${mb(HEAP_AFTER_SETUP_BOUND_BYTES[isolate])}`);
    }

    if (measured.stepLive[isolate] > STEP_LIVE_BOUND_BYTES[isolate]) {
      findings.push(`a parked step holds ${mb(measured.stepLive[isolate])} live in ${where} at ${transcript()}, over ${mb(STEP_LIVE_BOUND_BYTES[isolate])}`);
    }

    if (measured.idleRetained[isolate] > IDLE_RETAINED_BOUND_BYTES[isolate]) {
      findings.push(`the idle workspace holds ${mb(measured.idleRetained[isolate])} in ${where} after ${transcript()}, over ${mb(IDLE_RETAINED_BOUND_BYTES[isolate])}`);
    }

    if (measured.longTurnGrowth[isolate] > LONG_TURN_GROWTH_BOUND_BYTES[isolate]) {
      findings.push(`a ${steps} holds ${mb(measured.longTurnGrowth[isolate])} more live in ${where} at its last step than its first, over ${mb(LONG_TURN_GROWTH_BOUND_BYTES[isolate])}`);
    }

    if (measured.longTurnPeak[isolate] > LONG_TURN_PEAK_BOUND_BYTES[isolate]) {
      findings.push(`a ${steps} peaks at ${mb(measured.longTurnPeak[isolate])} used in ${where}, over ${mb(LONG_TURN_PEAK_BOUND_BYTES[isolate])}`);
    }
  }

  for (const retained of measured.headsRetained) {
    if (retained > HEADS_RETAINED_BOUND_BYTES) {
      findings.push(`${String(HEADS.count)} released heads leave ${mb(retained)} live, over ${mb(HEADS_RETAINED_BOUND_BYTES)}`);
    }
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

  findings.push(...workloadFindings(measured));

  // The churn is the turn's work, wherever it runs.
  const allocated = { workspace: measured.longTurnAllocated.workspace.total, main: measured.longTurnAllocated.main.total };

  if (allocated.workspace + allocated.main > LONG_TURN_ALLOCATED_BOUND_BYTES) {
    findings.push(`a ${steps} allocates ${mb(allocated.workspace + allocated.main)} across its isolates, ${inEachIsolate(allocated)}, over ${mb(LONG_TURN_ALLOCATED_BOUND_BYTES)}`);
  }

  // Every figure, red or green, so two runs compare.
  console.log(`${GATE}: ${inEachIsolate(measured.live.setUp)} live after setup, a parked step holds ${inEachIsolate(measured.stepLive)} live at `
    + `${transcript()}, the idle workspace holds ${inEachIsolate(measured.idleRetained)} after them, `
    + `${String(HEADS.count)} released heads leave ${measured.headsRetained.map((bytes) => mb(bytes)).join(' then ')}, a finished helper `
    + `${mb(measured.perHelperRetained)}, a running helper turn ${mb(measured.helperTurnLive)}, a helper waiting on its `
    + `own hire ${mb(measured.waitingParentLive)}, a ${steps} peaks at ${inEachIsolate(measured.longTurnPeak)} used, grows `
    + `${inEachIsolate(measured.longTurnGrowth)} live and allocates ${inEachIsolate(allocated)}; no wasm on the static graph, every module ASCII, every request Latin-1`);
  console.log('  blind: garbage is sampled once per model call, so a spike inside a step is missed; transcripts shaped unlike these; a hired '
    + 'helper\'s own Worker Loader isolate, where its turns run (the helper rows read the workspace\'s); and memory outside V8 (compiled wasm, SQLite pages)');

  if (findings.length > 0) {
    console.error(`${GATE}: ${String(findings.length)} finding(s)\n`);

    for (const each of findings) console.error(`  ${each}`);

    return 1;
  }

  console.log(`${GATE}: ok`);

  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
