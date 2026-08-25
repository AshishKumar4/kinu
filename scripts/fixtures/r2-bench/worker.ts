/**
 * BENCHMARK FIXTURE — not product surface and not deployed by `bun run deploy`.
 * `scripts/bench-r2-workspace.ts` publishes it as an EPHEMERAL deployment
 * (`wrangler deploy` against this directory's own config), drives its
 * workers.dev origin, and deletes the Worker, the container application and the
 * bucket in a `finally`.
 *
 * There is no remote-dev path and no number in the report comes from one:
 * `wrangler dev --remote` cannot host a Container or a SQLite Durable Object,
 * and a local `wrangler dev` has neither a real container nor a real R2. An
 * ephemeral deployment is the only execution model that measures the platform.
 *
 * It exists because the R2-vs-native workspace-layout question can only be
 * answered inside a real Cloudflare container, and no product Durable Object has
 * an HTTP route. A Worker that HOLDS the `Sandbox` binding needs no route: it
 * calls the Durable Object's public SDK methods on the stub. So this file adds
 * no `@callable` and changes no product RPC surface.
 *
 * It exports the UPSTREAM `Sandbox` class, deliberately NOT `KinuSandbox`.
 * KinuSandbox extends Devbox, which arms a 5-minute snapshot tick
 * (`DEFAULT_DEVBOX_POLICY.checkpointIntervalMs`,
 * packages/devbox/src/lifecycle.ts) whose archives are
 * written to `backups/…` at the BUCKET ROOT. Any run of this benchmark exceeds
 * five minutes and its native arm writes hundreds of megabytes, so the tick
 * would fire: a squashfs build plus a multipart upload landing inside a latency
 * measurement, at keys outside the run's own prefix. Measuring the storage layer
 * means measuring the storage layer. Kinu's lifecycle gets its own probe.
 *
 * Everything else is pinned to what the product runs: the same
 * `cloudflare/sandbox:0.12.8` image, the same instance type, the RPC transport,
 * and the same credential-less `mountBucket` API.
 *
 * Three things live here and nothing else:
 *
 *   1. Re-exports of `Sandbox` and of the SDK's `ContainerProxy`, both bound by
 *      the wrangler config beside this file. Outbound interception does not work
 *      without the ContainerProxy export, and the R2 mount IS outbound
 *      interception.
 *   2. A counting wrapper around the R2 binding, so "R2 ops" in the report is a
 *      measured count of R2 API calls rather than an estimate. See
 *      `countingBucket` for why the wrap sits where it does.
 *   3. A token-guarded JSON API the driver calls: shape, mount, unmount, exec,
 *      write, restart, ops, inventory, purge.
 */

import { ContainerProxy as SdkContainerProxy, Sandbox, getSandbox } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

export { Sandbox } from "@cloudflare/sandbox";

/**
 * The counter's keys. A closed union rather than `string` because a name that
 * reaches the counter but appears in none of the three class lists below would be
 * summed into `total` and billed at nothing, and the wrong op column is the
 * failure this fixture exists to prevent.
 */
type CountedOp =
  | 'head' | 'get' | 'put' | 'delete' | 'list'
  | 'createMultipartUpload' | 'resumeMultipartUpload'
  | 'multipart.uploadPart' | 'multipart.complete' | 'multipart.abort';

/**
 * Every R2 method the egress handler can reach, split the way R2 bills. The
 * `multipart.*` names come from the wrapped upload handle: `uploadPart` and
 * `complete` are each a class-A operation, and `abort` is too.
 */
const CLASS_A: readonly string[] = [
  'put', 'list', 'createMultipartUpload', 'resumeMultipartUpload',
  'multipart.uploadPart', 'multipart.complete',
];
const CLASS_B: readonly string[] = ['get', 'head'];
/**
 * Counted, billed at nothing, and reported anyway.
 *
 * A free operation still has to be VISIBLE when the decision turns on small-file
 * churn: the phases that decide this benchmark are create/stat/read/DELETE over
 * thousands of objects, and folding deletes into class A would overstate the bill
 * while hiding them entirely would understate the work. `total` sums all three
 * classes so the arithmetic stays right either way.
 */
const CLASS_FREE: readonly string[] = ['delete', 'multipart.abort'];

export interface OpTally {
  readonly calls: Readonly<Record<string, number>>;
  readonly classA: number;
  readonly classB: number;
  /** Deletes and multipart aborts: counted, billed at nothing, never hidden. */
  readonly classFree: number;
  readonly total: number;
}

