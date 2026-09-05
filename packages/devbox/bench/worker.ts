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
 * THE TWO MINUTE-SCALE ROUTES ARE ASYNCHRONOUS. `POST /checkpoint` and
 * `POST /stop` arm a durable one-shot, answer 202 with a token, and publish
 * their outcome into this object's storage for `GET /operation?token=` to read.
 * A request that stayed open for the operation put a 180 s client deadline in
 * front of a publication with no bound, and the retry that followed ran a
 * SECOND publication over a box already saturated. `armBenchOperation` records
 * the deployed runs that proved it.
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
  BOUNDED_LAYERS_FORMAT,
  Devbox,
  MERKLE_PACK_FORMAT,
  RootEnvelopeV1Schema,
  describeThrown,
  parseDevboxStrategyName,
  type CheckpointKind,
  type CheckpointOutcome,
  type DevboxPolicy,
  type DevboxStore,
  type DevboxStrategyName,
  type RootEnvelopeV1,
} from '../src/index';
import {
  CANDIDATE_JOURNAL_BINARY,
  CANDIDATE_JOURNAL_MOUNT,
  CANDIDATE_JOURNAL_ROOT,
  CANDIDATE_JOURNAL_SOCKET,
  CANDIDATE_STORE_MOUNT,
  candidateStorePaths,
} from '../src/candidates/container';
import { sha256Hex } from '../src/cas/hash';
import { JOURNAL_READY_PROBE, JOURNAL_READY_PROBE_PATH, journalReadyRunCommand } from './journal-ready-probe';
import {
  R2_CLASS_A_OPERATIONS as CLASS_A,
  R2_CLASS_B_OPERATIONS as CLASS_B,
  R2_CLASS_FREE_OPERATIONS as CLASS_FREE,
  R2_OPERATION_NAMES as OP_NAMES,
  type R2OperationName as OpName,
  type R2OperationTally as OpTally,
} from './r2-operations';
import { bindingFor, storePrefixOf, strategyIsDeployed } from './strategy-dispatch';
import { runBenchSecurityCells, type SecurityCellsObservation } from './security-cells';

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

/**
 * Raw container evidence for one candidate attachment.
 *
 * Every `expected*` field is the path the candidate storage itself uses,
 * carried so the driver never restates it. `mounts` is the whole of
 * `/proc/mounts`: a fixture that pre-selected "the interesting line" would
 * decide which mount counts, and that decision belongs to the judge.
 */
