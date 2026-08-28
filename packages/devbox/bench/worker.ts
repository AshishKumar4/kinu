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
 * WHAT THE DRIVER ASSERTS BEFORE IT MEASURES. The driver composes the normal
 * short lifecycle requests — write, checkpoint, stop, wake, exec, state, and
 * object head — into one proof. An arm that fails that proof measured the
 * container's own blank disk and is not ranked.
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
  Devbox,
  describeThrown,
  parseDevboxStrategyName,
  type CheckpointKind,
  type DevboxPolicy,
  type DevboxStore,
  type DevboxStrategyName,
} from '../src/index';
import {
  R2_CLASS_A_OPERATIONS as CLASS_A,
  R2_CLASS_B_OPERATIONS as CLASS_B,
  R2_CLASS_FREE_OPERATIONS as CLASS_FREE,
  R2_OPERATION_NAMES as OP_NAMES,
  type R2OperationName as OpName,
  type R2OperationTally as OpTally,
} from './r2-operations';
import { bindingFor, storePrefixOf, strategyIsDeployed } from './strategy-dispatch';

interface BenchEnv {
  BACKUP_BUCKET: R2Bucket;
  SnapshotChainBox?: DurableObjectNamespace<SnapshotChainBox>;
  R2fsBox?: DurableObjectNamespace<R2fsBox>;
  OverlayCasBox?: DurableObjectNamespace<OverlayCasBox>;
  BoundedLayersBox?: DurableObjectNamespace<BoundedLayersBox>;
  MerklePackBox?: DurableObjectNamespace<MerklePackBox>;
  BenchOpCounter: DurableObjectNamespace<BenchOpCounter>;
  /** Supplied per run through `wrangler deploy --var`, never committed. An
   *  absent token makes every request 401. */
  BENCH_TOKEN?: string;
  /** The arms whose bindings the generated fixture config declares. */
  BENCH_SELECTED_ARMS?: string;
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
  for (const name of OP_NAMES) total += calls[name] ?? 0;
  for (const name of CLASS_A) classA += calls[name] ?? 0;
  for (const name of CLASS_B) classB += calls[name] ?? 0;
  for (const name of CLASS_FREE) classFree += calls[name] ?? 0;
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

  /** Release the benchmark container without preserving state. The caller is
   * deleting that state and must free the class's only instance first. */
  async stopForTeardown(): Promise<void> {
    await this.stop('SIGTERM');
    while (this.ctx.container?.running === true) await scheduler.wait(100);
  }