interface BenchEnv {
  /** The ephemeral benchmark bucket. Bound under this name because that is the
   *  name the driver passes to `mountBucket`, and the egress handler resolves
   *  the bucket out of the Worker env by binding name. */
  BACKUP_BUCKET: R2Bucket;
  Sandbox: DurableObjectNamespace<Sandbox<BenchEnv>>;
  BenchOpCounter: DurableObjectNamespace<BenchOpCounter>;
  /** Shared secret the driver presents. Absent ⇒ every request is refused,
   *  rather than an open exec endpoint on the public edge. */
  BENCH_TOKEN?: string;
}

/**
 * The op counter. A Durable Object rather than module state because the
 * ContainerProxy that observes the calls and the fetch handler that reports them
 * are separate entrypoints with no guarantee of sharing an isolate. Counting in
 * module scope and reading it from the other entrypoint would produce a number
 * that is right when the platform happens to co-locate them and silently short
 * when it does not, which is worse than no number at all.
 */
export class BenchOpCounter extends DurableObject {
  #calls = new Map<string, number>();

  async add(deltas: Record<string, number>): Promise<void> {
    for (const [method, count] of Object.entries(deltas)) {
      this.#calls.set(method, (this.#calls.get(method) ?? 0) + count);
    }
  }

  async read(): Promise<OpTally> {
    const calls: Record<string, number> = {};
    let classA = 0;
    let classB = 0;
    let classFree = 0;
    let total = 0;
    for (const [method, count] of this.#calls) {
      calls[method] = count;
      total += count;
      if (CLASS_A.includes(method)) classA += count;
      if (CLASS_B.includes(method)) classB += count;
      if (CLASS_FREE.includes(method)) classFree += count;
    }
    return { calls, classA, classB, classFree, total };
  }

  async reset(): Promise<OpTally> {
    const tally = await this.read();
    this.#calls.clear();
    return tally;
  }
}

/** Records one billed R2 call, keyed the way the class lists above are keyed. */
type CountOp = (op: CountedOp) => void;

/**
 * The multipart upload handle, counted.
 *
 * A multipart upload's parts are billed operations, and they are NOT calls on
 * the bucket — `createMultipartUpload` returns an object and the parts go to
 * IT. The first live run made that visible: a seq phase that wrote 111 MiB
 * reported classA=2, because twenty `uploadPart` calls and one `complete` had
 * gone to the returned handle where nothing was watching. Wrapping the handle is
 * what makes the class-A count the real one.
 *
 * `implements R2MultipartUpload` is what keeps it wrapped: a method the egress
 * handler reaches and this class forgot is a compile error rather than a
 * silently uncounted call.
 */
class CountingMultipartUpload implements R2MultipartUpload {
  readonly key: string;
  readonly uploadId: string;
  readonly #upload: R2MultipartUpload;
  readonly #count: CountOp;

  constructor(upload: R2MultipartUpload, count: CountOp) {
    this.#upload = upload;
    this.#count = count;
    this.key = upload.key;
    this.uploadId = upload.uploadId;
  }

  uploadPart(...args: Parameters<R2MultipartUpload['uploadPart']>): Promise<R2UploadedPart> {
    this.#count('multipart.uploadPart');
    return this.#upload.uploadPart(...args);
  }

  complete(...args: Parameters<R2MultipartUpload['complete']>): Promise<R2Object> {
    this.#count('multipart.complete');
    return this.#upload.complete(...args);
  }

  abort(): Promise<void> {
    this.#count('multipart.abort');
    return this.#upload.abort();
  }
}

/**
 * The R2 binding, counted.
 *
 * Every member forwards through the SDK's own signature (`R2Bucket['put']` and
 * its siblings), so the wrapper cannot drift from the binding it stands in for,
 * and `implements R2Bucket` makes a forgotten member a compile error. The two
 * multipart entry points return a wrapped HANDLE instead of the bucket's own,
 * because that handle is where `uploadPart` and `complete` are billed.
 */
class CountingBucket implements R2Bucket {
  readonly #bucket: R2Bucket;
  readonly #count: CountOp;

  constructor(bucket: R2Bucket, count: CountOp) {
    this.#bucket = bucket;
    this.#count = count;
  }

  readonly head: R2Bucket['head'] = (key) => {
    this.#count('head');
    return this.#bucket.head(key);
  };

  readonly get: R2Bucket['get'] = (key, options) => {
    this.#count('get');
    return this.#bucket.get(key, options);
  };

