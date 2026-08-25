/**
 * The devbox benchmark fixture.
 *
 * Not part of any product deploy. It exists so a driver can raise a real
 * container with a real object store, run the same workload against both
 * durability strategies, and compare them. It runs two ways:
 *
 *   `wrangler dev` — a local container, a local store, and NO container outbound
 *   interception. The snapshot chain measures its extraction path there and says
 *   so; r2fs cannot mount at all and refuses. That is enough for a smoke test
 *   and it is not a measurement.
 *
 *   `wrangler deploy` — an ephemeral Worker on a real account. The only place a
 *   number means anything: `wrangler dev --remote` refuses Durable Objects, so
 *   there is no middle ground.
 *
 * WHAT IT ASSERTS BEFORE IT MEASURES. `POST /verify` runs the full lifecycle and
 * checks four facts that a live run once reported as fine while none of them
 * held: the work directory is really attached after a wake, its writable layer
 * really exists, a forced checkpoint really committed a byte count, and the
 * object that byte count refers to is really in the store. A driver runs
 * `/verify` first. An arm that measures a box which never attached is measuring
 * the container's own blank disk.
 *
 * LOCAL /wake NUMBERS MUST NEVER BE QUOTED. After a container stops, workerd
 * reports `container-client.c++:2351: failed: broken.constructorFailed;
 * Recovered running container without a running networking sidecar`, and from
 * that point every container call in the runtime hangs for 30 s and resets the
 * Durable Object. Reproduced five times on a single box from a clean slate.
 * Two other harnesses reached the same conclusion by different routes: a probe
 * whose files vanished between consecutive RPCs, and a native-disk durability
 * result of 0 of 24 files intact across a restart against 24 of 24 on R2. The
 * container keeps nothing, and a wake is only measurable on a deployed Worker.
 *
 * SECURITY. Every route execs commands inside a container, so an absent token
 * refuses everything and the comparison is constant-time. A fixture that
 * outlives its run is inert rather than an open exec endpoint.
 */

import { ContainerProxy } from '@cloudflare/sandbox';
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';

import type { ExecOptions } from '@cloudflare/sandbox';

import {
  CAS_TREE_MOUNT,
  DEVBOX_RUNTIME_DIR,
  DEVBOX_WORKDIR,
  Devbox,
  R2FS_CACHE_DIR,
  baseObjectKey,
  deltaObjectKey,
  describeThrown,
  type AttachOutcome,
  type CheckpointKind,
  type DevboxPolicy,
  type DevboxStore,
  type DevboxStrategyName,
} from '../src/index';

interface BenchEnv {
  BACKUP_BUCKET: R2Bucket;
  SnapshotChainBox: DurableObjectNamespace<SnapshotChainBox>;
  R2fsBox: DurableObjectNamespace<R2fsBox>;
  OverlayCasBox: DurableObjectNamespace<OverlayCasBox>;
  BenchOpCounter: DurableObjectNamespace<BenchOpCounter>;
  /** Supplied per run through `wrangler deploy --var`, never committed. An
   *  absent token makes every request 401. */
  BENCH_TOKEN?: string;
  /** Set to '1' ONLY for a local `wrangler dev` run, where there is no container
   *  outbound interception and therefore no store mount. Absent on every deploy,
   *  which is what stops a deployed arm from measuring extraction and reporting
   *  it as a chain. */
  ALLOW_EXTRACTION?: string;
}

// ── object-store op counting ────────────────────────────────────────────────
//
// The whole comparison turns on how many store operations each strategy costs,
// so the count has to be complete. Two facts make it easy to get wrong, both
// measured the hard way on a deployed run:
//
//   The s3fs traffic does NOT go through the Durable Object's binding. It is
//   intercepted egress, resolved out of the ContainerProxy entrypoint's env by
//   binding name. So the proxy's env is the only seam that sees every call, and
//   wrapping the Durable Object's env alone counts almost nothing.
//
//   `uploadPart` and `complete` are calls on the handle that
//   `createMultipartUpload` RETURNED, not on the bucket. A wrapper that stops at
//   the bucket reported two class-A operations for a phase that wrote 111 MiB.

/** The R2 calls this fixture can make, by name. A closed set rather than an
 *  open dictionary: a name that is not here is a call nobody wrapped, and an
 *  open map would hide it instead of failing to compile. */
const OP_NAMES = [
  'head', 'get', 'put', 'delete', 'list',
  'createMultipartUpload', 'resumeMultipartUpload', 'uploadPart', 'abort', 'complete',
] as const;
type OpName = (typeof OP_NAMES)[number];
type OpTally = Partial<Record<OpName, number>>;

