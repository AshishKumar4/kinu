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
 * Measured 2026-10-09 in workerd 1.20260926.1 (miniflare 5.20260926.0-alpha's): setup now loads the workspace agent's
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
 * The long turn's allocation bound rose from 170 MB to 195 MB on 2026-10-10 because its read point moved, not the
 * product: it was read as soon as the turn's call returned, which raced the turn's tail, and is now read at its
 * settlement (main's isolate idle, the workspace's detached work and terminal effects joined, its sleep-time lane off).
 * On the same product the old read gave 143-154 MB or 165-170 MB as the race fell (b9c667740, 5724b7472); at settlement
 * it read 171.6-183.0 MB over 15 runs on 0d3f6491a. See {@link LONG_TURN_ALLOCATED_BOUND_BYTES}.
 *
 * The idle row bounds data alone since 2026-10-20, and reports beside it the code V8 compiled for the step's turns. It
 * bounded the live total at 4.0 MB in the workspace's isolate, against 2.55-2.58 MB read on 2026-10-12; by 44ce0e110 that
 * read 3.9-4.0 MB, which snapshots at setup and idle split into 3.4 MB of code and 0.5-0.6 MB of data. The code had spent
 * the margin a leak was to trip, and streaming the memory lane's structured call (667221f68, 0.2 MB more code and 15 kB
 * more data) tripped it. Main's total, 6.6 MB under 7.9 MB, was 3.7 MB of code. See {@link IDLE_DATA_BOUND_BYTES}.
 *
 * The planting probe proves each session reads the isolate it names: a buffer planted in one is found there, whole, and
 * in no other. Until 2026-10-12 it subtracted live heap totals, which any work crossing the read moves: red in 4 of 20
 * runs on 009c51396 and 8 of 20 on 8a71331cb (armada 20261012091025-eb23b0d7, 20261012091030-301e97ae), each reading
 * main's plant as 1.0 MB in the workspace's isolate. Snapshots of 12 runs (20261012091744-6ac47e5a) put one red at
 * +1,019,881 bytes there, 1,000,012 of them a transcript string the subagents' sleep-time pass held; with this harness on
 * 8add33666 the workspace's own plant read 2.49-3.51 MB of 4 (20261012092031-f427bbac). Yet in all 24 plantings those
 * snapshots caught, the 4,000,000-byte buffer sat in the isolate planted and in no other. So each buffer is now held
 * under a marker of its own and found by it, in the shape workerd 1.20260926.1 writes (measured 2026-10-12; armada
 * 20261012095805-bc2fd6be read the version): the marker's property edge reaches the `Uint8Array`, its internal `buffer`
 * edge the `ArrayBuffer`, and that one's internal `backing_store` edge a native `system / JSArrayBufferData` node of
 * the buffer's size. A link missing or doubled throws, so a workerd that writes another shape fails the gate; remeasure
 * on each upgrade. On d0d59b756 all 40 plantings of 20 runs read 4,000,000 bytes and 0 (20261012095406-f34d536d). The
 * controls, debug commits e667e5f63 and 07c225e16 over it: red with no plant, with the two sessions swapped, and with
 * both on the workspace's isolate (20261012095805-8b1285d2, 20261012095805-9b092326, 20261012100111-f8f05fbe, 3 runs
 * each); thrown with the marker on two holders or on a string (20261012100424-d7cb558e, 20261012100637-c418e3b4, 2 runs
 * each); green, every read 4,000,000 and 0, with 1 MB reclaimed in the planted isolate and 1 MB allocated in the other,
 * which the total-delta rule failed in 5 runs of 5 (20261012095805-8126adc8).
 *
 * `--no-build` reads the existing `dist/kinu` (a deploy already built it).
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { builtinModules } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, normalize, resolve as resolvePath } from 'node:path';
import { literalString, parse, walk } from './syntax';
import { build, stop as stopEsbuild, version as esbuildVersion } from 'esbuild';
import { childrenRunning, exitOf } from './deadline';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import * as v from 'valibot';
import { ownerCaller } from '../packages/core/src/safety/workspace-capability';
import { workersAiBinding } from '../packages/cf-backend/tests/helpers/workers-ai-binding';
import { buildAgentBundle } from '../packages/cf-backend/vite-agent-bundle';
import { inspect, inspectAll, type Allocations, type HeapMakeup, type Inspector, type LiveHeap } from './worker-heap/inspector';
import { REPO_ROOT } from './repo-root';


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
 *  Each head's "computer.executor_registered" line stays live only because this gate attaches an inspector: its
 *  retainer is the DevTools console's global handle, which V8 caps at 1000 messages; nothing of the product's holds it. */
export const HEADS_RETAINED_BOUND_BYTES = 1_500_000;

/** Measured 2026-09-27 at {@link SUBAGENTS}: 0.8 MB on main 905d6665d4, each subagent's chat room keeping its whole
 *  streamed answer; 0.0-0.1 MB over 3 runs once no room keeps an answer. */