  readonly put: R2Bucket['put'] = (key, value, options) => {
    this.#count('put');
    return this.#bucket.put(key, value, options);
  };

  readonly delete: R2Bucket['delete'] = (keys) => {
    this.#count('delete');
    return this.#bucket.delete(keys);
  };

  readonly list: R2Bucket['list'] = (options) => {
    this.#count('list');
    return this.#bucket.list(options);
  };

  readonly createMultipartUpload: R2Bucket['createMultipartUpload'] = async (key, options) => {
    this.#count('createMultipartUpload');
    const upload = await this.#bucket.createMultipartUpload(key, options);
    return new CountingMultipartUpload(upload, this.#count);
  };

  // Synchronous, like the binding it stands in for: the egress handler writes
  // `r2.resumeMultipartUpload(key, uploadId).complete(parts)`, so a promise here
  // would leave `.complete` undefined on every part of every multipart upload.
  readonly resumeMultipartUpload: R2Bucket['resumeMultipartUpload'] = (key, uploadId) => {
    this.#count('resumeMultipartUpload');
    return new CountingMultipartUpload(this.#bucket.resumeMultipartUpload(key, uploadId), this.#count);
  };
}

/**
 * Wrap an R2 binding so every call is tallied, then flushed to the counter DO.
 *
 * The flush runs in `waitUntil`, after the response the container is waiting on
 * has been returned, so it never appears in a measured latency. It is coalesced
 * to at most one in-flight flush: an s3fs phase issues thousands of requests, and
 * one DO call per request would make the counter the bottleneck and perturb the
 * thing it counts.
 */
function countingBucket(
  bucket: R2Bucket,
  counter: { add(deltas: Record<string, number>): Promise<void> },
  ctx: ExecutionContext,
): R2Bucket {
  const pending = new Map<string, number>();
  let inFlight: Promise<void> | null = null;

  const drain = async (): Promise<void> => {
    while (pending.size > 0) {
      const batch = Object.fromEntries(pending);
      pending.clear();
      await counter.add(batch);
    }
    inFlight = null;
  };

  return new CountingBucket(bucket, (op) => {
    pending.set(op, (pending.get(op) ?? 0) + 1);
    if (inFlight === null) {
      inFlight = drain();
      ctx.waitUntil(inFlight);
    }
  });
}

/**
 * The SDK's ContainerProxy with the R2 binding replaced by a counting wrapper.
 *
 * The wrap happens in the constructor because the SDK's subclass reads
 * `this.env` when it dispatches an intercepted `r2.internal` request
 * (`r2EgressHandler(request, this.env, ctx)`) and resolves the bucket out of it
 * by binding name. Handing the base a wrapped env is therefore the only seam
 * that sees every R2 call the mount makes, without patching the SDK and without
 * re-implementing its dispatch.
 *
 * The wrap is unconditional. `WorkerEntrypoint` declares `ctx` as an
 * `ExecutionContext`, so `waitUntil` is there by contract, and falling back to
 * the bare binding would report zero ops for a phase that ran — which is worse
 * than failing.
 *
 * Exported as `ContainerProxy` because that is the export the wrangler config
 * binds. `name` is pinned too, so a class-name comparison anywhere upstream
 * still matches.
 */
class BenchContainerProxy extends SdkContainerProxy {
  constructor(ctx: ExecutionContext, env: BenchEnv) {
    const counter = env.BenchOpCounter.get(env.BenchOpCounter.idFromName('bench-ops'));
    const wrapped: BenchEnv = {
      ...env,
      BACKUP_BUCKET: countingBucket(env.BACKUP_BUCKET, counter, ctx),
    };
    super(ctx, wrapped);
  }
}
Object.defineProperty(BenchContainerProxy, 'name', { value: 'ContainerProxy' });
export { BenchContainerProxy as ContainerProxy };

// ── the driver-facing API ───────────────────────────────────────────────────

/**
 * What the driver sends. Named per route because the driver builds these literals
 * against its own copies of the same names, and a field that arrives absent would
 * mount at the bucket root or purge outside the run's prefix.
 */
interface MountBody {
  mountPath: string;
  prefix: string;
  readOnly?: boolean;
  s3fsOptions?: string[];
}
interface UnmountBody { mountPath: string }
interface ExecBody { command: string; cwd?: string; timeoutMs?: number }
interface SpawnBody { command: string; cwd?: string }
interface WriteBody { path: string; content: string }
interface PurgeBody { prefix: string; whole?: boolean }

/**
 * What the driver reads back, one member per route. A field name the driver does
 * not know is a compile error here rather than an `undefined` in a report column.
 */
type BenchReply =
  | { error: string; stack?: string }
  | { ok: boolean; stdout: string; stderr: string; exitCode: number }
  | { ok: boolean; mountMs: number; mountpoint: string; preUnmountError: string }
  | { ok: boolean; unmountMs: number; reason: string }
  | { ok: boolean; exitCode: number; stdout: string; stderr: string; wallMs: number }
  | { ok: boolean; restartMs: number; stopError: string }
  | { ok: true; processId: string; ms: number }
  | { ok: true; path: string; bytes: number }
  | { ok: true; tally: OpTally }
  | { ok: true; prefix: string; objects: number; bytes: number }
  | { ok: true; prefix: string; deleted: number; passes: number };

const json = (body: BenchReply, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Constant-time bearer comparison; an absent expected token refuses everything.
 * This Worker execs arbitrary commands in a container, so a timing-variable
 * check or a default-open posture on the public edge would be indefensible even
 * for a fixture.
 */
function authorized(request: Request, expected: string | undefined): boolean {
  if (expected === undefined || expected.length === 0) return false;
  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** Delete every object under a prefix, paging until the bucket reports none. */
async function purgePrefix(bucket: R2Bucket, prefix: string): Promise<{ deleted: number; passes: number }> {
  let deleted = 0;
  let passes = 0;
  for (;;) {
    const listed = await bucket.list({ prefix, limit: 1000 });
    passes++;
    if (listed.objects.length === 0) return { deleted, passes };
    await bucket.delete(listed.objects.map((object) => object.key));
    deleted += listed.objects.length;
  }
}

async function inventory(bucket: R2Bucket, prefix: string): Promise<{ objects: number; bytes: number }> {
  let objects = 0;
  let bytes = 0;
  let cursor: string | undefined;
  for (;;) {
    const listed = await bucket.list(
      cursor === undefined ? { prefix, limit: 1000 } : { prefix, limit: 1000, cursor },
    );
    for (const object of listed.objects) {
      objects++;
      bytes += object.size;
    }
    if (!listed.truncated) return { objects, bytes };
    cursor = listed.cursor;
  }
}

export default {
  async fetch(request: Request, env: BenchEnv): Promise<Response> {
    if (!authorized(request, env.BENCH_TOKEN)) return json({ error: 'unauthorized' }, 401);

    const url = new URL(request.url);
    const sandbox = getSandbox(env.Sandbox, url.searchParams.get('sandbox') ?? 'r2-bench');
    const counter = env.BenchOpCounter.get(env.BenchOpCounter.idFromName('bench-ops'));

    try {
      switch (`${request.method} ${url.pathname}`) {
        case 'GET /shape': {
          // The transport is deliberately NOT set here. `setTransport` is a
          // configuration change the SDK applies by cycling the container, and
          // calling it immediately before the first exec produced
          // `OperationInterruptedError: The sandbox container stopped while the
          // operation was pending` on the very first live run. The measurement
          // wants the SDK's own default at 0.12.8, which is what the product
          // gets too, so the honest thing is to inherit it and record that the
          // run did not override it.
          const probe = await sandbox.exec(
            'uname -srm; nproc; grep MemTotal /proc/meminfo; df -PT / /workspace 2>&1; '
            + 's3fs --version 2>&1 | head -1; bun --version; git --version; '
            + 'tar --version | head -1; fuse-overlayfs --version 2>&1 | head -1; '
            + 'echo "SANDBOX_VERSION=${SANDBOX_VERSION:-unset}"',
          );
          return json({ ok: true, stdout: probe.stdout, stderr: probe.stderr, exitCode: probe.exitCode });
        }

        case 'POST /mount': {
          const body = await request.json<MountBody>();
          // Pre-unmount unconditionally. mountBucketR2Egress REFUSES a second
          // mount of the same binding at a different prefix or readOnly value
          // (dist/sandbox-CPj2jsbz.js:8058-8061), and this benchmark
          // deliberately remounts the same binding with a different option set
          // for every arm — so this is on the critical path, not defensive.
          // Nothing is mounted before the first arm, so a refusal is expected
          // here; it is reported so that a refusal which is NOT that is visible.
          let preUnmountError = '';
          try {
            await sandbox.unmountBucket(body.mountPath);
          } catch (error) {
            preUnmountError = error instanceof Error ? error.message : String(error);
          }
          const started = Date.now();
          await sandbox.mountBucket('BACKUP_BUCKET', body.mountPath, {
            prefix: body.prefix,
            readOnly: body.readOnly ?? false,
            // An empty list and an absent one are the same input: the SDK's
            // `resolveS3fsOptions` returns the provider defaults for both, so the
            // driver's `[]` stays the "SDK defaults only" arm.
            s3fsOptions: body.s3fsOptions,
          });
          const mountMs = Date.now() - started;
          // The SDK asserts `mountpoint -q` internally; asserting again turns
          // "the call returned" into "the mount is present", which are
          // different claims after a remount.
          const check = await sandbox.exec(`mountpoint -q ${body.mountPath} && echo MOUNTED || echo ABSENT`);
          return json({
            ok: check.stdout.trim() === 'MOUNTED',
            mountMs,
            mountpoint: check.stdout.trim(),
            preUnmountError,
          });
        }

        case 'POST /unmount': {
          const body = await request.json<UnmountBody>();
          const started = Date.now();
          try {
            await sandbox.unmountBucket(body.mountPath);
            return json({ ok: true, unmountMs: Date.now() - started, reason: '' });
          } catch (error) {
            return json({
              ok: false,
              unmountMs: Date.now() - started,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }

        case 'POST /exec': {
          const body = await request.json<ExecBody>();
          const started = Date.now();
          const result = await sandbox.exec(body.command, { cwd: body.cwd, timeout: body.timeoutMs });
          return json({
            ok: result.exitCode === 0,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            wallMs: Date.now() - started,
          });
        }

        case 'POST /spawn': {
          // A DETACHED process, deliberately. A blocking exec is bounded by a
          // fixed platform ceiling that no timeout option raises, which makes it
          // the wrong instrument for a minute-scale workload — and a real
          // workspace workload runs as a process anyway. The driver polls for the
          // probe's sentinel with tiny execs instead of holding one request open.
          const body = await request.json<SpawnBody>();
          const started = await sandbox.startProcess(body.command, { cwd: body.cwd });
          return json({ ok: true, processId: started.id, ms: 0 });
        }

        case 'POST /write': {
          const body = await request.json<WriteBody>();
          await sandbox.writeFile(body.path, body.content);
          return json({ ok: true, path: body.path, bytes: body.content.length });
        }

        case 'POST /restart': {
          // Restart durability: stop the container, then drive one operation so
          // the next start has completed before the driver verifies anything.
          const stopped = Date.now();
          let stopError = '';
          try {
            await sandbox.stop();
          } catch (error) {
            stopError = error instanceof Error ? error.message : String(error);
          }
          const probe = await sandbox.exec('echo restarted');
          return json({
            ok: probe.stdout.trim() === 'restarted',
            restartMs: Date.now() - stopped,
            stopError,
          });
        }

        case 'GET /ops': {
          // Settle first: flushes are scheduled in waitUntil on the intercepted
          // requests, so a read taken the instant a phase ends can miss the last
          // batch. The delay sits outside every measured window.
          await scheduler.wait(750);
          return json({ ok: true, tally: await counter.read() });
        }

        case 'POST /ops/reset': {
          await scheduler.wait(750);
          return json({ ok: true, tally: await counter.reset() });
        }

        case 'GET /inventory': {
          const prefix = url.searchParams.get('prefix') ?? '';
          return json({ ok: true, prefix, ...(await inventory(env.BACKUP_BUCKET, prefix)) });
        }

        case 'POST /purge': {
          const body = await request.json<PurgeBody>();
          // An empty prefix means the whole bucket, which is only ever correct
          // when the caller created the bucket for this run. Requiring the
          // intent to be stated keeps a typo'd prefix from becoming a
          // whole-bucket delete.
          if (body.prefix.length === 0 && body.whole !== true) {
            return json({ error: 'refusing to purge an empty prefix without whole:true' }, 400);
          }
          return json({ ok: true, prefix: body.prefix, ...(await purgePrefix(env.BACKUP_BUCKET, body.prefix)) });
        }

        default:
          return json({ error: `no route for ${request.method} ${url.pathname}` }, 404);
      }
    } catch (error) {
      // The driver needs the reason, not a 500: a refusal from the mount path is
      // a RESULT — which s3fs option set the platform rejects — and losing its
      // text would turn a finding into an outage.
      return json({
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        stack: error instanceof Error ? (error.stack ?? '').split('\n').slice(0, 6).join('\n') : '',
      });
    }
  },
} satisfies ExportedHandler<BenchEnv>;