/**
 * R2 operation classes, all three of them.
 *
 * Deletes and multipart aborts are free to bill, and that is exactly why they
 * get a class of their own rather than being counted and left out of the totals.
 * The small-file phases are dominated by create, stat, read and DELETE, and the
 * decision this benchmark feeds turns on small-file churn, so a free operation
 * has to be visible even though it costs nothing. `total` sums all three.
 */
const CLASS_A: readonly OpName[] = ['put', 'list', 'createMultipartUpload',
  'resumeMultipartUpload', 'uploadPart', 'complete'];
const CLASS_B: readonly OpName[] = ['get', 'head'];
const CLASS_FREE: readonly OpName[] = ['delete', 'abort'];

/** How many counted calls may accumulate before the tally is pushed.
 *
 *  A push is one Durable Object round trip, so pushing on every call would add
 *  that trip to every intercepted s3fs request and distort the r2fs numbers,
 *  whose whole cost model is per-request. Batching amortises it to roughly one
 *  trip per 64 calls. The push is AWAITED rather than held open with
 *  `waitUntil`, which has no effect here and would drop the write on eviction. */
const FLUSH_EVERY = 64;

const pending: OpTally = {};
let pendingCount = 0;
let inFlight: Promise<void> | undefined;
let flushEnv: BenchEnv | undefined;

function countOp(name: OpName): void {
  pending[name] = (pending[name] ?? 0) + 1;
  pendingCount += 1;
}

/** Push the tally to the counter object, coalesced to one write in flight.
 *
 *  The proxy entrypoint and the fetch handler have no guarantee of sharing an
 *  isolate, so module state alone reads short from the other side and the
 *  counter object is what joins them. */
async function flushOps(env: BenchEnv): Promise<void> {
  if (inFlight !== undefined) await inFlight;
  if (pendingCount === 0) return;
  const batch = { ...pending } satisfies OpTally;
  for (const name of OP_NAMES) delete pending[name];
  pendingCount = 0;
  const run = (async () => {
    try {
      await env.BenchOpCounter.get(env.BenchOpCounter.idFromName('bench-ops')).bump(batch);
    } finally {
      inFlight = undefined;
    }
  })();
  inFlight = run;
  await run;
}

/** Push once the batch is large enough. Called after each counted call, and
 *  awaited, so nothing is left floating in an invocation that is about to end. */
async function maybeFlush(): Promise<void> {
  if (pendingCount < FLUSH_EVERY || flushEnv === undefined) return;
  await flushOps(flushEnv);
}

/**
 * A bucket that counts every call, including calls on the handles it returns.
 *
 * `Object.create` over the real binding rather than a literal: `R2Bucket` has
 * overloaded methods whose signatures cannot be restated without losing
 * evidence, and delegating through the prototype keeps every overload the
 * platform offers while the wrapper only intercepts the names it counts.
 */
function countingBucket(bucket: R2Bucket): R2Bucket {
  const counted: Partial<R2Bucket> = {
    head: async (key) => { countOp('head'); await maybeFlush(); return await bucket.head(key); },
    delete: async (keys) => {
      countOp('delete');
      await maybeFlush();
      return await bucket.delete(keys);
    },
    list: async (options) => {
      countOp('list');
      await maybeFlush();
      return await bucket.list(options);
    },
    createMultipartUpload: async (key, options) => {
      countOp('createMultipartUpload');
      await maybeFlush();
      return countingMultipart(await bucket.createMultipartUpload(key, options));
    },
    resumeMultipartUpload: (key, uploadId) => {
      countOp('resumeMultipartUpload');
      return countingMultipart(bucket.resumeMultipartUpload(key, uploadId));
    },
  };
  // `get` and `put` are counted through the prototype chain below, because their
  // overload sets are what a caller relies on and restating them here would
  // narrow what this fixture can do.
  // SAFETY: `delegate` is CONSTRUCTED with the real binding as its prototype, so
  // every member of `R2Bucket` is present on it before this line returns: the
  // names in `counted` and the two below resolve to the wrappers, and every
  // other member resolves through the prototype to the binding itself. Nothing
  // is recovered from `any` and no raw payload is validated here.
  const delegate: R2Bucket = Object.create(bucket);
  return Object.assign(delegate, counted, {
    get: async (key: string, options?: R2GetOptions) => {
      countOp('get');
      await maybeFlush();
      return await bucket.get(key, options);
    },
    put: async (
      key: string,
      value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
      options?: R2PutOptions,
    ) => {
      countOp('put');
      await maybeFlush();
      return await bucket.put(key, value, options);
    },
  });
}

/** The multipart handle. `uploadPart` and `complete` are calls on THIS object,
 *  not on the bucket, so a wrapper that stopped at the bucket would miss every
 *  byte of a large write. */