  /**
   * The DRIVER owns every measured tick.
   *
   * With the production schedule armed, an ambient tick can fire inside a
   * workload segment or inside the driver's interval wait, commit the pending
   * change, and reset the last-checkpoint stamp — so the driver's own measured
   * tick answers `skipped (within the minimum checkpoint interval)` or
   * `skipped (unchanged)` and the segment's real ops land outside the
   * flush-bounded window. docs/research/BENCH-RUNS.md records 21 such
   * mis-attributed skips in one run. With the schedule off,
   * `checkpointNow` is the only tick source; `policy.checkpointIntervalMs`
   * stays as the guard the driver waits out before ticking, because the gate
   * itself is product behaviour under test.
   */
  protected override get ambientCheckpoints(): boolean {
    return false;
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
      // 2s, not the shipped 5 minutes: the bench measures checkpoint COST,
      // not cadence, and every measured tick waits this interval out first.
      // At 30s a three-arm run slept ~20 minutes doing nothing.
      checkpointIntervalMs: 2_000,
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

export class BoundedLayersBox extends BenchBox {
  protected override get strategy(): DevboxStrategyName {
    return 'bounded-layers';
  }

  protected override get candidateRunnerPath(): string {
    return '/opt/kinu/candidate-runner.bundle.mjs';
  }
}

export class MerklePackBox extends BenchBox {
  protected override get strategy(): DevboxStrategyName {
    return 'merkle-pack';
  }

  protected override get candidateRunnerPath(): string {
    return '/opt/kinu/candidate-runner.bundle.mjs';
  }
}

// ── the driver API ──────────────────────────────────────────────────────────


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
  | DurableObjectStub<OverlayCasBox>
  | DurableObjectStub<BoundedLayersBox>
  | DurableObjectStub<MerklePackBox>;

function boxOf(
  env: BenchEnv,
  strategy: DevboxStrategyName,
  name: string,
): BenchStub {
  const binding = bindingFor(env, strategy);
  if (binding === undefined) throw new Error(`no durable-object binding for ${strategy}`);
  return binding.get(binding.idFromName(`${strategy}:${name}`));
}

/** Every field any route reads, all optional, parsed at the edge. One named
 *  shape rather than an open dictionary, so a route cannot read a key nobody
 *  declared, and a payload that disagrees is refused with its reason instead of
 *  producing a silent default. */
const DriverBodySchema = v.object({
  strategy: v.optional(v.picklist([
    'snapshot-chain',
    'r2fs',
    'overlay-cas',
    'bounded-layers',
    'merkle-pack',
  ])),
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



export default {
  async fetch(request: Request, env: BenchEnv): Promise<Response> {
    if (!authorized(request, env.BENCH_TOKEN)) return json({ ok: false, error: 'unauthorized' }, 401);

    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true });
    flushEnv = env;
    const name = url.searchParams.get('box') ?? 'devbox-bench';
    let input: DriverBody;
    try {
      input = await body(request);
    } catch (error) {
      return json({ ok: false, error: `malformed body: ${describeThrown({ cause: error })}` }, 400);
    }
    const requested = input.strategy ?? url.searchParams.get('strategy');
    const strategy = parseDevboxStrategyName(requested);
    if (strategy === null) {
      return json({
        ok: false,
        error: 'strategy is required: snapshot-chain, r2fs, overlay-cas, bounded-layers, or merkle-pack',
      }, 400);
    }

    if (!strategyIsDeployed(env, strategy)) {
      return json({
        ok: false,
        strategy,
        box: name,
        error: 'strategy not deployed in this run',
      }, 400);
    }

    const box = boxOf(env, strategy, name);
    const counter = env.BenchOpCounter.get(env.BenchOpCounter.idFromName('bench-ops'));
    const started = Date.now();

    try {
      switch (`${request.method} ${url.pathname}`) {
        case 'POST /create': {
          await box.kickStartup();
          return json({ ok: true, strategy, box: name, ms: Date.now() - started });
        }

        case 'GET /head': {
          const key = url.searchParams.get('key') ?? '';
          if (key.length === 0) return json({ ok: false, error: 'key is required' }, 400);
          const object = await env.BACKUP_BUCKET.head(key);
          return json({
            ok: object !== null,
            key,
            exists: object !== null,
            size: object?.size ?? 0,
            ms: Date.now() - started,
          }, object === null ? 404 : 200);
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
          return json({ ok: outcome.kind !== 'failed', kind, outcome, ms: Date.now() - started });
        }

        case 'POST /stop': {
          // The real quiesce path: final checkpoint, keepAlive off, SIGTERM.
          const outcome = await box.quiesce();
          return json({
            ok: outcome.kind !== 'failed', checkpoint: outcome, ms: Date.now() - started,
          });
        }

        case 'POST /wake': {
          await box.kickStartup();
          return json({ ok: true, strategy, box: name, ms: Date.now() - started });
        }

        case 'GET /state': {
          const state = await box.devboxState();
          return json({
            ok: true,
            strategy,
            box: name,
            extractionAllowed: env.ALLOW_EXTRACTION === '1',
            storePrefix: storePrefixOf(env, strategy, name),
            state,
            ms: Date.now() - started,
          });
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
          await box.stopForTeardown();
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