export interface CandidateContainerFacts {
  readonly expectedWorkdirMount: string;
  readonly expectedStoreMount: string;
  readonly expectedJournalRoot: string;
  readonly expectedJournalSocket: string;
  readonly expectedJournalBinary: string;
  readonly mounts: string;
  readonly journalRootPresent: boolean;
  readonly journalSocketPresent: boolean;
  /** Did the control socket answer one read-only `stats` request, rather than
   *  merely exist as a filesystem entry? */
  readonly journalReady: boolean;
  /** The daemon response when ready, or the exec/socket failure when not. */
  readonly journalReadyDetail: string;
  /** The journal daemon's own argv, space-joined, or '' when no such process
   *  is alive in the container. */
  readonly journalDaemonCommand: string;
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

/** What a `get` served, by what the key holds. A candidate control envelope
 *  is metadata; every other object in the store is payload. The snapshot
 *  chain keeps its control record in Durable Object storage, so its wake
 *  serves payload bytes alone. No other operation moves an object body into
 *  the box. */
const BYTE_CLASSES = ['payload', 'metadata'] as const;
type ByteClass = (typeof BYTE_CLASSES)[number];
export type ByteTally = Partial<Record<ByteClass, number>>;

const pending: OpTally = {};
const pendingBytes: ByteTally = {};
let pendingCount = 0;
let inFlight: Promise<void> | undefined;
let flushEnv: BenchEnv | undefined;

function countOp(name: OpName): void {
  pending[name] = (pending[name] ?? 0) + 1;
  pendingCount += 1;
}

function countBytes(key: string, served: number): void {
  const cls: ByteClass = key.includes('/candidate-control/') ? 'metadata' : 'payload';
  pendingBytes[cls] = (pendingBytes[cls] ?? 0) + served;
}

/** The bytes one `get` served: the range R2 answered when one was asked for,
 *  the whole object otherwise. */
function servedBytes(object: R2ObjectBody): number {
  const range = object.range;
  if (range === undefined) return object.size;
  if ('suffix' in range) return range.suffix;
  return range.length ?? object.size - (range.offset ?? 0);
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
  const bytes = { ...pendingBytes } satisfies ByteTally;
  for (const name of OP_NAMES) delete pending[name];
  for (const cls of BYTE_CLASSES) delete pendingBytes[cls];
  pendingCount = 0;
  const run = (async () => {
    try {
      await env.BenchOpCounter.get(env.BenchOpCounter.idFromName('bench-ops')).bump(batch, bytes);
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
      const object = await bucket.get(key, options);
      // A conditional `get` whose condition failed answers an `R2Object` with
      // no body, so it served nothing.
      if (object !== null && 'body' in object) countBytes(key, servedBytes(object));
      return object;
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

/** The tally, plus every class total a cost estimate needs, plus the bytes
 *  `get` served. */
interface OpSummary {
  readonly calls: OpTally;
  readonly classA: number;
  readonly classB: number;
  readonly classFree: number;
  readonly total: number;
  readonly bytes: ByteTally;
}

function summarize(counts: OpCounts): OpSummary {
  const calls = counts.calls;
  let classA = 0;
  let classB = 0;
  let classFree = 0;
  let total = 0;
  for (const name of OP_NAMES) total += calls[name] ?? 0;
  for (const name of CLASS_A) classA += calls[name] ?? 0;
  for (const name of CLASS_B) classB += calls[name] ?? 0;
  for (const name of CLASS_FREE) classFree += calls[name] ?? 0;
  return { calls, classA, classB, classFree, total, bytes: counts.bytes };
}

/** The two tallies the counter object keeps: calls by operation, and the
 *  bytes `get` served by what the key holds. */
export interface OpCounts {
  readonly calls: OpTally;
  readonly bytes: ByteTally;
}

export class BenchOpCounter extends DurableObject<BenchEnv> {
  async bump(batch: OpTally, bytes: ByteTally): Promise<void> {
    const tally = (await this.ctx.storage.get<OpTally>('tally')) ?? {};
    for (const name of OP_NAMES) {
      const count = batch[name];
      if (count === undefined) continue;
      tally[name] = (tally[name] ?? 0) + count;
    }
    const served = (await this.ctx.storage.get<ByteTally>('bytes')) ?? {};
    for (const cls of BYTE_CLASSES) {
      const count = bytes[cls];
      if (count === undefined) continue;
      served[cls] = (served[cls] ?? 0) + count;
    }
    await this.ctx.storage.put({ tally, bytes: served });
  }

  async read(): Promise<OpCounts> {
    return {
      calls: (await this.ctx.storage.get<OpTally>('tally')) ?? {},
      bytes: (await this.ctx.storage.get<ByteTally>('bytes')) ?? {},
    };
  }

  async reset(): Promise<OpCounts> {
    const counts = await this.read();
    await this.ctx.storage.delete(['tally', 'bytes']);
    return counts;
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

// ── the async operation protocol ────────────────────────────────────────────
//
// Two operations in this fixture are minute-scale and neither fits inside one
// HTTP request: a checkpoint that publishes a generation, and a stop that takes
// a final checkpoint before it releases the container. Both are armed as a
// durable one-shot and answered by a token the driver polls. See
// `BenchBox.armBenchOperation` for the deployed failure that made this the only
// shape available.

type BenchOperation = 'checkpoint' | 'stop';

/** One armed operation, its terminal state, and what it did. `state` is the
 *  whole protocol: `pending` means a schedule row owns it, and both settled
 *  states are final — nothing re-enters a settled row. */
interface BenchOperationRow {
  readonly token: string;
  /** The driver's own id for this operation, which is what makes arming
   *  idempotent under a re-posted request. */
  readonly op: string;
  readonly operation: BenchOperation;
  readonly kind: CheckpointKind;
  readonly state: 'pending' | 'done' | 'failed';
  readonly armedAt: number;
  /** When the scheduled callback picked it up, absent until then. */
  readonly startedAt?: number;
  /** How long the operation itself took, measured inside the callback rather
   *  than across the driver's polling, so a poll cadence cannot inflate a
   *  measured checkpoint. */
  readonly ms?: number;
  readonly outcome?: CheckpointOutcome;
  readonly error?: string;
}

const OPERATION_PREFIX = 'bench:operation:';
const OPERATION_ID_PREFIX = 'bench:operation-id:';

/** One second, matching the startup row: the delay exists so the request can
 *  return, not to defer the work. */
const OPERATION_DELAY_SECONDS = 1;

/** The two key spellings, in one place each: four call sites read or write
 *  these rows, and a key spelled twice is a row nobody can find. */
const operationKey = (token: string): string => `${OPERATION_PREFIX}${token}`;
const operationIdKey = (op: string): string => `${OPERATION_ID_PREFIX}${op}`;

/** What an armed schedule row carries to its callback: the token naming the
 *  outcome row to settle, and nothing else. */
const OperationPayloadSchema = v.object({ token: v.string() });
type BenchOperationPayload = v.InferOutput<typeof OperationPayloadSchema>;

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

  /**
   * Run the G4 security fault cells (F7 stale writer, F10 hostile metadata,
   * F11 capability escape/replay, F12 credential exposure) inside this box.
   *
   * Storage-only: no container exec, no mount, no checkpoint. The cells run
   * the production controls against an isolated per-call namespace
   * `<boxPrefix>security-cells/<nonce>/` with isolated durable keys, so the
   * live control record and live payload prefixes are never touched. The box
   * prefix is derived from this object's own id — the same id
   * `storePrefixOf` derives from the driver's box name — so the cells cannot
   * name another box's keys whatever nonce the driver supplies.
   *
   * The live fixture secret (BENCH_TOKEN) is read from this object's own env
   * for the F12 scan and never leaves in the answer: F12 reports surfaces,
   * never values. This env carries no account credential to copy.
   */
  async runSecurityCells(nonce: string): Promise<SecurityCellsObservation> {
    const strategy = this.strategy;
    const id = this.ctx.id.toString();
    const base = `boxes/${id}/`;
    const boxPrefix = strategy === 'bounded-layers' || strategy === 'merkle-pack'
      ? `${base}candidate/${strategy}/`
      : base;
    // The F12 scan surface: the declared string env beside the token, named
    // one by one so no representation check decides what counts. BENCH_TOKEN
    // itself is the scanned secret, never a scanned surface.
    const envValues: Array<{ readonly name: string; readonly value: string }> = [];
    for (const entry of [
      { name: 'ALLOW_EXTRACTION', value: this.env.ALLOW_EXTRACTION },
      { name: 'BENCH_SELECTED_ARMS', value: this.env.BENCH_SELECTED_ARMS },
    ]) {
      if (entry.value !== undefined && entry.value.length > 0) {
        envValues.push({ name: entry.name, value: entry.value });
      }
    }
    return await runBenchSecurityCells({
      strategy,
      boxPrefix,
      nonce,
      bucket: this.env.BACKUP_BUCKET,
      storage: this.ctx.storage,
      boxId: id,
      fixtureSecret: this.env.BENCH_TOKEN ?? '',
      envValues,
    });
  }

  /**
   * What the container itself shows about a candidate attachment, as RAW
   * evidence.
   *
   * Read through the same `exec` a workload uses, so nothing reported here can
   * see a mount the workload cannot. Nothing is judged: the whole of
   * `/proc/mounts` travels rather than a boolean about it, and the paths the
   * candidate storage actually uses travel beside it, so the driver compares
   * observation against contract instead of trusting a verdict this fixture
   * made about itself.
   */
  async candidateContainerFacts(): Promise<CandidateContainerFacts> {
    const mounts = await this.exec('cat /proc/mounts');
    const journalRoot = await this.exec(`test -d ${CANDIDATE_JOURNAL_ROOT} && echo yes || echo no`);
    const journalSocket = await this.exec(`test -S ${CANDIDATE_JOURNAL_SOCKET} && echo yes || echo no`);
    // Staged to a file first: interpolating the bytes into `bun -e` inside
    // shell double-quotes mangles real newlines into literal backslash-n
    // sequences that Bun's parser rejects.
    await this.writeFile(JOURNAL_READY_PROBE_PATH, JOURNAL_READY_PROBE);
    const journalProbe = await this.exec(journalReadyRunCommand(CANDIDATE_JOURNAL_SOCKET));
    // The daemon's own argv, found by scanning /proc rather than by asking a
    // process table tool the sandbox image may not carry. `grep -a` because a
    // cmdline is NUL-separated and grep would otherwise call it binary.
    const daemon = await this.exec(
      `for f in /proc/*/cmdline; do if tr '\\0' ' ' < "$f" 2>/dev/null `
      + `| grep -qa -- '${CANDIDATE_JOURNAL_BINARY}'; then tr '\\0' ' ' < "$f"; break; fi; done`,
    );
    return {
      expectedWorkdirMount: CANDIDATE_JOURNAL_MOUNT,
      expectedStoreMount: CANDIDATE_STORE_MOUNT,
      expectedJournalRoot: CANDIDATE_JOURNAL_ROOT,
      expectedJournalSocket: CANDIDATE_JOURNAL_SOCKET,
      expectedJournalBinary: CANDIDATE_JOURNAL_BINARY,
      mounts: mounts.stdout,
      journalRootPresent: journalRoot.stdout.trim() === 'yes',
      journalSocketPresent: journalSocket.stdout.trim() === 'yes',
      journalReady: journalProbe.exitCode === 0,
      journalReadyDetail: journalProbe.exitCode === 0
        ? journalProbe.stdout.trim()
        : journalProbe.stderr.trim() || journalProbe.stdout.trim() || `journal probe exited ${journalProbe.exitCode}`,
      journalDaemonCommand: daemon.stdout.trim(),
    };
  }

  /** Release the benchmark container without preserving state. The caller is
   * deleting that state and must free the class's only instance first. */
  async stopForTeardown(): Promise<void> {
    await this.stop('SIGTERM');
    while (this.ctx.container?.running === true) await scheduler.wait(100);
  }

  /**
   * Arm one durable one-shot for a minute-scale operation, and answer its token.
   *
   * WHY THE HTTP REQUEST MUST NOT BE THE OPERATION'S CLOCK. A candidate barrier
   * publishes a whole generation through the journal daemon and the store mount,
   * and the driver's own per-attempt deadline is 180 s. Both deployed decisive
   * runs (20260831031426 and 20260831143544) lost `bounded-layers` and
   * `merkle-pack` to that ceiling: the request timed out, the driver re-posted a
   * checkpoint the fixture was still running, the checkpoint lane serialised the
   * two, and the retry then ran a SECOND full publication against a box already
   * saturated — which is what produced the container 502s in the same artifacts.
   * Raising the deadline only moves the wall to the next tree size.
   *
   * So the request arms a schedule row — the same seam the startup and heartbeat
   * rows already use, durable across eviction and holding no request open — and
   * the outcome lands in this object's storage where a poll can read it.
   *
   * IDEMPOTENT BY THE CALLER'S OWN ID. `op` is the driver's name for ONE
   * semantic operation, so a re-post after transport loss resolves to the token
   * already armed instead of arming a second publication. That is the structural
   * half of the repair: arming is the only thing a post does, and a second arm
   * for the same `op` does not exist.
   */
  async armBenchOperation(request: {
    readonly op: string;
    readonly operation: BenchOperation;
    readonly kind: CheckpointKind;
  }): Promise<BenchOperationRow> {
    const armed = await this.ctx.storage.get<string>(operationIdKey(request.op));
    if (armed !== undefined) {
      const existing = await this.ctx.storage.get<BenchOperationRow>(operationKey(armed));
      if (existing !== undefined) return existing;
    }
    const token = `${request.operation}-${crypto.randomUUID()}`;
    const row: BenchOperationRow = {
      token,
      op: request.op,
      operation: request.operation,
      kind: request.kind,
      state: 'pending',
      armedAt: Date.now(),
    };
    await this.ctx.storage.put(operationKey(token), row);
    await this.ctx.storage.put(operationIdKey(request.op), token);
    await this.schedule(
      OPERATION_DELAY_SECONDS,
      request.operation === 'checkpoint' ? 'benchCheckpointOperation' : 'benchStopOperation',
      { token },
    );
    return row;
  }

  /** The outcome row a poll reads. Durable, so the answer survives the eviction
   *  a minute-scale operation makes likely rather than exotic. */
  async readBenchOperation(token: string): Promise<BenchOperationRow | undefined> {
    return await this.ctx.storage.get<BenchOperationRow>(operationKey(token));
  }

  /** Public because `Container.schedule` calls back by name. The payload is the
   *  one this class wrote when it armed the row; the alarm loop round-trips it
   *  through JSON, and `#runBenchOperation` re-parses it for that reason. */
  async benchCheckpointOperation(payload: BenchOperationPayload): Promise<void> {
    await this.#runBenchOperation(payload, async (row) => await this.checkpointNow(row.kind));
  }

  async benchStopOperation(payload: BenchOperationPayload): Promise<void> {
    await this.#runBenchOperation(payload, async () => await this.quiesce());
  }

  /**
   * Run one armed operation and persist what it did, whatever it does.
   *
   * A THROW IS AN OUTCOME HERE. The alarm loop reduces a thrown scheduled
   * callback to a console line, so a failure travelling as an exception would
   * leave the row `pending` forever and the driver polling to its deadline with
   * no reason to report. Both settled states are terminal, and the driver's own
   * retry — a NEW `op`, posted after it read a failure — is the only thing that
   * publishes again.
   *
   * ONE-SHOT AGAINST REDELIVERY: the alarm loop deletes a row only after its
   * callback returns, so an eviction mid-publication re-delivers it. A row that
   * has already settled is left alone; a row still `pending` is re-run, which is
   * the same at-least-once contract every other schedule row in this class has.
   */
  async #runBenchOperation(
    payload: BenchOperationPayload,
    run: (row: BenchOperationRow) => Promise<CheckpointOutcome>,
  ): Promise<void> {
    const parsed = v.safeParse(OperationPayloadSchema, payload);
    if (!parsed.success) {
      console.error('[bench] a scheduled operation carried no token and was dropped');
      return;
    }
    const key = operationKey(parsed.output.token);
    const row = await this.ctx.storage.get<BenchOperationRow>(key);
    if (row === undefined || row.state !== 'pending') return;
    const startedAt = Date.now();
    await this.ctx.storage.put(key, { ...row, startedAt });
    try {
      const outcome = await run(row);
      await this.ctx.storage.put(key, {
        ...row, startedAt, state: 'done', ms: Date.now() - startedAt, outcome,
      });
    } catch (error) {
      await this.ctx.storage.put(key, {
        ...row,
        startedAt,
        state: 'failed',
        ms: Date.now() - startedAt,
        error: describeThrown({ cause: error }),
      });
    }
  }

  /**
   * Stop the container WITHOUT a final checkpoint, the way a platform
   * replacement does.
   *
   * The witness instrument for a recovery replay, and the only way to reach it
   * from outside: `quiesce` folds the journal, so after an ordinary stop nothing
   * is pending for an attach to replay and the recovery path this box's restore
   * claim is about never runs. A container the platform replaced left exactly
   * this state — staged journal entries, no fold, no boot marker — and the next
   * commit heals it, which is what makes the replay observable.
   */
  async killWithoutQuiesce(): Promise<void> {
    await this.stop('SIGKILL');
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
      // The DRIVER re-asks, so a held request buys nothing here: it polls
      // `/state` on its own cadence and the arm's numbers are the fixture's own
      // timestamps. Long enough that an ordinary cold attach still answers in
      // one request, bounded so a slow one cannot hold an edge connection.
      requestJoinMs: 5_000,
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

/** The candidate arms, and the root-envelope format each one publishes. A
 *  non-candidate strategy has no entry, which is how the candidate route
 *  refuses to serve chain or overlay facts as if they were candidate facts. */
const CANDIDATE_ENVELOPE_FORMAT = {
  'bounded-layers': BOUNDED_LAYERS_FORMAT,
  'merkle-pack': MERKLE_PACK_FORMAT,
} as const satisfies Partial<Record<DevboxStrategyName, string>>;

type CandidateStrategy = keyof typeof CANDIDATE_ENVELOPE_FORMAT;

/**
 * The box prefix `candidateStorePaths` is rooted at, recovered from the arm's
 * own payload prefix.
 *
 * The durable-object id is derived in ONE place — `storePrefixOf` — and this
 * removes the suffix that function appends. A second `idFromName` call here
 * would be a second derivation of the same id, free to drift from the one the
 * mount actually uses and to address another box's envelopes.
 */
function candidateBoxPrefix(env: BenchEnv, strategy: CandidateStrategy, name: string): string {
  const payloadPrefix = storePrefixOf(env, strategy, name).replace(/\/$/, '');
  const suffix = `/candidate/${strategy}`;
  if (!payloadPrefix.endsWith(suffix)) {
    throw new Error(`candidate payload prefix "${payloadPrefix}" does not end with "${suffix}"`);
  }
  return payloadPrefix.slice(0, -suffix.length);
}

// ── candidate control facts ─────────────────────────────────────────────────
//
// The DRIVER judges a candidate arm's lifecycle. This fixture only reports
// facts, because a fixture that returned a verdict would be the thing under
// test grading itself.
//
// Three of those facts exist only in the object store, and no container command
// can reach them: which root envelopes this arm published, whether each is the
// immutable object its own key digest claims it is, and whether the payload
// closure the head envelope names is completely present at the declared byte
// lengths. The envelope prefix is deliberately OUTSIDE the payload subtree a
// container replacement owns, so an envelope key that fell inside the mount
// would be a defect rather than a detail.

/** The object rows a closure proof reads. Narrower than `R2Bucket` on purpose:
 *  the proof is then provable against a store that cannot lie about paging. */
export interface CandidateObjectReader {
  list(options: { prefix: string; cursor?: string }): Promise<{
    objects: readonly { readonly key: string; readonly size: number }[];
    truncated: boolean;
    cursor?: string;
  }>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  head(key: string): Promise<{ readonly size: number } | null>;
}

/** One object the head envelope names, and what the store actually holds for
 *  it. `storedBytes` is null when the key is absent — never 0, which is a real
 *  length an empty object could have. */
export interface CandidateClosureRow {
  readonly key: string;
  /** The canonical decimal byte length the envelope declares. */
  readonly declaredBytes: string;
  readonly storedBytes: number | null;
}

export interface CandidateEnvelopeRow {
  readonly key: string;
  readonly rootEnvelopeId: string;
  /** sha256 of the stored bytes. The key names a digest, so a value that
   *  disagrees means the envelope is not the immutable object its address
   *  claims and nothing may be restored from it. */
  readonly sha256: string;
  readonly format: string;
  readonly boxId: string;
  readonly generation: string;
  readonly cut: string;
  readonly closureCount: number;
}

export interface CandidateStoreFacts {
  readonly payloadPrefix: string;
  readonly envelopePrefix: string;
  /** The durable-object id this arm's envelopes must be stamped with. */
  readonly expectedBoxId: string;
  /** The root-envelope format this arm must publish. */
  readonly expectedFormat: string;
  readonly envelopes: readonly CandidateEnvelopeRow[];
  /** The single greatest-generation envelope, or null when there is none or
   *  more than one shares that generation. */
  readonly head: CandidateEnvelopeRow | null;
  /** Envelope keys sharing the greatest generation when more than one does. A
   *  forked head has no single authority to restore from. */
  readonly forkedHeads: readonly string[];
  /** Every object the head envelope names: its root, its closure manifest, and
   *  the closure itself. Empty when there is no single head. */
  readonly closure: readonly CandidateClosureRow[];
  /** Keys listed under the envelope prefix that could not be read as a root
   *  envelope, with the reason each one failed. */
  readonly unreadable: readonly string[];
}

async function listAllObjects(
  reader: CandidateObjectReader,
  prefix: string,
): Promise<readonly { readonly key: string; readonly size: number }[]> {
  const rows: { readonly key: string; readonly size: number }[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await reader.list(cursor === undefined ? { prefix } : { prefix, cursor });
    rows.push(...page.objects);
    if (!page.truncated) return rows;
    // A truncated page carrying no cursor cannot be continued. Returning its
    // partial rows would let a newer envelope or a fork hide on the next page,
    // so a missing cursor is a hard fact-collection failure, never a short
    // listing the driver might mistake for a complete control envelope set.
    if (page.cursor === undefined) {
      throw new Error(`candidate object listing for ${prefix} was truncated without a cursor`);
    }
    cursor = page.cursor;
  }
}

type EnvelopeDecode =
  | { readonly ok: true; readonly envelope: RootEnvelopeV1 }
  | { readonly ok: false; readonly reason: string };

const envelopeDecoder = new TextDecoder('utf-8', { fatal: true });

/** Decode one stored envelope. Every failure is a REASON rather than a throw:
 *  one unreadable envelope must not hide the arm's other envelopes. */
function decodeEnvelope(bytes: Uint8Array): EnvelopeDecode {
  let text: string;
  try {
    text = envelopeDecoder.decode(bytes);
  } catch (cause) {
    return { ok: false, reason: `is not UTF-8: ${describeThrown({ cause })}` };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (cause) {
    return { ok: false, reason: `is not JSON: ${describeThrown({ cause })}` };
  }
  const parsed = v.safeParse(RootEnvelopeV1Schema, decoded);
  return parsed.success
    ? { ok: true, envelope: parsed.output }
    : { ok: false, reason: `is not a root envelope: ${parsed.issues[0]?.message ?? 'unknown shape'}` };
}

/**
 * Read this arm's control envelopes and resolve the head's payload closure.
 *
 * Exported so the closure proof is provable against a stub store: the live
 * route only supplies the bucket and the arm's own prefixes.
 */
export async function candidateStoreFacts(
  reader: CandidateObjectReader,
  strategy: CandidateStrategy,
  boxPrefix: string,
): Promise<CandidateStoreFacts> {
  const paths = candidateStorePaths(boxPrefix, strategy);
  const envelopePrefix = `${paths.envelopePrefix}/`;
  const listed = await listAllObjects(reader, envelopePrefix);
  const decoded: { readonly row: CandidateEnvelopeRow; readonly envelope: RootEnvelopeV1 }[] = [];
  const unreadable: string[] = [];
  for (const listedRow of listed) {
    const object = await reader.get(listedRow.key);
    if (object === null) {
      unreadable.push(`${listedRow.key} was listed but holds no bytes`);
      continue;
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    const result = decodeEnvelope(bytes);
    if (!result.ok) {
      unreadable.push(`${listedRow.key} ${result.reason}`);
      continue;
    }
    decoded.push({
      row: {
        key: listedRow.key,
        // The key IS the claimed digest; the extension is its only decoration.
        rootEnvelopeId: listedRow.key.slice(envelopePrefix.length).replace(/\.json$/, ''),
        sha256: sha256Hex(bytes),
        format: result.envelope.format,
        boxId: result.envelope.boxId,
        generation: result.envelope.generation,
        cut: result.envelope.cut.cut,
        closureCount: result.envelope.closure.length,
      },
      envelope: result.envelope,
    });
  }

  // THE HEAD IS THE GREATEST GENERATION, and only when exactly one envelope
  // holds it. Two envelopes at one generation is a fork: a restore would pick
  // one arbitrarily, so the fact says there is no head rather than choosing.
  const greatest = decoded.reduce<bigint | null>((best, entry) => {
    const generation = BigInt(entry.row.generation);
    return best === null || generation > best ? generation : best;
  }, null);
  const newest = greatest === null
    ? []
    : decoded.filter((entry) => BigInt(entry.row.generation) === greatest);
  const headEntry = newest.length === 1 ? newest[0] : undefined;

  const closure: CandidateClosureRow[] = [];
  if (headEntry !== undefined) {
    const seen = new Set<string>();
    for (const ref of [
      headEntry.envelope.rootObject,
      headEntry.envelope.closureObject,
      ...headEntry.envelope.closure,
    ]) {
      if (seen.has(ref.key)) continue;
      seen.add(ref.key);
      const stored = await reader.head(ref.key);
      closure.push({
        key: ref.key,
        declaredBytes: ref.byteLength,
        storedBytes: stored === null ? null : stored.size,
      });
    }
  }

  return {
    payloadPrefix: `${paths.payloadPrefix}/`,
    envelopePrefix,
    expectedBoxId: boxPrefix.replace(/^boxes\//, ''),
    expectedFormat: CANDIDATE_ENVELOPE_FORMAT[strategy],
    envelopes: decoded.map((entry) => entry.row),
    head: headEntry?.row ?? null,
    forkedHeads: newest.length > 1 ? newest.map((entry) => entry.row.key) : [],
    closure,
    unreadable,
  };
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
  /** The driver's own id for one semantic operation, which is what makes
   *  arming a checkpoint or a stop idempotent under a re-posted request. */
  op: v.optional(v.string()),
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



/**
 * The routes that reach storage and never the box's live tree, served ahead
 * of the operation router: the deployed probe's two diagnostic reads (the
 * candidate control dump and the incident ledger, archived after the ladder
 * and after the wake) and the G4 fault cells, which run against an isolated
 * per-call namespace. The switch below stays the router for the operations
 * that arm, write, or tear down. Null answers any other route.
 */
async function serveStorageOnlyRoutes(
  route: string,
  input: DriverBody,
  env: BenchEnv,
  strategy: DevboxStrategyName,
  box: BenchStub,
  name: string,
  started: number,
): Promise<Response | null> {
  if (route === 'GET /incidents') {
    // Every filed failure, oldest first. Totals say how many; only the
    // reasons say what. Called after the ladder and after the wake but
    // before teardown, with full arrays archived.
    const incidents = await box.devboxIncidentReasons();
    return json({ ok: true, strategy, box: name, incidents, ms: Date.now() - started });
  }
  if (route === 'POST /security') {
    // G4 FAULT CELLS, storage-only. `op` doubles as the isolated namespace
    // nonce: one call, one `security-cells/<op>/` prefix and one set of
    // `__security:*:<op>` durable keys, so a re-post with the same op reuses
    // the namespace and a new op cannot collide with it. No new body field:
    // DriverBodySchema stays closed.
    const nonce = input.op ?? '';
    if (nonce.length === 0) return json({ ok: false, error: 'op is required' }, 400);
    if (!/^[A-Za-z0-9-]{8,64}$/.test(nonce)) {
      return json({ ok: false, error: 'op must be an 8-64 char id for the isolated namespace' }, 400);
    }
    const security = await box.runSecurityCells(nonce);
    return json({ ok: true, strategy, box: name, security, ms: Date.now() - started });
  }
  if (route !== 'GET /candidate') return null;
  // FACTS ONLY, and only for an arm that has candidate control state.
  // A chain or overlay arm is refused here rather than served the
  // nearest-looking rows, because a driver that accepted those would be
  // proving a candidate lifecycle against another strategy's evidence.
  if (strategy !== 'bounded-layers' && strategy !== 'merkle-pack') {
    return json({
      ok: false,
      strategy,
      box: name,
      error: `${strategy} publishes no candidate control envelope`,
    }, 400);
  }
  const store = await candidateStoreFacts(
    env.BACKUP_BUCKET,
    strategy,
    candidateBoxPrefix(env, strategy, name),
  );
  const container = await box.candidateContainerFacts();
  // The raw control fact travels verbatim so a dump taken at publish
  // and one taken at wake compare byte for byte.
  const control = await box.candidateControlState();
  return json({ ok: true, strategy, box: name, store, container, control, ms: Date.now() - started });
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
      const route = `${request.method} ${url.pathname}`;
      const aside = await serveStorageOnlyRoutes(route, input, env, strategy, box, name, started);
      if (aside !== null) return aside;
      switch (route) {
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
            // THE STORE'S OWN NAME FOR THESE BYTES. A witness cell asks whether
            // one KEY holds different bytes than it did before, and a size
            // cannot answer that: two archives of the same length are the same
            // size and different objects. The etag changes when the object is
            // replaced, which is exactly the fact `mutable-delta` turns on.
            etag: object?.etag ?? '',
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

        // BOTH MINUTE-SCALE ROUTES ARM AND ANSWER 202. The operation runs from a
        // durable schedule row and its outcome is read back by token through
        // `GET /operation`. `armBenchOperation` records the deployed runs this
        // repairs and why the request could not stay the operation's clock.
        case 'POST /checkpoint': {
          const op = input.op ?? '';
          if (op.length === 0) return json({ ok: false, error: 'op is required' }, 400);
          const kind: CheckpointKind = input.kind === 'tick' ? 'tick' : 'quiesce';
          const row = await box.armBenchOperation({ op, operation: 'checkpoint', kind });
          return json({
            ok: true, token: row.token, kind, state: row.state, ms: Date.now() - started,
          }, 202);
        }

        case 'POST /stop': {
          // The real quiesce path — final checkpoint, keepAlive off, SIGTERM —
          // armed rather than awaited: a final checkpoint over a large tree is
          // exactly the work that outlived the request deadline.
          const op = input.op ?? '';
          if (op.length === 0) return json({ ok: false, error: 'op is required' }, 400);
          const row = await box.armBenchOperation({ op, operation: 'stop', kind: 'quiesce' });
          return json({
            ok: true, token: row.token, state: row.state, ms: Date.now() - started,
          }, 202);
        }

        case 'GET /operation': {
          const token = url.searchParams.get('token') ?? '';
          if (token.length === 0) return json({ ok: false, error: 'token is required' }, 400);
          const row = await box.readBenchOperation(token);
          // AN UNKNOWN TOKEN IS DEFINITIVE, not a slow answer: the row is
          // written before the request that armed it returns, so a token this
          // box never armed names an operation nobody is running and the poll
          // must stop rather than wait out its deadline.
          if (row === undefined) {
            return json({ ok: false, token, error: 'no operation is armed under this token' }, 404);
          }
          return json({
            ok: row.state !== 'failed',
            token,
            state: row.state,
            kind: row.kind,
            outcome: row.outcome,
            error: row.error,
            // The operation's OWN duration, measured inside the callback, so the
            // driver's poll cadence never enters a measured number.
            ms: row.ms,
          });
        }

        case 'POST /kill': {
          // A container stop with NO final checkpoint: the witness instrument
          // for a recovery replay. See `killWithoutQuiesce`.
          await box.killWithoutQuiesce();
          return json({ ok: true, strategy, box: name, ms: Date.now() - started });
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