function countingMultipart(upload: R2MultipartUpload): R2MultipartUpload {
  return {
    key: upload.key,
    uploadId: upload.uploadId,
    uploadPart: async (partNumber, value) => {
      countOp('uploadPart');
      await maybeFlush();
      return await upload.uploadPart(partNumber, value);
    },
    abort: async () => { countOp('abort'); return await upload.abort(); },
    complete: async (parts) => {
      countOp('complete');
      await maybeFlush();
      return await upload.complete(parts);
    },
  };
}

/** The tally, plus every class total a cost estimate needs. */
interface OpSummary {
  readonly calls: OpTally;
  readonly classA: number;
  readonly classB: number;
  readonly classFree: number;
  readonly total: number;
}

function summarize(calls: OpTally): OpSummary {
  let classA = 0;
  let classB = 0;
  let classFree = 0;
  let total = 0;
  for (const name of OP_NAMES) {
    const count = calls[name] ?? 0;
    total += count;
    if (CLASS_A.includes(name)) classA += count;
    if (CLASS_B.includes(name)) classB += count;
    if (CLASS_FREE.includes(name)) classFree += count;
  }
  return { calls, classA, classB, classFree, total };
}

export class BenchOpCounter extends DurableObject<BenchEnv> {
  async bump(batch: OpTally): Promise<void> {
    const tally = (await this.ctx.storage.get<OpTally>('tally')) ?? {};
    for (const name of OP_NAMES) {
      const count = batch[name];
      if (count === undefined) continue;
      tally[name] = (tally[name] ?? 0) + count;
    }
    await this.ctx.storage.put('tally', tally);
  }

  async read(): Promise<OpTally> {
    return (await this.ctx.storage.get<OpTally>('tally')) ?? {};
  }

  async reset(): Promise<OpTally> {
    const tally = await this.read();
    await this.ctx.storage.delete('tally');
    return tally;
  }
}

/**
 * The SDK builds its interception fetchers from `ctx.exports.ContainerProxy`, so
 * this class has to be exported under that exact name. Its env is wrapped, which
 * is what puts the s3fs traffic on the meter, and its fetch holds the flush open
 * with `waitUntil` — a Worker entrypoint, where `waitUntil` is real, unlike
 * inside a Durable Object.
 */
class CountingContainerProxy extends ContainerProxy {
  constructor(ctx: ExecutionContext, env: BenchEnv) {
    // The counting binding is installed HERE, in the constructor, because the
    // egress handler resolves the bucket out of this entrypoint's env by
    // binding name. Wrapping the Durable Object's env instead counts almost
    // nothing: the s3fs traffic never passes through it.
    super(ctx, { ...env, BACKUP_BUCKET: countingBucket(env.BACKUP_BUCKET) });
    flushEnv = env;
  }
}

export { CountingContainerProxy as ContainerProxy };

// ── the two boxes ───────────────────────────────────────────────────────────
//
// Two Durable Object classes rather than one with a runtime switch, because a
// box's strategy cannot change once it holds bytes: the two write different
// things. A class per strategy makes that structural, and the driver picks an
// arm by picking a namespace.

class BenchBox extends Devbox<BenchEnv> {
  /**
   * Bind this isolate's flush target.
   *
   * MEASURED DEFECT THIS REPAIRS. `store` below counts every write into MODULE
   * state, and module state is per isolate. `flushEnv` was set only by
   * `CountingContainerProxy`'s constructor, which is a different entrypoint, so
   * in the Durable Object's isolate it was `undefined` — `maybeFlush` returned
   * early, the tally was never pushed, and `GET /ops` drained whichever isolate
   * served the request. A full run therefore reported thousands of megabytes PUT
   * against class A = 0 on every arm, which prices half a gigabyte at $0.00.
   */
  constructor(...args: ConstructorParameters<typeof Devbox<BenchEnv>>) {
    super(...args);
    // args[1] is the env the base binds; taking it from the tuple keeps this
    // constructor's signature identical to the base's rather than restating a
    // platform type that can drift.
    flushEnv = args[1];
  }

  /**
   * Drain this isolate's tally, from this isolate.
   *
   * Called as RPC at the END of every instrumented operation, so it executes
   * where the counting happened rather than where the request was served. That
   * is what makes the count independent of `FLUSH_EVERY`: the threshold stays as
   * an optimisation WITHIN an operation, and correctness no longer depends on an
   * operation happening to issue 64 calls before it ends.
   */
  async flushOpTally(): Promise<void> {
    await flushOps(this.env);
  }

  protected override get store(): DevboxStore {
    return { binding: 'BACKUP_BUCKET', bucket: countingBucket(this.env.BACKUP_BUCKET) };
  }

