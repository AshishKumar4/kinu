/**
 * One isolate of the built Worker as `scripts/worker-heap.ts` reads it over workerd's inspector (the Chrome DevTools
 * Protocol): its heap used and live, the live heap's makeup by kind from a snapshot, the buffer held under a marker,
 * and where its allocations were made, sampled. The gate owns the workloads, their order and their bounds; this reads
 * what they leave.
 */
import * as v from 'valibot';

const TargetsSchema = v.array(v.object({ id: v.string(), webSocketDebuggerUrl: v.string() }));

const InspectorReplySchema = v.object({ id: v.number() });

const HeapUsageReplySchema = v.object({ result: v.object({ usedSize: v.number() }) });

const SnapshotChunkSchema = v.object({ method: v.literal('HeapProfiler.addHeapSnapshotChunk'), params: v.object({ chunk: v.string() }) });

const MetaSchema = v.object({ node_fields: v.array(v.string()), node_types: v.looseTuple([v.array(v.string())]) });

const SnapshotSchema = v.object({ snapshot: v.object({ meta: MetaSchema }), nodes: v.array(v.number()), strings: v.array(v.string()) });

/** A snapshot with its edges, what holds what: parsed only where a read follows them, since they outnumber the nodes. */
const GraphSchema = v.object({
  snapshot: v.object({ meta: v.object({ ...MetaSchema.entries, edge_fields: v.array(v.string()), edge_types: v.looseTuple([v.array(v.string())]) }) }),
  nodes: v.array(v.number()),
  edges: v.array(v.number()),
  strings: v.array(v.string()),
});

type Snapshot = v.InferOutput<typeof SnapshotSchema>;

type Graph = v.InferOutput<typeof GraphSchema>;

/** What a live heap is made of: bytes by kind (an object's constructor, compiled code, strings), and its largest strings. */
export interface HeapMakeup {
  readonly kinds: readonly { readonly kind: string; readonly bytes: number; readonly count: number }[];
  readonly strings: readonly { readonly bytes: number; readonly head: string }[];
}

function kindOf(type: string, name: string): string {
  if (type.includes('string')) return '(strings)';

  return type === 'object' || type === 'closure' ? `${type} ${name.slice(0, 40)}` : `(${type})`;
}

function heapMakeup(snapshot: Snapshot): HeapMakeup {
  const fields = snapshot.snapshot.meta.node_fields;
  const types = snapshot.snapshot.meta.node_types[0];
  const [typeAt, nameAt, sizeAt] = ['type', 'name', 'self_size'].map((field) => fields.indexOf(field));
  const kinds = new Map<string, { bytes: number; count: number }>();
  const strings: { bytes: number; head: string }[] = [];

  for (let at = 0; at < snapshot.nodes.length; at += fields.length) {
    const type = types[snapshot.nodes[at + (typeAt ?? 0)] ?? 0] ?? '?';
    const name = snapshot.strings[snapshot.nodes[at + (nameAt ?? 0)] ?? 0] ?? '';
    const bytes = snapshot.nodes[at + (sizeAt ?? 0)] ?? 0;
    const isString = type.includes('string');
    const kind = kindOf(type, name);
    const held = kinds.get(kind) ?? { bytes: 0, count: 0 };
    kinds.set(kind, { bytes: held.bytes + bytes, count: held.count + 1 });

    if (isString && bytes > 200_000) strings.push({ bytes, head: name.slice(0, 60).replaceAll(/\s+/g, ' ') });
  }

  return {
    kinds: [...kinds].map(([kind, held]) => ({ kind, ...held })).sort((a, b) => b.bytes - a.bytes).slice(0, 15),
    strings: strings.sort((a, b) => b.bytes - a.bytes).slice(0, 5),
  };
}

/**
 * The bytes of the buffer that the one property named `marker` holds, in the shape workerd's V8 writes it
 * (`scripts/worker-heap.ts` names the version measured): the property's edge reaches a typed array, its internal `buffer`
 * edge the `ArrayBuffer`, and that one's internal `backing_store` edge a native node the data's size. No such property
 * reads 0; a second one, or a link missing, is a shape this does not read, and throws.
 */