export const PER_SUBAGENT_RETAINED_BOUND_BYTES = 250_000;

/** Measured 2026-09-27 at {@link SUBAGENTS}, one subagent held on its fourth model call: 4.0 and 3.9 MB on main
 *  905d6665d4, where the Workers AI fetch kept its parsed copy of the request for the whole call; 2.7-3.3 MB over 3
 *  runs once only the binding's inputs hold it. The rest is the transcript three ways: the session's rows, the AI
 *  SDK's record of the call's response messages, and the request JSON the retry wrapper keeps for a resend. */
export const SUBAGENT_TURN_LIVE_BOUND_BYTES = 3_600_000;

/** Measured 2026-09-29 at {@link SUBAGENTS}, a subagent with 4 pages of 1 MB whose turn ended waiting on its own hire, held:
 *  8.1-8.8 MB over 8 runs on integration 36aa590761. Every figure before this row waited on its hire's runner read a
 *  stale park (1-2 MB, before the tree started) or the subagent's own next step (16-17 MB, mid-turn over its pages). */
export const WAITING_PARENT_LIVE_BOUND_BYTES = 14_500_000;

/** Each agent isolate's live heap while the root, a subagent and the subagent's hire are all open: main's, every subagent's
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
 *  scale): a pipeline kept per call would pass 20 of them. Until 2026-10-12 the heap step's turns, still queued when their reads came, took half the long turn's scripted steps, so every post-D9 long-turn row measured 75-76 steps (debug/heap-idle 50bb62a22, armada 20261012111719-547cfddc); after the full
 *  150 steps, 0.24-0.25 MB in the workspace's and 2.02-2.03 MB in main's over 10 runs (armada 20261012110831-e3858893,
 *  20261012111603-1a3edf49): the refusals' validation issues on a conversation twice as long. */
export const FAILED_PORT_RETAINED_BOUND_BYTES = { workspace: 1_000_000, main: 2_800_000 } as const;

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
 *  there and 6.5 MB in main's over 3 runs once both are read (armada 20261010034927-e852fa06). Those runs took 75-76 of
 *  the 150 steps, the heap step's still-queued turns taking the rest; at the full 150, 2026-10-12: 1.93-2.00 MB in the
 *  workspace's and 8.81-8.83 MB in main's over 10 runs (armada 20261012110831-e3858893, 20261012111603-1a3edf49). */