  /** Local `wrangler dev` has no outbound interception, so the chain cannot
   *  mount there and extraction is the only way the fixture runs at all. A
   *  DEPLOY must never set this: an arm that silently measured extraction would
   *  report a fixed-cost attach it never performed. */
  protected override get allowExtraction(): boolean {
    return this.env.ALLOW_EXTRACTION === '1';
  }

  /** Shortened from the shipped defaults so an arm does not sit for half an hour
   *  waiting to be allowed to quiesce. The gate ORDER is what is under test; the
   *  waiting is not. */
  protected override get policy(): DevboxPolicy {
    return {
      heartbeatSeconds: 30,
      idleMs: 60_000,
      quietConfirmMs: 30_000,
      checkpointIntervalMs: 30_000,
      // A BUDGET IS A CEILING, NOT A DELAY.
      //
      // MEASURED: at 25_000 the r2fs arm died with `Devbox.attach exceeded its
      // 25000ms budget and was abandoned` while attaching a 400 MiB workspace,
      // and that death is terminal — every later operation answers `no attached
      // work directory` and the armed retry never succeeds. So the arm lost every
      // workload after it and the run produced no git tick to rank.
      //
      // Raising it costs the lifecycle tests NOTHING, which is the point: an
      // attach that completes in two seconds still completes in two seconds. The
      // neighbouring comment's fear of "sitting for half an hour" is about
      // `idleMs` and `quietConfirmMs`, which are waits; this is an abandonment
      // ceiling and only ever fires on work that was still progressing. 25 s was
      // right for a lifecycle test that attaches an empty box and wrong for a
      // storage benchmark that attaches half a gigabyte, and reporting a
      // fixture-shortened ceiling as a product bound would be a false limit.
      attachBudgetMs: 300_000,
      // Shortened too: an arm that restarts a port waits for its listener, and
      // the fixture's own server binds immediately.
      portWaitMs: 6_000,
      portProbeIntervalMs: 1_000,
    };
  }
}

export class SnapshotChainBox extends BenchBox {
  protected override get strategy(): DevboxStrategyName {
    return 'snapshot-chain';
  }
}

export class R2fsBox extends BenchBox {
  protected override get strategy(): DevboxStrategyName {
    return 'r2fs';
  }
}

export class OverlayCasBox extends BenchBox {
  protected override get strategy(): DevboxStrategyName {
    return 'overlay-cas';
  }
}

// ── the driver API ──────────────────────────────────────────────────────────

interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

/** Every driver answer is a JSON object. Generic, so each route keeps its own
 *  concrete answer type and this helper only owns the framing. */
function json<Answer>(payload: Answer, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Constant-time bearer comparison. An absent expected token refuses
 *  everything: this Worker execs arbitrary commands in a container, so a
 *  default-open posture on the public edge would be indefensible even for a
 *  fixture. */
function authorized(request: Request, expected: string | undefined): boolean {
  if (expected === undefined || expected.length === 0) return false;
  const offered = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (offered.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= offered.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/** The stub for one box. Every namespace holds a `BenchBox` subclass, and the
 *  routes only ever call methods the base class declares, so one return type
 *  serves every arm. */
type BenchStub =
  | DurableObjectStub<SnapshotChainBox>
  | DurableObjectStub<R2fsBox>
  | DurableObjectStub<OverlayCasBox>;

function boxOf(
  env: BenchEnv,
  strategy: DevboxStrategyName,
  name: string,
): BenchStub {
  const id = `${strategy}:${name}`;
  if (strategy === 'r2fs') return env.R2fsBox.get(env.R2fsBox.idFromName(id));
  if (strategy === 'overlay-cas') return env.OverlayCasBox.get(env.OverlayCasBox.idFromName(id));
  return env.SnapshotChainBox.get(env.SnapshotChainBox.idFromName(id));
}

/** Every field any route reads, all optional, parsed at the edge. One named
 *  shape rather than an open dictionary, so a route cannot read a key nobody
 *  declared, and a payload that disagrees is refused with its reason instead of
 *  producing a silent default. */
const DriverBodySchema = v.object({
  strategy: v.optional(v.picklist(['snapshot-chain', 'r2fs', 'overlay-cas'])),
  command: v.optional(v.string()),
  cwd: v.optional(v.string()),
  path: v.optional(v.string()),
  content: v.optional(v.string()),
  kind: v.optional(v.picklist(['tick', 'quiesce'])),
  purge: v.optional(v.boolean()),
  prefix: v.optional(v.string()),
  whole: v.optional(v.boolean()),
});
type DriverBody = v.InferOutput<typeof DriverBodySchema>;

async function body(request: Request): Promise<DriverBody> {
  if (request.method !== 'POST') return {};
  const text = await request.text();
  if (text.length === 0) return {};
  const parsed = v.safeParse(DriverBodySchema, JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`body does not match the driver contract: ${parsed.issues[0]?.message ?? ''}`);
  }
  return parsed.output;
}

/** Drive the first operation after a stop until the runtime has finished
 *  closing. Bounded, so a genuinely dead box still fails rather than spinning. */
async function settleAfterStop(box: BenchStub): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await box.exec('true');
      return;
    } catch (error) {
      last = error;
      await scheduler.wait(1_000 * (attempt + 1));
    }
  }
  throw new Error(
    `the box never answered after being stopped: ${describeThrown({ cause: last })}`,
    { cause: last },
  );
}