function markedBytes(graph: Graph, marker: string, isolate: string): number {
  const { node_fields: nodeFields, edge_fields: edgeFields, edge_types: [edgeTypes] } = graph.snapshot.meta;

  /** Where `name` sits in `names`, or a throw: a snapshot without it is not one this reads. */
  const indexOf = (names: readonly string[], name: string): number => {
    const index = names.indexOf(name);

    if (index < 0) throw new Error(`worker-heap: ${isolate}'s snapshot names no ${name} among ${names.join(', ')}`);

    return index;
  };

  /** The number at `index` in `values`, or a throw: an index past its array is a snapshot this does not read. */
  const at = (values: readonly number[], index: number): number => {
    const value = values[index];

    if (value === undefined) throw new Error(`worker-heap: ${isolate}'s snapshot has no entry ${String(index)} on the way to ${marker}`);

    return value;
  };

  const [countAt, sizeAt] = [indexOf(nodeFields, 'edge_count'), indexOf(nodeFields, 'self_size')];
  const [typeAt, nameAt, toAt] = [indexOf(edgeFields, 'type'), indexOf(edgeFields, 'name_or_index'), indexOf(edgeFields, 'to_node')];
  // Each node's edges follow those of the nodes before it.
  const firstEdges: number[] = [];

  for (let node = 0, edges = 0; node < graph.nodes.length; node += nodeFields.length) {
    firstEdges.push(edges);
    edges += at(graph.nodes, node + countAt) * edgeFields.length;
  }

  /** Each node an edge of `type` named `name` reaches: from the node at `from`, or from any node. */
  const reached = (type: 'property' | 'internal', name: string, from?: number): number[] => {
    const kind = indexOf(edgeTypes, type);
    const start = from === undefined ? 0 : at(firstEdges, from / nodeFields.length);
    const end = from === undefined ? graph.edges.length : start + at(graph.nodes, from + countAt) * edgeFields.length;
    const found: number[] = [];

    for (let edge = start; edge < end; edge += edgeFields.length) {
      if (at(graph.edges, edge + typeAt) === kind && graph.strings[at(graph.edges, edge + nameAt)] === name) found.push(at(graph.edges, edge + toAt));
    }

    return found;
  };

  const one = (nodes: readonly number[], link: string): number => {
    const [node, ...more] = nodes;

    if (node === undefined || more.length > 0) {
      throw new Error(`worker-heap: ${isolate} has ${String(nodes.length)} ${link} edges on the way to ${marker}, where the read follows one`);
    }

    return node;
  };

  const marked = reached('property', marker);

  if (marked.length === 0) return 0;
  const buffer = one(reached('internal', 'buffer', one(marked, `property ${marker}`)), 'internal buffer');

  return at(graph.nodes, one(reached('internal', 'backing_store', buffer), 'internal backing_store') + sizeAt);
}

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

/** A CPU profile's samples, each a node, and the time before it. */
const CpuReplySchema = v.object({ result: v.object({ profile: v.object({
  nodes: v.array(v.object({
    id: v.number(),
    callFrame: v.object({ functionName: v.string(), url: v.optional(v.string(), ''), lineNumber: v.optional(v.number(), -1), columnNumber: v.optional(v.number(), -1) }),
    children: v.optional(v.array(v.number()), []),
  })),
  samples: v.array(v.number()),
  timeDeltas: v.array(v.number()),
}) }) });

/** The longest stretch an isolate ran with no idle sample in it: one event-loop turn, or turns back to back. */
export interface BusyStretch {
  readonly ms: number;
  /** The frames at least a fifth of its samples ran under, by the share of them, largest first. */
  readonly frames: readonly { readonly frame: string; readonly share: number }[];
  /** The frames its samples ran in themselves, a tenth of them or more, largest first: where the time went. */
  readonly leaves: readonly { readonly frame: string; readonly share: number }[];
}

/** A gap between two samples longer than this, in µs, is the isolate waiting: five sampling intervals. */
const LOOP_GAP_US = 5000;

