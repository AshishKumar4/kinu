/**
 * One isolate of the built Worker as `scripts/worker-heap.ts` reads it over workerd's inspector (the Chrome DevTools
 * Protocol): its heap used and live, the live heap's makeup by kind from a snapshot, and where its allocations were made,
 * sampled. The gate owns the workloads, their order and their bounds; this reads what they leave.
 */
import * as v from 'valibot';

const TargetsSchema = v.array(v.object({ id: v.string(), webSocketDebuggerUrl: v.string() }));

const InspectorReplySchema = v.object({ id: v.number() });

const HeapUsageReplySchema = v.object({ result: v.object({ usedSize: v.number() }) });

const SnapshotChunkSchema = v.object({ method: v.literal('HeapProfiler.addHeapSnapshotChunk'), params: v.object({ chunk: v.string() }) });

const SnapshotSchema = v.object({
  snapshot: v.object({ meta: v.object({ node_fields: v.array(v.string()), node_types: v.looseTuple([v.array(v.string())]) }) }),
  nodes: v.array(v.number()),
  strings: v.array(v.string()),
});

type Snapshot = v.InferOutput<typeof SnapshotSchema>;

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
  readonly sampleAllocations: () => Promise<void>;
  readonly allocations: () => Promise<Allocations>;
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
  const snapshotNow = async (): Promise<Snapshot> => {
    chunks = [];
    await send('HeapProfiler.takeHeapSnapshot');
    const snapshot = v.parse(SnapshotSchema, JSON.parse(chunks.join('')));
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
    makeup: async () => heapMakeup(await snapshotNow()),
    liveHeap: async () => {
      const snapshot = await snapshotNow();
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
