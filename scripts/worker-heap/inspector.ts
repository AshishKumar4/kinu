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
  nodes: v.array(v.object({ id: v.number(), callFrame: v.object({ functionName: v.string() }) })),
  samples: v.array(v.number()),
  timeDeltas: v.array(v.number()),
}) }) });

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

export interface Inspector {
  readonly usedHeap: () => Promise<number>;
  readonly liveHeap: () => Promise<number>;
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

/** One inspector session on each isolate whose target id `picks` accepts, however many there are. */
export async function inspectAll(port: number, picks: (id: string) => boolean): Promise<Inspector[]> {
  const targets = v.parse(TargetsSchema, await (await fetch(`http://127.0.0.1:${String(port)}/json`)).json());

  return await Promise.all(targets.filter((target) => picks(target.id))
    .map(async (target) => await inspect(port, `the isolate ${target.id}`, (id) => id === target.id)));
}

/** One inspector session on the one isolate whose target id `picks` accepts. workerd lists each isolate it made,
 *  a Worker Loader's too, as `<binding>:<loader key>` (server.c++ at v1.20260930.2, `WorkerLoaderNamespace::loadIsolate`
 *  and `makeWorkerImpl`). */
export async function inspect(port: number, isolate: string, picks: (id: string) => boolean): Promise<Inspector> {
  const targets = v.parse(TargetsSchema, await (await fetch(`http://127.0.0.1:${String(port)}/json`)).json());
  const [target, ...more] = targets.filter((each) => picks(each.id));

  if (target === undefined || more.length > 0) {
    throw new Error(`worker-heap: no one inspector target for ${isolate} among ${targets.map((t) => t.id).join(', ')}`);
  }

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

  /** A snapshot collects first, so its node sizes add up to what is live. */
  const snapshotNow = async <Parsed>(schema: v.GenericSchema<Parsed>): Promise<Parsed> => {
    chunks = [];
    await send('HeapProfiler.takeHeapSnapshot');
    const snapshot = v.parse(schema, JSON.parse(chunks.join('')));
    chunks = [];

    return snapshot;
  };

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
    makeup: async () => heapMakeup(await snapshotNow(SnapshotSchema)),
    markedBytes: async (marker) => markedBytes(await snapshotNow(GraphSchema), marker, isolate),
    liveHeap: async () => {
      const snapshot = await snapshotNow(SnapshotSchema);
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
    close: () => { socket.close(); },
  };
}