/** The longest busy stretch in `profile`, and the frames its samples spent most time under. */
function longestBusy(profile: v.InferOutput<typeof CpuReplySchema>['result']['profile']): BusyStretch {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();

  for (const node of profile.nodes) for (const child of node.children) parent.set(child, node.id);

  // No JavaScript on the stack is the loop waiting: workerd marks no `(idle)` of its own, so its event loop's wait reads
  // as `(program)` (measured 2026-10-23: a run read as 73 s busy in one facet, and 60 s in the assets worker, until it was).
  const waiting = new Set(['(idle)', '(program)', '(root)']);
  const idle = new Set(profile.nodes.filter((node) => waiting.has(node.callFrame.functionName)).map((node) => node.id));
  let [best, bestFrom, bestTo, run, from] = [0, 0, 0, 0, 0];

  for (const [at, sample] of profile.samples.entries()) {
    // The time since the sample before: the profiler takes none while the isolate waits, so a gap past a few intervals
    // is a wait, and the turn before it has ended (measured 2026-10-23: unbroken, a run read as 82 s busy). A host that
    // pauses the thread that long mid-turn splits the turn too: a blind spot the gate prints.
    const delta = profile.timeDeltas[at] ?? 0;

    if (idle.has(sample) || delta > LOOP_GAP_US) {
      run = 0;
      from = idle.has(sample) ? at + 1 : at;

      if (idle.has(sample)) continue;
    } else {
      run += delta;
    }

    if (run > best) [best, bestFrom, bestTo] = [run, from, at];
  }

  const counts = new Map<string, number>();
  const selves = new Map<string, number>();

  // Line and column, as the bundle's source map reads them, so a minified frame can be named.
  const named = (frame: (typeof profile.nodes)[number]['callFrame']): string =>
    `${frame.functionName || '(anonymous)'} ${frame.url.split('/').slice(-2).join('/')}:${String(frame.lineNumber + 1)}:${String(frame.columnNumber + 1)}`;

  for (let at = bestFrom; at <= bestTo; at++) {
    const seen = new Set<string>();
    const leaf = byId.get(profile.samples[at] ?? -1)?.callFrame;

    if (leaf !== undefined) selves.set(named(leaf), (selves.get(named(leaf)) ?? 0) + 1);

    for (let id: number | undefined = profile.samples[at]; id !== undefined; id = parent.get(id)) {
      const frame = byId.get(id)?.callFrame;

      if (frame === undefined || frame.functionName === '(root)') continue;
      const name = named(frame);

      if (!seen.has(name)) counts.set(name, (counts.get(name) ?? 0) + 1);
      seen.add(name);
    }
  }

  const samples = Math.max(1, bestTo - bestFrom + 1);

  const ranked = (tally: Map<string, number>, least: number) => [...tally].map(([frame, count]) => ({ frame, share: count / samples }))
    .filter((each) => each.share >= least).sort((a, b) => b.share - a.share).slice(0, 12);

  return { ms: best / 1000, frames: ranked(counts, 0.2), leaves: ranked(selves, 0.1) };
}

export interface Allocations {
  readonly total: number;
  readonly sites: readonly { readonly site: string; readonly bytes: number }[];
}

function frameName(node: ProfileNode): string {
  const { functionName, url, lineNumber } = node.callFrame;

  return `${functionName === '' ? '(anonymous)' : functionName} ${url.split('/').slice(-2).join('/')}:${String(lineNumber + 1)}`;
}

/** Every sampled allocation by the function that made it and the five nearest distinct callers (a library's own
 *  recursion collapses), collected or not: the churn, not what stays. */
function allocationSites(head: ProfileNode): Allocations {
  const bySite = new Map<string, number>();
  const pending: { node: ProfileNode; callers: readonly string[] }[] = [{ node: head, callers: [] }];
  let total = 0;

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const name = frameName(next.node);
    const outer = next.callers.filter((caller) => caller !== name).slice(-5).reverse();
    const site = outer.length === 0 ? name : `${name}  <-  ${outer.join('  <-  ')}`;
    bySite.set(site, (bySite.get(site) ?? 0) + next.node.selfSize);
    total += next.node.selfSize;
    const callers = next.callers.at(-1) === name ? next.callers : [...next.callers, name];
    pending.push(...next.node.children.map((node) => ({ node, callers })));
  }

  const sites = [...bySite].map(([site, bytes]) => ({ site, bytes })).sort((a, b) => b.bytes - a.bytes).slice(0, 25);

  return { total, sites };
}