export const LONG_TURN_GROWTH_BOUND_BYTES = { workspace: 2_500_000, main: 10_500_000 } as const;

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
 *  sleep-time lane off: 171.6-183.0 MB over 15 runs on 0d3f6491a, 54-60 MB in the workspace's and 116-125 MB in main's.
 *  The tail, profiled apart from the last step's release to settlement (scratch eaabadf3a, 3 runs): 18.0-20.6 MB in
 *  main's isolate and 10.9-11.1 MB in the workspace's. Of main's, 3.4 MB announced the turn to no extension (cut,
 *  b65abe3ff) and 3.2 MB read its narration for nothing (cut, 8f78f86e9), leaving 10.8-13.1 MB: the transcript frame's
 *  read, the output references decoded from every part, the figures, the commit and about 5 MB of RPC serialization; the
 *  workspace's is mostly that serialization and the 1.7 MB frame. With both cuts, 167.5-175.5 MB over 9 runs on
 *  5a5a155be, 110.7-116.6 MB of it main's. Until 2026-10-12 the heap step's turns, still queued when their reads came, took half the long turn's scripted steps, so every post-D9 long-turn row measured 75-76 steps (debug/heap-idle 50bb62a22, armada 20261012111719-547cfddc): at the full 150, 298.4-313.3 MB
 *  together over 10 runs, 57.3-64.0 MB in the workspace's and 240.4-250.9 MB in main's (armada 20261012110831-e3858893,
 *  20261012111603-1a3edf49), against the single isolate's 274.5-285.5 MB before D9.
 *  No platform limit bounds this figure: it is what the turn allocates over its life, garbage included, while the
 *  isolate's limit is on what it holds at once (platform-catalog `worker.isolate.memory`, 128 MB published; a Durable
 *  Object's real wall higher, `do.isolate.oom_catchable`), which {@link LONG_TURN_PEAK_BOUND_BYTES} guards. Churn matters
 *  to that limit only as a burst (`worker.memory_kill_is_burst_sensitive`), so this row is a tripwire for a per-step
 *  rebuild coming back, set from its spread. On next-rc b19324bc8, 2026-10-17: 315.1-332.8 MB over 12 runs alone
 *  (armada map, one gate a container) and 318.6-330.5 MB over 12 beside 48 suites of the tier's heaviest on 60 containers
 *  at once; 315.1-333.3 MB over 8 more alone on 162bdf552 and the tip; and 337.3 and 338.4 MB in two tiers
 *  (20261017130149-357d290c, 20261017141010-0990fca1), which the old 335 MB bound read red. Over all 34: mean 325.1 MB,
 *  standard deviation 5.65 MB. So the bound was the mean and four deviations, 9.6 MB above the highest read: a per-step
 *  rebuild the size of the one 3e0c5614c cut (347-348 MB to 316-321 MB, above) still trips it. On 0a4fb372f, 2026-10-19,
 *  once a model call's end comes from `onEnd` and the SDK's accessors, each a reader replaying every part the call
 *  streamed, are read no more (#m2180e): 280.3-291.8 MB over 12 runs alone, mean 286.3 MB, main's 216.7-228.5 MB, where
 *  6f59a1bc9 read 251.5-255.6 MB in main's over 3. The bound is that mean and four of the 34 runs' deviations: the seven
 *  readers back, about 33 MB, trip it. On 105bb6084, 2026-10-19, once the owner's view of a call reads the chat loop's
 *  own parts and the per-part stages are pulled: 262.0-277.2 MB over 12 runs, mean 272.5 MB, main's 199.7-212.6 MB.
 *  The bound is again that mean and four of the 34 runs' deviations. */
export const LONG_TURN_ALLOCATED_BOUND_BYTES = 295_000_000;

/** Measured 2026-09-26 at {@link STEP} before any copy fix: 13.5 MB, the transcript and, whole, the last request;
 *  11.1 MB (twice) on 2026-09-27 once the root's chat room no longer keeps each answer; 9.8-10.0 MB over 3 runs on
 *  integration 48fa23c62 (2026-09-30), 7.6-7.8 MB over 4 once a turn keeps its origin as a revision, not a clone.
 *  Since D9 the transcript is main's: on 2ac877244, 1.9 MB in the workspace's isolate with main's unread; 1.1 MB
 *  there and 2.6-2.7 MB in main's over 3 runs once setup joins main's load and both are read. Those reads came before
 *  the turns ran: an admission answers once its turn is queued, and the read caught the third in flight with nine queued.
 *  Read once all twelve ended and settled, 2026-10-12: 2.55-2.58 MB in the workspace's and 6.57-6.58 MB in main's over 10
 *  runs (armada 20261012110831-e3858893, 20261012111603-1a3edf49), main's the twelve answers its conversation keeps.
 *  Those totals were bounded at 4.0 MB and 7.9 MB until 2026-10-20; since then the data alone is (the header says why).
 *  Over 6 runs on b3afff5ab, 2026-10-20: 568-573 kB of data in the workspace's and 2873-2906 kB in main's, beside 3.6 and
 *  3.7 MB of code; over 3 on 44ce0e110, before the memory lane's call streamed, 542-561 and 2900-2904 kB, beside 3.4 and
 *  3.7 MB. Each bound is about the highest data read and 0.4 MB, two of the step's answers. Red on b3afff5ab, 2 runs each:
 *  an answer of 0.2 MB kept a turn in each isolate, 2976-2977 kB in the workspace's and 5305-5308 kB in main's; the
 *  driver answering the memory lane's structured call with prose, whose three log lines a turn the inspector's console
 *  kept, 2951-2956 kB in the workspace's. */
export const IDLE_DATA_BOUND_BYTES = { workspace: 1_000_000, main: 3_300_000 } as const;

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

/** The delegation the subagent bound is about: the root hires COUNT task subagents, each working 4 pages of
 *  ANSWER_BYTES (`worker-heap/driver.ts`) before a one-word answer. */
export const SUBAGENTS = { warm: 2, count: 12, answerBytes: 200_000, waitingPageBytes: 1_000_000 } as const;

/**
 * The long turn the peak and growth bounds are about: `steps` model calls on the OpenAI-compatible path, each writing a
 * page of `stepBytes` through the file tool. That path rebuilds every message of the history for each request, with a
 * fresh copy of each earlier call's arguments, so whatever keeps a request keeps the turn so far again.
 */
export const LONG_TURN = { steps: 150, stepBytes: 3000 } as const;

/**
 * The long computer-use turn the flatness bounds are about: `steps` model calls, each reading one of `distinct` seeded
 * screenshots of `imageBytes` through the file tool, as a desktop turn takes one a step, every one of them distinct as
 * a live desktop's are (40 shared ones hid what a turn held of each step: rc22's Minecraft trial died out of memory at
 * step 833, 2026-10-19); per `window` steps the agent's isolate's live heap and CPU are read, and the chat seed a pane
 * opens on is read meanwhile, as an eval harness reads it. Production and staging computer-use turns died every step
 * past a few hundred, each re-driven by the minute's backstop (#103: production bc78a94bd, eval-seed-probe-c87o3p, 114
 * re-drives in 2 h; staging 667f96316, eval-minecraft-1-idumki, 30 between steps 411 and 484, the isolate out of
 * memory and of CPU time before them).
 */
export const SCREENSHOT_TURN = { steps: 450, imageBytes: 200_000, distinct: 450, window: 50 } as const;

/** Measured 2026-10-19 at {@link SCREENSHOT_TURN} (armada, one run each): on 814a4ca80 main's isolate held 46.7 MB live
 *  at step 50 and 170.4 MB at 450, every screenshot the turn took, and its CPU per window went 4.2 to 8.3 s; once a turn's
 *  room holds its running step, the codec tells its own handles by shape, and a moved screenshot is retired from the turn's
 *  context (5df419bdd), 35.4 to 45.8 MB and 3.0 to 3.1 s. With every screenshot distinct, 7fdee617e held 35.0 to 98.3 MB:
 *  the SDK's record of the turn's one call, and the call's own response, kept each step's screenshot; once both let it go,
 *  23.3 to 30.2 MB. The bound catches one screenshot in fifty held again. */
export const SCREENSHOT_LIVE_GROWTH_BOUND_BYTES = 20_000_000;

/**
 * The CPU a step of the turn's last third takes in main's isolate over one of its first third's, each the mean of the
 * cheaper half of its third's steps: a host busy with others only ever adds time to a step, so that half is the steps'
 * own cost, and a regression raises every step's alike.
 *
 * Until 2026-10-21 the gate read the middle of the first three 50-step windows' CPU against the last three's, each
 * window's profile its whole stretch of wall time while busy, so a host that slowed a run's later windows read as growth:
 * 0.97 to 1.33 over 36 runs once the turn was flat (2026-10-19, mean 1.10, deviation 0.08, bound 1.42), and a rerun-green
 * 1.43 (kinu-20261020234716-7217b75d, 2026-10-20; within a run, one window took 5.1 s and another 9.2 s for alike steps).
 * Measured by step instead over 30 runs on 62b6c90c6 (armada heap-calib2-nextrc, 2026-10-21): 1.02 to 1.22, mean 1.104,
 * deviation 0.043, against the window reading's 0.054 on the same runs. The bound is that mean and four deviations.
 * 814a4ca80, every screenshot held, read 1.75 by windows, and the turn with only its room and codec cut 1.52: growth every
 * step shares, which this reads alike.
 */
export const SCREENSHOT_CPU_GROWTH_BOUND = 1.28;

/** A step of the last third's cost over one of the first third's ({@link SCREENSHOT_CPU_GROWTH_BOUND}). */
function stepCpuGrowth(steps: readonly number[]): number {
  const third = Math.floor(steps.length / 3);

  return stepCost(steps.slice(-third)) / stepCost(steps.slice(0, third));
}

/** `steps` cut into {@link SCREENSHOT_TURN}'s windows, in order. */
function windowsOf(steps: readonly number[]): number[][] {
  return Array.from({ length: Math.ceil(steps.length / SCREENSHOT_TURN.window) }, (_, at) => steps.slice(at * SCREENSHOT_TURN.window, (at + 1) * SCREENSHOT_TURN.window));
}

/** The mean of the cheaper half of `steps`' CPU: what a step costs with what other work on the host took left out. */
function stepCost(steps: readonly number[]): number {
  const cheaper = [...steps].sort((a, b) => a - b).slice(0, Math.max(1, Math.floor(steps.length / 2)));

  return cheaper.reduce((sum, ms) => sum + ms, 0) / cheaper.length;
}

/** The workspace's isolate's live heap at the turn's last window beyond its first: its chat room held every relayed
 *  screenshot, 39.8 MB of its 78.5 MB live at step 150 on 814a4ca80 (a snapshot's retainers), and its peak used went 105.3
 *  to 217.0 MB over the 450 steps; on 5df419bdd the peak held at 98.0 MB from step 100 (above). */
export const SCREENSHOT_WORKSPACE_GROWTH_BOUND_BYTES = 20_000_000;

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

/** {@link beyond}, the code V8 compiled meanwhile apart from the data. */
function retainedApart(after: Isolates<LiveHeap>, before: Isolates<LiveHeap>): HeapMeasurement['idleRetained'] {
  const data = (heap: LiveHeap) => heap.live - heap.code;

  return {
    data: beyond({ workspace: data(after.workspace), main: data(after.main) }, { workspace: data(before.workspace), main: data(before.main) }),
    code: beyond({ workspace: after.workspace.code, main: after.main.code }, { workspace: before.workspace.code, main: before.main.code }),
  };
}

/** Planted in each isolate in turn at the end of the run, under a marker of its own, and found by that marker: a gate
 *  that read the wrong isolate, or none, would bound nothing there. */
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
  /** What the idle workspace holds after {@link STEP}'s turns beyond right after setup: its data, and apart from it the
   *  code V8 compiled for those turns. */
  readonly idleRetained: { readonly data: Isolates<number>; readonly code: Isolates<number> };
  /** What a workspace holds live after each of two batches of {@link HEADS} heads was hosted and released, beyond before it. */
  readonly headsRetained: readonly number[];
  /** What a workspace holds live per finished task subagent after {@link SUBAGENTS} settle, beyond before them. */
  readonly perSubagentRetained: number;
  /** What one running subagent turn holds live, parked on its last working step, beyond the settled workspace. */
  readonly subagentTurnLive: number;
  /** What a subagent holds live while it waits on a subagent of its own, with the root waiting on it, beyond settled. */
  readonly waitingParentLive: number;
  /** Each agent isolate's live heap at that wait, main's and each subagent's: every one of them is open at once. */
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
  /** For each isolate {@link PLANTED_BYTES} were planted in, the bytes each isolate holds under that plant's marker. */
  readonly planted: Isolates<Isolates<number>>;
  /** {@link SCREENSHOT_TURN}, a window at a time, and its turn's re-drives and the steps it took. */
  readonly screenshotTurn: ScreenshotTurn;
}