/**
 * The four assertions, run as the lifecycle that produces them.
 *
 * Each one was reported as satisfied by a live run in which none of them held,
 * so each is read back from the container or the store rather than inferred
 * from a call that returned.
 *
 * ONE CONTAINER OPERATION PER EXEC. Every step below is its own `exec`, and a
 * future step must be too. There is a hard per-exec ceiling on the deployed
 * path, around six minutes, that no option raises: a combined seven-phase exec
 * died at it twice, and each attempt pays the whole ceiling before failing, so
 * batching turns a failed arm into hours spent waiting to be told no. Batching
 * two operations into one exec here would move that discovery to a deployed
 * run.
 */
async function verify(
  env: BenchEnv,
  strategy: DevboxStrategyName,
  name: string,
): Promise<{ checks: Check[]; passed: boolean }> {
  const box = boxOf(env, strategy, name);
  const checks: Check[] = [];
  const add = (check: Check): void => { checks.push(check); };

  // A marker written through the box's own default working directory. If the
  // default is wrong, the marker lands somewhere no checkpoint archives, and
  // every later check fails for the right reason.
  const marker = `devbox-verify-${Date.now()}`;
  const first = await box.exec(`printf %s ${marker} > ./verify-a.txt && cat ./verify-a.txt`);
  add({
    name: 'default cwd is the durable work directory',
    pass: first.exitCode === 0 && first.stdout.includes(marker),
    detail: `exit ${first.exitCode}, cwd default ${DEVBOX_WORKDIR}`,
  });

  // Base layer. `quiesce` rather than `tick` so the interval gate cannot
  // decline it — the gate is an efficiency rule and this is a proof.
  const base = await box.checkpointNow('quiesce');
  add({
    name: 'the first checkpoint MOVED bytes into the store',
    // `movedBytes`, not `bytes`. `bytes` is what the box HOLDS after the
    // commit, so on a box that already held data this row passed whether or
    // not this checkpoint did anything — and a quiesce that staged, folded and
    // advanced the cursor once reported `skipped 0B` while the store held
    // everything. `undefined` is a strategy that cannot attribute bytes to a
    // commit boundary (r2fs), which is not the same as having moved none.
    pass: base.kind === 'committed'
      && (base.movedBytes === undefined || base.movedBytes > 0),
    detail: `${base.kind} moved=${base.movedBytes ?? 'n/a'} held=${base.bytes ?? 0}B `
      + `${base.reason ?? ''}`.trim(),
  });

  // A real recycle. Everything on the container's disk goes away here, which is
  // the fact the whole package exists for.
  await box.quiesce();
  // The first call after a stop races the runtime's own teardown and answers
  // `OperationInterruptedError: ... while the runtime connection was closing`.
  // That is transient by construction, not a result, so it is retried rather
  // than reported. Measured on both the local and the deployed path.
  await settleAfterStop(box);
  const woken = await box.devboxState();
  const attach: AttachOutcome | undefined = woken.lastAttach;
  add({
    name: 'the wake attached durable bytes',
    pass: attach?.kind === 'attached',
    detail: `${attach?.kind ?? 'no attach recorded'}: ${attach?.detail ?? ''}`,
  });

  // Assertions one and two, read from the container, and keyed on the mode the
  // PERSISTED STATE claims rather than on the strategy name. An extraction-mode
  // box has a plain directory by design, so demanding an overlay there fails a
  // path that is working correctly — the same mistake as asserting a mount shape
  // the mechanism never publishes.
  const mode = woken.chain?.mode;
  const mounts = await box.exec(`cat /proc/mounts | grep -F ${DEVBOX_WORKDIR} || true`);
  const line = mounts.stdout.trim().split('\n')[0] ?? '';
  if (strategy === 'r2fs' || strategy === 'overlay-cas' || mode === 'chain') {
    // fuse-overlayfs reports `fuse.fuse-overlayfs` and s3fs reports `fuse.s3fs`,
    // so each is matched by its own mechanism and never by the `fuse` family.
    // overlay-cas attaches with fuse-overlayfs, like the chain.
    const expected = strategy === 'r2fs' ? 's3fs' : 'overlay';
    add({
      name: `${DEVBOX_WORKDIR} is really a ${expected} mount`,
      pass: line.includes(expected),
      detail: line.length > 0 ? line : '(no mount line)',
    });
    const writable = strategy === 'r2fs'
      ? R2FS_CACHE_DIR
      : strategy === 'overlay-cas'
        ? `${DEVBOX_RUNTIME_DIR}/cas-upper`
        : `${DEVBOX_RUNTIME_DIR}/upper`;
    const exists = await box.exec(`test -d ${writable} && echo yes || echo no`);
    add({
      name: 'the writable layer exists',
      pass: exists.stdout.trim() === 'yes',
      detail: `${writable} -> ${exists.stdout.trim()}`,
    });
    if (strategy === 'overlay-cas') {
      // DISK STATE, NOT CALL STATE — its own row, modelled on the chain's base
      // layer row. The overlay line proves /workspace is mounted; this proves
      // the tree/ LOWER under it is really there on the disk this exec landed
      // on, which a container replacement between attach RPCs would erase.
      const lower = await box.exec(
        `test -d ${CAS_TREE_MOUNT} && grep -qs ' ${CAS_TREE_MOUNT} ' /proc/mounts `
        + '&& echo yes || echo no',
      );
      add({
        name: 'the tree/ lower is present and mounted at its lower path',
        pass: lower.stdout.trim() === 'yes',
        detail: `${CAS_TREE_MOUNT} -> ${lower.stdout.trim()}`,
      });
    } else if (strategy !== 'r2fs') {
      // DISK STATE, NOT CALL STATE — its own row because a folded check gets
      // absorbed into a passing parent. The overlay line above proves /workspace
      // is mounted; this proves the BASE LAYER under it is really there: the
      // directory exists AND /proc/mounts holds a squashfs line at exactly that
      // path. Run 9's failure mode was invisible to every call-shaped check:
      // the container had been replaced between attach RPCs and the lower
      // directory did not exist on the disk the next exec landed on.
      const lowerBase = `${DEVBOX_RUNTIME_DIR}/lower-base`;
      const layer = await box.exec(
        `test -d ${lowerBase} && grep -qs ' ${lowerBase} ' /proc/mounts && echo yes || echo no`,
      );
      add({
        name: 'the base layer is present and mounted at its lower path',
        pass: layer.stdout.trim() === 'yes',
        detail: `${lowerBase} -> ${layer.stdout.trim()}`,
      });
    }
  } else {
    add({
      name: `${DEVBOX_WORKDIR} is a plain directory, as extraction mode requires`,
      pass: line.length === 0,
      detail: line.length === 0
        ? `mode ${mode ?? 'none'}: no mount expected, and none present`
        : `mode ${mode ?? 'none'} but something is mounted: ${line}`,
    });
    add({
      name: 'extraction is permitted on this host',
      // A deployed host must never reach this branch: ALLOW_EXTRACTION is set
      // only for a local `wrangler dev` run, so an extract-mode box here means
      // the fixture was deployed with it set.
      pass: env.ALLOW_EXTRACTION === '1',
      detail: `ALLOW_EXTRACTION=${env.ALLOW_EXTRACTION ?? '(unset)'}`,
    });
  }

  // The marker has to have survived the recycle, or the durability claim is
  // about nothing.
  const survived = await box.exec('cat ./verify-a.txt 2>/dev/null || echo MISSING');
  add({
    name: 'the pre-stop write survived the recycle',
    pass: survived.stdout.includes(marker),
    detail: survived.stdout.trim().slice(0, 80),
  });

  // Assertion three and four: a second write, a forced checkpoint, and the
  // object that checkpoint's byte count refers to, read from the store.
  await box.exec('printf second > ./verify-b.txt');
  const second = await box.checkpointNow('quiesce');
  add({
    name: 'the post-attach checkpoint MOVED the new write into the store',
    // A 7-byte write after a recycle. Held bytes barely move; moved bytes are
    // the quantity that proves this checkpoint carried the write.
    pass: second.kind === 'committed'
      && (second.movedBytes === undefined || second.movedBytes > 0),
    detail: `${second.kind} moved=${second.movedBytes ?? 'n/a'} held=${second.bytes ?? 0}B `
      + `${second.reason ?? ''}`.trim(),
  });

  const state = await box.devboxState();
  if (strategy === 'r2fs') {
    // r2fs has no layer objects: the prefix IS the filesystem, so the store-side
    // proof is that the prefix holds bytes.
    const listed = await env.BACKUP_BUCKET.list({ prefix: 'boxes/' });
    const bytes = listed.objects.reduce((sum, object) => sum + object.size, 0);
    add({
      name: 'the store holds the committed bytes',
      pass: bytes > 0,
      detail: `${listed.objects.length} objects, ${bytes}B under boxes/`,
    });
  } else if (strategy === 'overlay-cas') {
    // overlay-cas has no single layer object either. A quiesce folds, so the
    // proof is the two things a fold must leave behind: a materialized tree
    // and a cursor naming what it folded. Separate rows: a tree with no cursor
    // is a fold that never finished, and that is the crash window this
    // strategy's whole ordering exists to make survivable.
    const listed = await env.BACKUP_BUCKET.list({ prefix: 'boxes/' });
    const treeObjects = listed.objects.filter(object => object.key.includes('/tree/'));
    const treeBytes = treeObjects.reduce((sum, object) => sum + object.size, 0);
    add({
      name: 'the folded tree holds the committed bytes',
      pass: treeBytes > 0,
      detail: `${treeObjects.length} tree objects, ${treeBytes}B under boxes/`,
    });
    const cursor = listed.objects.find(object => object.key.endsWith('/cursor.json'));
    add({
      name: 'the fold advanced the durable cursor',
      pass: cursor !== undefined && cursor.size > 0,
      detail: cursor === undefined ? 'no cursor.json' : `${cursor.key} -> ${cursor.size}B`,
    });
  } else {
    const chainId = state.chain?.base.id;
    const key = state.chain?.mode === 'extract'
      ? (chainId === undefined ? undefined : baseObjectKey(chainId))
      : (chainId === undefined ? undefined : deltaObjectKey(chainId));
    const head = key === undefined ? null : await env.BACKUP_BUCKET.head(key);
    add({
      // Named for what it is in each mode. Extraction has no delta by design,
      // so demanding one there would fail a path that is working correctly.
      name: state.chain?.mode === 'extract'
        ? 'the archive object exists in the store with non-zero size'
        : 'the delta object exists in the store with non-zero size',
      pass: head !== null && head.size > 0,
      detail: `${key ?? '(no chain recorded)'} -> ${head === null ? 'missing' : `${head.size}B`}`,
    });
  }

  return { checks, passed: checks.every(check => check.pass) };
}