/** A snapshot's live bytes, and the part V8 files under the node type `code`: compiled functions, their bytecode, feedback
 *  and scope data. The rest is what the isolate's programs hold. */
export interface LiveHeap {
  readonly live: number;
  readonly code: number;
}

function liveOf(snapshot: Snapshot): LiveHeap {
  const fields = snapshot.snapshot.meta.node_fields;
  const code = snapshot.snapshot.meta.node_types[0].indexOf('code');
  const [typeAt, sizeAt] = ['type', 'self_size'].map((field) => fields.indexOf(field));
  let live = 0;
  let compiled = 0;

  for (let at = 0; at < snapshot.nodes.length; at += fields.length) {
    const bytes = snapshot.nodes[at + (sizeAt ?? 0)] ?? 0;
    live += bytes;

    if (snapshot.nodes[at + (typeAt ?? 0)] === code) compiled += bytes;
  }

  return { live, code: compiled };
}

export interface Inspector {
  readonly usedHeap: () => Promise<number>;
  readonly liveHeap: () => Promise<number>;
  /** {@link liveHeap}, its code apart: one snapshot. */
  readonly liveSplit: () => Promise<LiveHeap>;
  readonly makeup: () => Promise<HeapMakeup>;
  /** The bytes of the buffer held under the property `marker`, from a snapshot: {@link markedBytes}. */
  readonly markedBytes: (marker: string) => Promise<number>;
  readonly sampleAllocations: () => Promise<void>;
  readonly allocations: () => Promise<Allocations>;
  /** Samples the isolate's CPU from now; {@link cpuBusyMs} stops it. */
  readonly sampleCpu: () => Promise<void>;
  /** The time the isolate ran since {@link sampleCpu}, idle left out, in ms. */
  readonly cpuBusyMs: () => Promise<number>;
  readonly close: () => void;
}

/** What every read answers while the loop gate profiles each isolate (`loop-turns.ts`): workerd takes one inspector
 *  session an isolate, a snapshot under a running CPU profile stalled the gate past its silence bound twice
 *  (2026-10-23), and the profiler's own allocation would move every heap figure anyway. */
const NOT_READ: Inspector = {
  usedHeap: async () => 0,
  liveHeap: async () => 0,
  liveSplit: async () => ({ live: 0, code: 0 }),
  makeup: async () => ({ kinds: [], strings: [] }),
  markedBytes: async () => 0,
  sampleAllocations: async () => {},
  allocations: async () => ({ total: 0, sites: [] }),
  sampleCpu: async () => {},
  cpuBusyMs: async () => 0,
  close: () => {},
};

/** The workerd inspector ports whose isolates the loop gate profiles, from {@link profileEveryIsolate} to its release. */
const profiled = new Set<number>();

/** Until the returned release, every {@link inspect} on `port` answers {@link NOT_READ}: the loop gate holds each of its
 *  isolates' one session. */
export function profileEveryIsolate(port: number): () => void {
  profiled.add(port);

  return () => { profiled.delete(port); };
}

type Target = v.InferOutput<typeof TargetsSchema>[number];

async function targets(port: number): Promise<Target[]> {
  return v.parse(TargetsSchema, await (await fetch(`http://127.0.0.1:${String(port)}/json`)).json());
}

/** Every isolate workerd lists, by target id. */
export async function targetIds(port: number): Promise<readonly string[]> {
  return (await targets(port)).map((target) => target.id);
}

/** One inspector session on each isolate whose target id `picks` accepts, however many there are. */
export async function inspectAll(port: number, picks: (id: string) => boolean): Promise<Inspector[]> {
  return await Promise.all((await targets(port)).filter((target) => picks(target.id))
    .map(async (target) => await inspect(port, `the isolate ${target.id}`, (id) => id === target.id)));
}

/** One inspector session on the one isolate whose target id `picks` accepts. workerd lists each isolate it made,
 *  a Worker Loader's too, as `<binding>:<loader key>` (server.c++ at v1.20260930.2, `WorkerLoaderNamespace::loadIsolate`
 *  and `makeWorkerImpl`). */