/** Each window of {@link SCREENSHOT_TURN}: main's and the workspace's live heap at its end. */
export interface ScreenshotWindow {
  readonly through: number;
  readonly mainLive: number;
  readonly workspaceLive: number;
}

export interface ScreenshotTurn {
  readonly windows: readonly ScreenshotWindow[];
  /** Each step's CPU in main's isolate, in order: from its answer's release to the next step's request, or the turn's
   *  end. */
  readonly stepCpuMs: readonly number[];
  /** Times its turn was re-driven (`turn.resumed`): a turn that died mid-way and was run again. */
  readonly redrives: number;
  readonly stepped: number;
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
  // Its turns re-driven after they died mid-way.
  let redrives = 0;

  // A native Ai binding transports cancellation to this local backend; an RPC fake cannot transport a facet's signal.
  const ai = await workersAiBinding((request) => driver.fetch('http://driver.invalid/ai', {
    method: request.method, body: request.body, signal: request.signal,
  }));

  const mf = new Miniflare(convertV4MiniflareOptions({
    inspectorPort: port,
    // Miniflare's default handler, printing every line as it would, plus the count above.
    handleStructuredLogs: ({ level, message }) => {
      if (message.includes('"event":"provider.stream_opened"')) streamsOpened += 1;

      if (message.includes('"event":"turn.resumed"')) redrives += 1;

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

  // Both bundles are built. esbuild's service process otherwise outlives the run, and armada fails a task that leaves one;
  // stop() only signals it, so its exit is awaited (as the tracing gate's, 2026-10-21).
  const service = childrenRunning(process.pid, `--service=${esbuildVersion}`);

  await stopEsbuild();
  await exitOf(service);

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
      const setUpSplit = await inEach(stepIsolates, async (session) => await session.liveSplit());
      const setUp = { workspace: setUpSplit.workspace.live, main: setUpSplit.main.live };
      const setupMakeup = await inEach(stepIsolates, async (session) => await session.makeup());
      await ask(`/model?answerBytes=${String(STEP.answerBytes)}`);
      await inEach(stepIsolates, async (session) => { await session.sampleAllocations(); });

      // An admission answers once its turn is queued, not run: every turn ends and settles before the read, and before the
      // model's one script changes for the next phase. Until 2026-10-12 the read caught the third turn in flight with nine
      // queued, and those turns took half the long turn's scripted steps (debug/heap-idle 50bb62a22).
      for (let turn = 0; turn < STEP.turns; turn++) await ask(`/turn?workspace=heap&text=turn-${String(turn)}`);
      await ask('/main-idle?workspace=heap');
      await ask('/quiesce?workspace=heap');
      const bindingTurnsAllocated = await inEach(stepIsolates, async (session) => await session.allocations());
      const idleSplit = await inEach(stepIsolates, async (session) => await session.liveSplit());
      const idle = { workspace: idleSplit.workspace.live, main: idleSplit.main.live };
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
      await ask('/main-idle?workspace=heap');
      await ask('/quiesce?workspace=heap');

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
      await ask('/main-idle?workspace=cold');
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
      const { stepped } = v.parse(v.object({ stepped: v.object({ binding: v.number(), compat: v.number() }) }), JSON.parse(await ask('/model?released=1000000')));

      // The cursor counts every workspace's steps: the long turn's (compat) must be all of them, or the rows below measure
      // another workload.
      if (stepped.binding !== 0 || stepped.compat !== LONG_TURN.steps) {
        throw new Error(`the long turn took ${String(stepped.compat)} of its ${String(LONG_TURN.steps)} scripted steps, and other turns took ${String(stepped.binding)}`);
      }

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
      // Before the subagents, whose turns run on the binding: a step any other workspace took would be the cursor's.
      const screenshotTurn = await measureScreenshotTurn(ask, port, workspace, () => redrives);

      // A root turn returns once it has hired; its subagents' turns end with their runners, each after its release.
      const noRunners = async (left: number): Promise<void> => {
        while (v.parse(v.number(), JSON.parse(await ask('/runners?workspace=subagents'))) > left) await Bun.sleep(50);
      };

      const SubagentStateSchema = v.object({ calls: v.number(), subagentsAnswered: v.number() });

      // Settled: every subagent answered and no model call arrived for half a second.
      const hire = async (count: number): Promise<void> => {
        await ask(`/model?answerBytes=${String(SUBAGENTS.answerBytes)}&hires=${String(count)}`);
        await ask('/turn?workspace=subagents&text=HIRE-ROOT');
        let last = -1;

        for (;;) {
          const state = v.parse(SubagentStateSchema, JSON.parse(await ask('/model')));

          if (state.subagentsAnswered >= count && state.calls === last) break;
          last = state.calls;
          await Bun.sleep(500);
        }
      };

      const subagentsWorkspace = await ask('/?workspace=subagents');
      await hire(SUBAGENTS.warm);
      // A subagent counts as answered before its final stream ends, so a snapshot waits for its runner to release too.
      await noRunners(0);
      const beforeSubagents = await workspace.liveHeap();
      await hire(SUBAGENTS.count);
      await noRunners(0);
      const settledSubagents = await workspace.liveHeap();
      const perSubagentRetained = (settledSubagents - beforeSubagents) / SUBAGENTS.count;

      // One subagent held at its last working step: what a running subagent turn holds beyond a settled one.
      await ask(`/model?answerBytes=${String(SUBAGENTS.answerBytes)}&hires=1&holdSubagent=1`);
      const running = ask('/turn?workspace=subagents&text=HIRE-ROOT');

      while (!v.parse(v.object({ subagentParked: v.boolean() }), JSON.parse(await ask('/model'))).subagentParked) await Bun.sleep(50);
      const subagentTurnLive = await workspace.liveHeap() - settledSubagents;
      await ask('/model?holdSubagent=0');
      await running;
      await noRunners(0);

      // The subagent, its pages written, hires one of its own, held on its first call: the subagent and the root wait.
      await ask(`/model?answerBytes=${String(SUBAGENTS.waitingPageBytes)}&hires=1&nest=1&holdSubagent=1`);
      const nested = ask('/turn?workspace=subagents&text=HIRE-ROOT');

      while (!v.parse(v.object({ subagentParked: v.boolean() }), JSON.parse(await ask('/model'))).subagentParked) await Bun.sleep(50);

      // Waiting: the subagent's turn ended with its hire's answer owed, so the held hire's runner is the only one left.
      await noRunners(1);
      const waitingParentLive = await workspace.liveHeap() - settledSubagents;
      const agents = await inspectAll(port, mainOf(subagentsWorkspace));
      const concurrentAgentsLive: number[] = [];

      try {
        for (const agent of agents) concurrentAgentsLive.push(await agent.liveHeap());
      } finally {
        for (const agent of agents) agent.close();
      }

      await ask('/model?holdSubagent=0');
      await nested;
      await noRunners(0);
      await ask('/model?hires=0&nest=0');
      // Settled as each workload above is before the next: the subagents' sleep-time pass runs in the workspace's isolate.
      await ask('/main-idle?workspace=subagents');
      await ask('/quiesce?workspace=subagents');

      // Last, so nothing measured above carries it: each isolate's planted buffer, found by its marker in both.
      const plant = async (isolate: (typeof ISOLATES)[number]): Promise<Isolates<number>> => {
        const marker = `worker-heap-planted-in-${isolate}`;

        await ask(`/plant?workspace=heap&isolate=${isolate}&marker=${marker}&bytes=${String(PLANTED_BYTES)}`);

        return await inEach(stepIsolates, async (session) => await session.markedBytes(marker));
      };

      const planted = { workspace: await plant('workspace'), main: await plant('main') };

      return { screenshotTurn, planted, concurrentAgentsLive, failedPortRetained, failedPortCalls, coldStepLive, stepLive: beyond(during, idle), idleRetained: retainedApart(idleSplit, setUpSplit), headsRetained, perSubagentRetained, subagentTurnLive, waitingParentLive, longTurnPeak, longTurnGrowth: beyond(lastLive, firstLive), longTurnAllocated, bindingTurnsAllocated, setupMakeup, live: { setUp, longTurnFirst: firstLive, longTurnLast: lastLive }, wide };
    } finally {
      for (const session of sessions) session.close();
    }
  } finally {
    await mf.dispose();
    rmSync(assets, { recursive: true, force: true });
  }
}

/** {@link SCREENSHOT_TURN} on a workspace of its own, its main's isolate read a window at a time: each step parks on the
 *  model, so the reads land between steps. */
async function measureScreenshotTurn(ask: (path: string) => Promise<string>, port: number, workspace: Inspector, redrives: () => number): Promise<ScreenshotTurn> {
  const { steps, imageBytes, distinct, window } = SCREENSHOT_TURN;
  const shots = await ask('/?workspace=shots&compat=1');
  const agent = await inspect(port, `${ISOLATE_NAMES.main} in the screenshot turn's workspace`, mainOf(shots));

  try {
    await ask('/quiesce?workspace=shots');
    await ask(`/seed-screenshots?workspace=shots&count=${String(distinct)}&bytes=${String(imageBytes)}`);
    await ask(`/model?answerBytes=0&toolSteps=${String(steps - 1)}&stepBytes=0&screenshots=${String(distinct)}`);
    const before = redrives();
    const turn = ask('/turn?workspace=shots&text=shots');
    const windows: ScreenshotWindow[] = [];
    const stepCpuMs: number[] = [];

    for (let step = 1; step <= steps; step++) {
      while (v.parse(v.object({ arrived: v.number() }), JSON.parse(await ask('/model'))).arrived < step) await Bun.sleep(1);

      // The step before ends where this one asks its model.
      if (step > 1) stepCpuMs.push(await agent.cpuBusyMs());

      // Read while the step is parked, as a pane opening on the running turn reads it.
      if (step % window === 1) await ask('/seed?workspace=shots');

      if (step % window === 0) windows.push({ through: step, mainLive: await agent.liveHeap(), workspaceLive: await workspace.liveHeap() });

      await agent.sampleCpu();
      await ask(`/model?released=${String(step)}`);
    }

    await turn;
    stepCpuMs.push(await agent.cpuBusyMs());
    const { stepped } = v.parse(v.object({ stepped: v.object({ compat: v.number() }) }), JSON.parse(await ask('/model?released=1000000')));

    await ask('/main-idle?workspace=shots');
    await ask('/quiesce?workspace=shots');

    return { windows, stepCpuMs, redrives: redrives() - before, stepped: stepped.compat };
  } finally {
    agent.close();
  }
}

/** What {@link SCREENSHOT_TURN} broke of its bounds. */
function screenshotFindings(turn: ScreenshotTurn): string[] {
  const first = turn.windows[0];
  const last = turn.windows.at(-1);
  const out: string[] = [];

  if (turn.stepped !== SCREENSHOT_TURN.steps) out.push(`the screenshot turn took ${String(turn.stepped)} of its ${String(SCREENSHOT_TURN.steps)} scripted steps`);

  if (turn.redrives > 0) out.push(`the screenshot turn was re-driven ${String(turn.redrives)} time(s): it died mid-way`);

  if (first === undefined || last === undefined) return [...out, 'the screenshot turn read no window'];

  if (last.mainLive - first.mainLive > SCREENSHOT_LIVE_GROWTH_BOUND_BYTES) {
    out.push(`the screenshot turn holds ${mb(last.mainLive - first.mainLive)} more live in ${ISOLATE_NAMES.main} at step ${String(last.through)} than at ${String(first.through)}, over ${mb(SCREENSHOT_LIVE_GROWTH_BOUND_BYTES)}`);
  }

  const growth = stepCpuGrowth(turn.stepCpuMs);

  if (growth > SCREENSHOT_CPU_GROWTH_BOUND) {
    out.push(`a step of the screenshot turn's last third takes ${growth.toFixed(2)} times one of its first third's CPU in ${ISOLATE_NAMES.main}, over ${String(SCREENSHOT_CPU_GROWTH_BOUND)}`);
  }

  if (last.workspaceLive - first.workspaceLive > SCREENSHOT_WORKSPACE_GROWTH_BOUND_BYTES) {
    out.push(`the screenshot turn holds ${mb(last.workspaceLive - first.workspaceLive)} more live in ${ISOLATE_NAMES.workspace} at step ${String(last.through)} than at ${String(first.through)}, over ${mb(SCREENSHOT_WORKSPACE_GROWTH_BOUND_BYTES)}`);
  }

  return out;
}

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/** For a figure whose bound is under a megabyte or two, which {@link mb} would read to a tenth of it. */
function kb(bytes: number): string {
  return `${(bytes / 1e3).toFixed(0)} kB`;
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

  console.log(`${GATE}: with the root, a subagent and its hire open, the agent isolates hold ${measured.concurrentAgentsLive.map(mb).join(', ')} live`);
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

  // Main's, the subagent's and its hire's: fewer, and the wait was read with an isolate missing.
  if (measured.concurrentAgentsLive.length < 3) {
    out.push(`the root, a subagent and its hire were open in ${String(measured.concurrentAgentsLive.length)} agent isolate(s), not 3`);
  }

  for (const live of measured.concurrentAgentsLive) {
    if (live > CONCURRENT_AGENT_LIVE_BOUND_BYTES) {
      out.push(`an agent isolate holds ${mb(live)} live while the root, a subagent and its hire are open, over ${mb(CONCURRENT_AGENT_LIVE_BOUND_BYTES)}`);
    }
  }

  return out;
}

/** The gate reads each isolate it bounds: a buffer planted in one is found there, whole, and not in the other. */
function plantedFindings(planted: HeapMeasurement['planted']): string[] {
  return ISOLATES.flatMap((isolate) => {
    const other = isolate === 'workspace' ? 'main' : 'workspace';
    const seen = planted[isolate];
    const read = `${String(seen[isolate])} bytes there and ${String(seen[other])} in ${ISOLATE_NAMES[other]}`;
    const what = `${String(PLANTED_BYTES)} bytes planted in ${ISOLATE_NAMES[isolate]} read as ${read}`;

    console.log(`${GATE}: ${what}`);

    return seen[isolate] === PLANTED_BYTES && seen[other] === 0 ? [] : [`${what}: the gate does not read that isolate alone`];
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

    if (measured.idleRetained.data[isolate] > IDLE_DATA_BOUND_BYTES[isolate]) {
      findings.push(`the idle workspace holds ${kb(measured.idleRetained.data[isolate])} of data in ${where} after ${transcript()}, over ${kb(IDLE_DATA_BOUND_BYTES[isolate])}`);
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

  if (measured.perSubagentRetained > PER_SUBAGENT_RETAINED_BOUND_BYTES) {
    findings.push(`each finished task subagent leaves ${mb(measured.perSubagentRetained)} live, over ${mb(PER_SUBAGENT_RETAINED_BOUND_BYTES)}`);
  }

  if (measured.subagentTurnLive > SUBAGENT_TURN_LIVE_BOUND_BYTES) {
    findings.push(`a running subagent turn holds ${mb(measured.subagentTurnLive)} live, over ${mb(SUBAGENT_TURN_LIVE_BOUND_BYTES)}`);
  }

  if (measured.waitingParentLive > WAITING_PARENT_LIVE_BOUND_BYTES) {
    findings.push(`a subagent waiting on its own hire holds ${mb(measured.waitingParentLive)} live, over ${mb(WAITING_PARENT_LIVE_BOUND_BYTES)}`);
  }

  findings.push(...workloadFindings(measured));
  findings.push(...screenshotFindings(measured.screenshotTurn));
  console.log(`${GATE}: a ${String(SCREENSHOT_TURN.steps)}-step screenshot turn, by ${String(SCREENSHOT_TURN.window)} steps: ${ISOLATE_NAMES.main} live `
    + `${measured.screenshotTurn.windows.map((each) => mb(each.mainLive)).join(', ')}; a step's CPU there, its window's cheaper half, `
    + `${windowsOf(measured.screenshotTurn.stepCpuMs).map((window) => `${stepCost(window).toFixed(0)} ms`).join(', ')} `
    + `(its last third ${stepCpuGrowth(measured.screenshotTurn.stepCpuMs).toFixed(2)} times its first); `
    + `${ISOLATE_NAMES.workspace} live ${measured.screenshotTurn.windows.map((each) => mb(each.workspaceLive)).join(', ')}; re-driven ${String(measured.screenshotTurn.redrives)} time(s)`);

  // The churn is the turn's work, wherever it runs.
  const allocated = { workspace: measured.longTurnAllocated.workspace.total, main: measured.longTurnAllocated.main.total };

  if (allocated.workspace + allocated.main > LONG_TURN_ALLOCATED_BOUND_BYTES) {
    findings.push(`a ${steps} allocates ${mb(allocated.workspace + allocated.main)} across its isolates, ${inEachIsolate(allocated)}, over ${mb(LONG_TURN_ALLOCATED_BOUND_BYTES)}`);
  }

  // Every figure, red or green, so two runs compare.
  console.log(`${GATE}: ${inEachIsolate(measured.live.setUp)} live after setup, a parked step holds ${inEachIsolate(measured.stepLive)} live at `
    + `${transcript()}, the idle workspace holds ${kb(measured.idleRetained.data.workspace)} of data (main's isolate `
    + `${kb(measured.idleRetained.data.main)}) and ${inEachIsolate(measured.idleRetained.code)} of code compiled for them, `
    + `${String(HEADS.count)} released heads leave ${measured.headsRetained.map((bytes) => mb(bytes)).join(' then ')}, a finished subagent `
    + `${mb(measured.perSubagentRetained)}, a running subagent turn ${mb(measured.subagentTurnLive)}, a subagent waiting on its `
    + `own hire ${mb(measured.waitingParentLive)}, a ${steps} peaks at ${inEachIsolate(measured.longTurnPeak)} used, grows `
    + `${inEachIsolate(measured.longTurnGrowth)} live and allocates ${inEachIsolate(allocated)}; no wasm on the static graph, every module ASCII, every request Latin-1`);
  console.log('  blind: garbage is sampled once per model call, so a spike inside a step is missed; transcripts shaped unlike these; a hired '
    + 'subagent\'s own Worker Loader isolate, where its turns run (the subagent rows read the workspace\'s); the agent sessions of the cold, long-turn '
    + 'and subagents\' workspaces, picked as the step\'s main is but never planted; the code V8 compiles for the step\'s turns, which the idle '
    + 'row reports and does not bound; and memory outside V8 (compiled wasm, SQLite pages)');

  if (findings.length > 0) {
    console.error(`${GATE}: ${String(findings.length)} finding(s)\n`);

    for (const each of findings) console.error(`  ${each}`);

    return 1;
  }

  console.log(`${GATE}: ok`);

  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