export default {
  async fetch(request: Request, env: BenchEnv): Promise<Response> {
    if (!authorized(request, env.BENCH_TOKEN)) return json({ ok: false, error: 'unauthorized' }, 401);

    flushEnv = env;
    const url = new URL(request.url);
    const name = url.searchParams.get('box') ?? 'devbox-bench';
    let input: DriverBody;
    try {
      input = await body(request);
    } catch (error) {
      return json({ ok: false, error: `malformed body: ${describeThrown({ cause: error })}` }, 400);
    }
    const requested = input.strategy ?? url.searchParams.get('strategy');
    const strategy: DevboxStrategyName = requested === 'r2fs'
      ? 'r2fs'
      : requested === 'overlay-cas'
        ? 'overlay-cas'
        : 'snapshot-chain';

    const box = boxOf(env, strategy, name);
    const counter = env.BenchOpCounter.get(env.BenchOpCounter.idFromName('bench-ops'));
    const started = Date.now();

    try {
      switch (`${request.method} ${url.pathname}`) {
        case 'POST /create': {
          // Forces the attach now, so `/create` measures the cold path rather
          // than deferring it into whatever operation comes first.
          //
          // Retried past container-capacity refusals ("there is no container
          // instance that can be provided to this durable object"). That is the
          // account having no room at this instant, not a fact about either
          // strategy, and letting it through would score a strategy on it.
          let attach: AttachOutcome | undefined;
          let refusal: unknown;
          for (let attempt = 0; attempt < 4; attempt += 1) {
            try {
              attach = await box.attachNow();
              break;
            } catch (error) {
              refusal = error;
              if (!/no container instance/i.test(describeThrown({ cause: error }))) throw error;
              await scheduler.wait(2_000 * (attempt + 1));
            }
          }
          if (attach === undefined) {
            return json({
              ok: false,
              strategy,
              box: name,
              error: `container capacity: ${describeThrown({ cause: refusal })}`,
              ms: Date.now() - started,
            }, 503);
          }
          return json({ ok: true, strategy, box: name, attach, ms: Date.now() - started });
        }

        case 'POST /verify': {
          const result = await verify(env, strategy, name);
          await flushOps(env);
          return json({
            ok: result.passed, strategy, box: name, ...result, ms: Date.now() - started,
          }, result.passed ? 200 : 500);
        }

        case 'POST /exec': {
          // ONE exec per call, deliberately. A single exec carrying several
          // phases has been measured dying at a hard per-exec ceiling around six
          // minutes, with no option raising it, so a slow arm that batches its
          // phases reports nothing at all.
          const options: ExecOptions = {};
          if (input.cwd !== undefined) options.cwd = input.cwd;
          const result = await box.exec(input.command ?? 'true', options);
          return json({
            ok: result.exitCode === 0,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            ms: Date.now() - started,
          });
        }

        case 'POST /write': {
          // Re-callable on purpose: nothing on the container's disk survives a
          // recycle, so a consumer that finds its harness missing reinstalls it
          // by calling this again.
          const path = input.path ?? '';
          const content = input.content ?? '';
          if (path.length === 0) return json({ ok: false, error: 'path is required' }, 400);
          await box.writeFile(path, content);
          return json({ ok: true, path, bytes: content.length, ms: Date.now() - started });
        }

        case 'POST /checkpoint': {
          const kind: CheckpointKind = input.kind === 'tick' ? 'tick' : 'quiesce';
          const outcome = await box.checkpointNow(kind);
          await box.flushOpTally();
          return json({ ok: outcome.kind !== 'failed', kind, outcome, ms: Date.now() - started });
        }

        case 'POST /stop': {
          // The real quiesce path: final checkpoint, keepAlive off, SIGTERM.
          const outcome = await box.quiesce();
          await box.flushOpTally();
          return json({
            ok: outcome.kind !== 'failed', checkpoint: outcome, ms: Date.now() - started,
          });
        }

        case 'POST /wake': {
          // One operation is enough: `ensureReady` starts the container AND
          // attaches before the operation runs. The outcome is read back from
          // durable state, so a wake that restored nothing cannot look like one
          // that did. Retried past the runtime's own teardown window.
          await settleAfterStop(box);
          const state = await box.devboxState();
          await box.flushOpTally();
          return json({
            ok: true,
            attach: state.lastAttach,
            running: state.running,
            ms: Date.now() - started,
          });
        }

        case 'GET /state': {
          const state = await box.devboxState();
          return json({ ok: true, strategy, box: name, state, ms: Date.now() - started });
        }

        case 'GET /ops': {
          // BOTH isolates, not one. The tally is per-isolate module state: the
          // Durable Object counts its own writes and the worker counts its own,
          // and draining only the isolate that serves this request is what made
          // a completed run report thousands of megabytes PUT against zero
          // operations. The RPC executes inside the object, so it drains the
          // side this handler cannot reach.
          await box.flushOpTally();
          await flushOps(env);
          await scheduler.wait(750);
          return json({ ok: true, ...summarize(await counter.read()) });
        }

        case 'POST /ops/flush': {
          // The driver calls this at every phase boundary. Batching keeps the
          // counter out of the per-request latency path, and this bounds the
          // unflushed window to inside one phase, which is what makes per-phase
          // attribution exact. A silently short cost column is worse than an
          // absent one, because nobody re-derives a number that already has a
          // value.
          await box.flushOpTally();
          await flushOps(env);
          return json({ ok: true, ...summarize(await counter.read()) });
        }

        case 'POST /ops/reset': {
          await box.flushOpTally();
          await flushOps(env);
          await scheduler.wait(750);
          return json({ ok: true, ...summarize(await counter.reset()) });
        }

        case 'POST /teardown': {
          await box.discardState();
          let purged = 0;
          // An empty prefix means the whole store, which is only ever correct
          // when the caller created it for this run. Requiring the intent to be
          // spelled out is what keeps a typo from emptying a real bucket.
          if (input.purge === true) {
            const prefix = input.prefix ?? '';
            if (prefix.length === 0 && input.whole !== true) {
              return json({
                ok: false,
                error: 'an empty prefix means the whole bucket; pass whole:true to mean it',
              }, 400);
            }
            for (;;) {
              const page = await env.BACKUP_BUCKET.list({ prefix });
              const keys = page.objects.map(object => object.key);
              if (keys.length === 0) break;
              await env.BACKUP_BUCKET.delete(keys);
              purged += keys.length;
            }
          }
          return json({
            ok: true,
            discarded: true,
            purged,
            // Stated rather than implied: a purge cannot promise an empty
            // bucket. Pending multipart uploads count towards emptiness and the
            // Workers binding cannot enumerate them, so a bucket delete can
            // still refuse after a purge that found nothing. Use a dedicated
            // bucket with a lifecycle rule aborting incomplete multipart
            // uploads.
            emptyBucketGuaranteed: false,
            ms: Date.now() - started,
          });
        }

        default:
          return json({ ok: false, error: `no route for ${request.method} ${url.pathname}` }, 404);
      }
    } catch (error) {
      // The driver needs the reason, not a 500 with no body: a refusal from the
      // storage path is a result, and losing its text costs the container time
      // the run has already spent.
      return json({
        ok: false, strategy, box: name, error: describeThrown({ cause: error }), ms: Date.now() - started,
      }, 502);
    }
  },
};