export async function inspect(port: number, isolate: string, picks: (id: string) => boolean): Promise<Inspector> {
  const listed = await targets(port);
  const [target, ...more] = listed.filter((each) => picks(each.id));

  if (target === undefined || more.length > 0) {
    throw new Error(`worker-heap: no one inspector target for ${isolate} among ${listed.map((t) => t.id).join(', ')}`);
  }

  if (profiled.has(port)) return NOT_READ;

  const { send, snapshotNow, close } = await connect(target);

  return {
    // Uncollected: what the isolate holds at this instant, garbage included.
    usedHeap: async () => v.parse(HeapUsageReplySchema, JSON.parse(await send('Runtime.getHeapUsage'))).result.usedSize,
    // A snapshot collects first, so its node sizes add up to what is live.
    makeup: async () => heapMakeup(await snapshotNow(SnapshotSchema)),
    markedBytes: async (marker) => markedBytes(await snapshotNow(GraphSchema), marker, isolate),
    liveHeap: async () => liveOf(await snapshotNow(SnapshotSchema)).live,
    liveSplit: async () => liveOf(await snapshotNow(SnapshotSchema)),
    sampleAllocations: async () => {
      await send('HeapProfiler.startSampling', { samplingInterval: 65_536, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    },
    allocations: async () => allocationSites(v.parse(SamplingReplySchema, JSON.parse(await send('HeapProfiler.stopSampling'))).result.profile.head),
    sampleCpu: async () => {
      await send('Profiler.enable');
      await send('Profiler.setSamplingInterval', { interval: 500 });
      await send('Profiler.start');
    },
    cpuBusyMs: async () => {
      const { profile } = v.parse(CpuReplySchema, JSON.parse(await send('Profiler.stop'))).result;
      const idle = new Set(profile.nodes.filter((node) => node.callFrame.functionName === '(idle)').map((node) => node.id));
      let busy = 0;

      for (const [at, sample] of profile.samples.entries()) if (!idle.has(sample)) busy += profile.timeDeltas[at] ?? 0;

      return busy / 1000;
    },
    close,
  };
}

/** An isolate's CPU profiled from {@link profileLoop} to `stop`, which answers its longest busy stretch and closes. */
export interface LoopProfile {
  readonly stop: () => Promise<BusyStretch>;
}

/** Profiles the isolate `id` from now, a sample a millisecond; null when it is no longer listed. */
export async function profileLoop(port: number, id: string): Promise<LoopProfile | null> {
  const target = (await targets(port)).find((each) => each.id === id);

  if (target === undefined) return null;
  const { send, close } = await connect(target);

  await send('Profiler.enable');
  await send('Profiler.setSamplingInterval', { interval: 1000 });
  await send('Profiler.start');

  return {
    stop: async () => {
      const stretch = longestBusy(v.parse(CpuReplySchema, JSON.parse(await send('Profiler.stop'))).result.profile);
      close();

      return stretch;
    },
  };
}

/** An open inspector session: a request's raw reply, which each caller parses for the field it asked for, and a heap
 *  snapshot, which collects first, so its node sizes add up to what is live. */
async function connect(target: Target): Promise<{
  readonly send: (method: string, params?: Readonly<Record<string, number | boolean>>) => Promise<string>;
  readonly snapshotNow: <Parsed>(schema: v.GenericSchema<Parsed>) => Promise<Parsed>;
  readonly close: () => void;
}> {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
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

  const send = (method: string, params?: Readonly<Record<string, number | boolean>>): Promise<string> => {
    next += 1;
    const answer = Promise.withResolvers<string>();
    replies.set(next, answer.resolve);
    socket.send(JSON.stringify({ id: next, method, ...(params !== undefined && { params }) }));

    return answer.promise;
  };

  const snapshotNow = async <Parsed>(schema: v.GenericSchema<Parsed>): Promise<Parsed> => {
    chunks = [];
    await send('HeapProfiler.takeHeapSnapshot');
    const snapshot = v.parse(schema, JSON.parse(chunks.join('')));
    chunks = [];

    return snapshot;
  };

  return { send, snapshotNow, close: () => { socket.close(); } };
}
