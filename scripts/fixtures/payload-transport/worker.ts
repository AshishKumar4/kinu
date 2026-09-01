/**
 * EPHEMERAL PAYLOAD-TRANSPORT FIXTURE WORKER.
 *
 * Not product surface and not deployed by `bun run deploy`. The benchmark
 * driver (`scripts/bench-payload-transports.ts`) raises this Worker, a real
 * @cloudflare/sandbox container under it, and an ephemeral R2 bucket.
 *
 * OWNERSHIP: exactly ONE Sandbox subclass owns the container AND the base64
 * arm, matching product Devbox ownership — one DO/container lifecycle, no
 * second DO hop. DO and container lifecycles are otherwise independent: the
 * container daemon outlives DO resets, so every operation here is keyed by a
 * deterministic operationId and is start-or-read, never assumed local.
 *
 *   do-base64            the owning DO pulls the file out of the container as
 *                        base64 SSE frames and streams the decoded bytes into
 *                        the binding, through the PRODUCT'S OWN `putStream` —
 *                        the current devbox snapshot-chain path; GET streams
 *                        back via `writeFile()`
 *   loopback-entrypoint   the container fetches `http://r2.internal/<bucket>/<key>`
 *                        through SDK outbound interception into the exported
 *                        ContainerProxy WorkerEntrypoint (mountBucket plane)
 *   presigned-r2         this DO mints a SigV4 presigned URL; the container
 *                        PUTs/GETs directly against R2
 *   temp-s3-creds        this DO mints short-lived scoped temporary S3
 *                        credentials (local HS256 JWT per the R2 temporary-
 *                        credentials docs); an IN-CONTAINER SigV4 client signs
 *                        real S3 requests with the session token
 *
 * THE DRIVER NEVER CARRIES PAYLOAD BYTES. Credential material NEVER appears in
 * a command line or process list: SigV4 credentials reach the harness through
 * ProcessOptions.env only.
 */

import { AwsClient } from 'aws4fetch';
import { SignJWT } from 'jose';
import { Sandbox, ContainerProxy, streamFile, type Process } from '@cloudflare/sandbox';
import * as v from 'valibot';
// THE PRODUCT'S UPLOAD, NOT A MODEL OF IT. `packages/devbox/src/object-store.ts`
// is what a snapshot-chain checkpoint calls, small-PUT/multipart routing and
// digest included, so this arm reports what devbox costs rather than what a
// re-implementation in this file would cost. Imported by path because the
// devbox package deliberately exports a narrow surface; the fixtures under
// scripts/ already reach into packages/devbox/src the same way.
import { putStream } from '../../../packages/devbox/src/object-store';
import { operationNeedsStart } from './decision';
import { HarnessResultSchema } from './wire';
import type { HarnessResult } from './wire';


// The harness ships as RAW TEXT inside this Worker's bundle (wrangler Text rule)
// so onStart can install it. The .bundle.txt twin is byte-identical to
// container-harness.ts by test — one source of truth, mechanically gated.
// `wrangler-text-modules.d.ts` types this import; see it for why not a suppression.
import HARNESS_TS from './container-harness.bundle.txt';

/** Quote a path for the shell commands that ask the container for bounded ranges. */
function shellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export { ContainerProxy };

export const EXPECTED_IMAGE_VERSION = '0.12.8';
const HARNESS_PATH = '/tmp/payload-bench/harness.ts';
const encoder = new TextEncoder();

interface JsonReply {
  readonly ok?: boolean;
  readonly error?: string;
  readonly available?: boolean;
  readonly reason?: string;
  readonly started?: boolean;
  readonly exitCode?: number | null;
  readonly results?: readonly HarnessResult[];
  readonly imageVersion?: string;
  /** The settle gate's answer. Nullable rather than absent: "this Durable
   *  Object cannot say" and "this route was not reached" must not look alike
   *  to a driver that censors the run on the first. */
  readonly version?: string | null;
  readonly sha256?: string;
  readonly size?: number;
  readonly ms?: number;
  readonly fingerprint?: string;
  readonly opaque?: string;
  readonly endpoint?: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly sessionToken?: string;
  readonly objects?: number;
  readonly bytes?: number;
  readonly deleted?: number;
  readonly passes?: number;
}

const RequestBodySchema = v.record(
  v.string(),
  v.union([v.string(), v.number(), v.boolean()]),
);
type RequestBody = v.InferOutput<typeof RequestBodySchema>;
const SeedOperationSpecSchema = v.looseObject({
  files: v.string(),
  seed: v.number(),
});

const TransferOperationSpecSchema = v.looseObject({
  mode: v.picklist(['loopback', 'direct', 'sigv4']),
  op: v.picklist(['put', 'get']),
  file: v.string(),
  url: v.optional(v.string()),
  endpoint: v.optional(v.string()),
  key: v.optional(v.string()),
  accessKeyId: v.optional(v.string()),
  secretAccessKey: v.optional(v.string()),
  sessionToken: v.optional(v.string()),
});



function json(body: JsonReply): Response {
  return Response.json({ ...body });
}

function jsonWithStatus(body: JsonReply, status: 400 | 401 | 404): Response {
  return Response.json({ ...body }, { status });
}

function authorized(request: Request, token: string | undefined): boolean {
  return token !== undefined && request.headers.get('authorization') === `Bearer ${token}`;
}

async function sha256Of(data: ArrayBuffer | Uint8Array): Promise<string> {
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', view))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** One line of a thrown value, in the shape `new Error(msg, { cause })` spells. */
const describeThrown = (error: Error | string): string =>
  error instanceof Error ? error.message : error;

/** Parse every JSON object line of a supervised command's stdout. */
function harnessResults(stdout: string): readonly HarnessResult[] {
  const lines = stdout.trim().split('\n').filter((entry) => entry.startsWith('{'));
  if (lines.length === 0) throw new Error(`no JSON result in stdout: ${stdout.slice(0, 200)}`);
  return lines.map((line) => v.parse(HarnessResultSchema, JSON.parse(line)));
}

/**
 * The ONE owner Durable Object: container lifecycle + base64 arm + grants +
 * supervised operations, matching product Devbox ownership.
 */

export class PayloadBenchSandbox extends Sandbox<Env> {
  /**
   * Container startup runs under Durable Object blockConcurrencyWhile. Keep
   * it bounded; prepare performs container probes, installation, and mounts.
   */
  override async onStart(): Promise<void> {
    await super.onStart();
  }

  private async reconcileContainer(): Promise<string> {
    await this.exec('mkdir -p /tmp/payload-bench');
    const probe = await this.exec(
      `bun -e 'console.log(JSON.stringify({ imageVersion: process.env.SANDBOX_VERSION ?? null }))'`,
      { timeout: 60_000 },
    );
    const reported = probe.exitCode === 0 ? harnessResults(probe.stdout)[0] : undefined;
    const actualVersion = reported?.imageVersion ?? undefined;
    if (actualVersion !== EXPECTED_IMAGE_VERSION) {
      throw new Error(`stale container image: running ${actualVersion ?? 'unreported'}, pinned ${EXPECTED_IMAGE_VERSION}`);
    }
    await this.writeFile(HARNESS_PATH, HARNESS_TS);
    const ready = await this.exec('cd /tmp/payload-bench && bun --version', { timeout: 60_000 });
    if (ready.exitCode !== 0) throw new Error(`harness runtime not ready: ${ready.stderr.slice(0, 200)}`);
    const bucketName = this.env.BUCKET_NAME;
    if (bucketName === undefined) throw new Error('BUCKET_NAME is not configured');
    await this.mountBucket('BACKUP_BUCKET', `/mnt/${bucketName}`, { prefix: '/' });
    return actualVersion;
  }

  async prepare(): Promise<string> {
    return this.reconcileContainer();
  }


  async control(): Promise<void> {}

  /**
   * Which Worker version THIS Durable Object is running.
   *
   * Asked of the DO and not of the Worker's fetch handler, because the fact
   * the settle gate needs is about the DO: a version rollout REPLACES a
   * Durable Object mid-call — `Durable Object reset because its code was
   * updated` — and a stateless handler can already be answering from the new
   * version while the object a measurement is bound to has not been swapped
   * yet. The run this gate exists for lost its 64 MiB warm-up to exactly that,
   * three `wrangler secret put` versions after the code deploy, several
   * minutes after an unauthenticated readiness probe had reported the origin
   * healthy.
   *
   * Absent binding answers `null` rather than throwing: the driver treats an
   * unreportable version as an unsettleable deployment and censors the run,
   * which is the same answer it gives for an unverifiable image, and is never
   * a measurement.
   */
  async runningVersion(): Promise<string | null> {
    return this.env.CF_VERSION_METADATA?.id ?? null;
  }

  private async sourceFileSize(file: string): Promise<number> {
    const measured = await this.exec(`wc -c < ${shellArg(file)}`, { timeout: 120_000 });
    const output = measured.stdout.trim();
    if (measured.exitCode !== 0 || !/^\d+$/.test(output)) {
      throw new Error(`could not measure ${file}: ${measured.stderr.slice(0, 200)}`);
    }
    const size = Number(output);
    if (!Number.isSafeInteger(size)) throw new Error(`file size is not a safe integer: ${output}`);
    return size;
  }

  /**
   * Arm 1 PUT — THE PRODUCT'S OWNING-DO PATH, not a model of it.
   *
   * `packages/devbox/src/snapshot-chain.ts`'s `stageAndPut` does exactly this:
   * take the SDK's binary file stream out of the container, hand it to
   * `putStream`, and let that route between a single PUT and multipart. So this
   * arm calls the product's own `putStream` over the product's own container
   * stream, and the number it reports is devbox's number.
   *
   * IT REPLACES AN IN-DO REASSEMBLY THAT MEASURED THE FIXTURE. The previous
   * body pulled bounded base64 chunks and welded them into exact 16 MiB
   * multipart parts inside the isolate; that is not a shape devbox has, and it
   * held roughly 40 MiB live per part — the owning DO was reset, three runs out
   * of three, on the FIRST tier large enough to need multipart (64 MiB), with
   * every 8 MiB cell before it green. An arm that cannot complete the tier it
   * exists to price, in a way the product would not fail, is measuring its own
   * assembly. Streaming holds one chunk plus one part, which is what the
   * product holds.
   *
   * The digest is `putStream`'s, taken over the bytes as they pass, so it is
   * the same identity a real checkpoint records — and comparing it against the
   * container's own `sha256sum` is what proves the transport did not corrupt.
   */
  async fileThroughOwnerToObject(file: string, key: string): Promise<{ ms: number; sha256: string }> {
    const sizeBytes = await this.sourceFileSize(file);
    const chunks = streamFile(await this.readFileStream(file));
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await chunks.next();
        if (next.done === true) {
          controller.close();
          return;
        }
        // Text here would prove a protocol mismatch, not a payload: every tier
        // this instrument seeds is random bytes.
        if (!(next.value instanceof Uint8Array)) {
          controller.error(new Error(`${file} streamed text instead of bytes`));
          return;
        }
        controller.enqueue(next.value);
      },
    });
    const started = Date.now();
    const landed = await putStream(this.env.BACKUP_BUCKET, key, body, sizeBytes);
    return { ms: Date.now() - started, sha256: landed.digest };
  }

  /** Arm 1 GET — stream the stored object INTO the container; hash afterwards. */
  async objectThroughOwnerToFile(key: string, file: string): Promise<{ ms: number; sha256: string }> {
    const object = await this.env.BACKUP_BUCKET.get(key);
    if (object === null) throw new Error(`object not found: ${key}`);
    const started = Date.now();
    await this.writeFile(`${file}.returned`, object.body);
    const ms = Date.now() - started;
    const hashed = await this.exec(`sha256sum ${JSON.stringify(`${file}.returned`)}`, { timeout: 120_000 });
    const sha256 = /^([0-9a-f]{64})/.exec(hashed.stdout)?.[1];
    if (sha256 === undefined) throw new Error(`sha256sum printed no digest: ${hashed.stdout.slice(0, 120)}`);
    return { ms, sha256 };
  }

  async verifyObject(key: string): Promise<JsonReply> {
    const object = await this.env.BACKUP_BUCKET.get(key);
    if (object === null) throw new Error(`object not found: ${key}`);
    const data = await object.arrayBuffer();
    return { sha256: await sha256Of(data), size: data.byteLength };
  }

  async presign(key: string, op: 'put' | 'get'): Promise<JsonReply> {
    if (this.env.R2_ACCESS_KEY_ID === undefined || this.env.R2_SECRET_ACCESS_KEY === undefined || this.env.ACCOUNT_ID === undefined || this.env.BUCKET_NAME === undefined) {
      return { available: false, reason: 'R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY were not supplied; presigned direct R2 is unavailable and never replaced by another arm.' };
    }
    const client = new AwsClient({ accessKeyId: this.env.R2_ACCESS_KEY_ID, secretAccessKey: this.env.R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' });
    const request = await client.sign(
      `https://${this.env.ACCOUNT_ID}.r2.cloudflarestorage.com/${this.env.BUCKET_NAME}/${key}`,
      { method: op === 'put' ? 'PUT' : 'GET', aws: { signQuery: true } },
    );
    return { available: true, opaque: request.url, fingerprint: await sha256Of(encoder.encode(request.url)) };
  }

  async temporaryCredentials(prefix: string): Promise<JsonReply> {
    const env = this.env;
    if (env.R2_ACCESS_KEY_ID === undefined || env.R2_SECRET_ACCESS_KEY === undefined || env.ACCOUNT_ID === undefined || env.BUCKET_NAME === undefined) {
      return { available: false, reason: 'R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY were not supplied; temporary S3 credentials are unavailable and never replaced by another arm.' };
    }
    const endpoint = `https://${env.ACCOUNT_ID}.r2.cloudflarestorage.com`;
    const jwt = await new SignJWT({
      bucket: env.BUCKET_NAME,
      scope: 'object-read-write',
      actions: ['PutObject', 'GetObject', 'HeadObject'],
      paths: { prefixPaths: [prefix], objectPaths: [] },
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(env.ACCOUNT_ID)
      .setIssuer(env.R2_ACCESS_KEY_ID)
      .setAudience(new URL(endpoint).host)
      .setIssuedAt()
      .setExpirationTime('900s')
      .sign(encoder.encode(env.R2_SECRET_ACCESS_KEY));
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(jwt));
    return {
      available: true,
      endpoint,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
      sessionToken: btoa(`jwt/${jwt}`),
      fingerprint: await sha256Of(encoder.encode(jwt)),
    };
  }

  /**
   * START-OR-READ a supervised operation. The operationId IS the container
   * process id: deterministic across DO resets, because the process table
   * lives in the container daemon, not in this DO. A reset mid-transfer means
   * the next poll re-reads the SAME process instead of duplicating work.
   * autoCleanup:false keeps the record pollable until the driver drains it.
   * CREDENTIALS ride in ProcessOptions.env, never argv or command strings.
   */
  async startOperation(operationId: string, kind: 'seed' | 'transfer', spec: RequestBody): Promise<{ started: boolean; exitCode: number | null }> {
    // DETERMINISTIC REDRIVE: the process table lives in the container daemon,
    // not in this DO. A RUNNING process is read, never duplicated; an EXITED
    // process is final — its result stays pollable instead of being rerun.
    let existing: Process | null;
    try {
      existing = await this.getProcess(operationId);
    } catch (cause) {
      throw new Error(
        `process lookup failed: ${describeThrown(cause instanceof Error ? cause : String(cause))}`,
        { cause },
      );
    }
    if (existing !== null && !operationNeedsStart(existing)) {
      return { started: false, exitCode: existing.exitCode ?? null };
    }
    let command: string;
    let env: Record<string, string | undefined> | undefined;
    if (kind === 'seed') {
      const input = v.parse(SeedOperationSpecSchema, spec);
      const files = v.parse(
        v.array(v.object({ path: v.string(), sizeMiB: v.number() })),
        JSON.parse(input.files),
      );
      command = [
        'cd /tmp/payload-bench',
        ...files.map((file) =>
          `bun harness.ts seed --path ${JSON.stringify(file.path)} --size-mib ${file.sizeMiB} --seed ${input.seed}`),
      ].join(' && ');
    } else {
      const input = v.parse(TransferOperationSpecSchema, spec);
      const parts = [
        'cd /tmp/payload-bench && bun harness.ts transfer',
        `--mode ${input.mode}`,
        `--op ${input.op}`,
        `--path ${JSON.stringify(input.file)}`,
      ];
      if (input.url !== undefined) parts.push(`--url ${JSON.stringify(input.url)}`);
      if (input.endpoint !== undefined) parts.push(`--endpoint ${JSON.stringify(input.endpoint)}`);
      if (input.key !== undefined) parts.push(`--key ${JSON.stringify(input.key)}`);
      command = parts.join(' ');
      env = {
        BENCH_R2_ACCESS_KEY_ID: input.accessKeyId,
        BENCH_R2_SECRET_ACCESS_KEY: input.secretAccessKey,
        BENCH_R2_SESSION_TOKEN: input.sessionToken,
      };
    }
    await this.startProcess(command, {
      processId: operationId,
      autoCleanup: false,
      env,
    });
    return { started: true, exitCode: null };
  }

  async pollOperation(operationId: string): Promise<{
    exitCode: number | null;
    results?: readonly HarnessResult[];
    error?: string;
  }> {
    const state = await this.getProcess(operationId);
    if (state === null) throw new Error(`operation ${operationId} has no process record`);
    if (state.exitCode === null || state.exitCode === undefined) return { exitCode: null };
    const logs = await this.getProcessLogs(operationId);
    if (state.exitCode !== 0) {
      return { exitCode: state.exitCode, error: logs.stderr.slice(0, 400) || logs.stdout.slice(0, 400) };
    }
    try {
      return { exitCode: 0, results: harnessResults(logs.stdout) };
    } catch (error) {
      return {
        exitCode: state.exitCode,
        error: describeThrown(error instanceof Error ? error : String(error)),
      };
    }
  }

  /** Disposable shutdown: DESTROY the container and clear ephemeral DO state. */
  async destroyRun(): Promise<void> {
    await this.destroy();
    await this.ctx.storage.deleteAll();
  }
}

interface Env {
  BACKUP_BUCKET: R2Bucket;
  PayloadBenchSandbox: DurableObjectNamespace<PayloadBenchSandbox>;
  BENCH_TOKEN?: string;
  ACCOUNT_ID?: string;
  BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  /** Which Worker version this isolate is running. Read INSIDE the Durable
   *  Object, because that is the only place the answer means what the settle
   *  gate needs it to mean — see {@link PayloadBenchSandbox.runningVersion}. */
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
}

/** Delete everything under a prefix, paging until the bucket reports none. */
async function purgePrefix(bucket: R2Bucket, prefix: string): Promise<{ deleted: number; passes: number }> {
  let deleted = 0;
  let passes = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    if (page.objects.length > 0) {
      await bucket.delete(page.objects.map((object) => object.key));
      deleted += page.objects.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
    passes += 1;
  } while (cursor !== undefined);
  return { deleted, passes };
}

async function inventoryBucket(bucket: R2Bucket): Promise<{ objects: number; bytes: number }> {
  let objects = 0;
  let bytes = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ cursor });
    objects += page.objects.length;
    bytes += page.objects.reduce((total, object) => total + object.size, 0);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return { objects, bytes };
}





export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!authorized(request, env.BENCH_TOKEN)) return jsonWithStatus({ error: 'unauthorized' }, 401);
    const url = new URL(request.url);
    const box = env.PayloadBenchSandbox.get(env.PayloadBenchSandbox.idFromName('owner'));
    let body: RequestBody;
    try {
      body = request.method === 'POST' && request.body !== null
        ? v.parse(RequestBodySchema, await request.json())
        : v.parse(RequestBodySchema, {});
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return jsonWithStatus({ error: `invalid request body: ${detail}` }, 400);
    }

    if (url.pathname === '/shape') return json({ ok: true });

    if (url.pathname === '/control') {
      await box.control();
      return json({ ok: true });
    }

    // The settle gate's probe. It goes THROUGH the Durable Object on purpose:
    // a reset in flight surfaces here as an error instead of being discovered
    // by a measurement.
    if (url.pathname === '/version') {
      return json({ version: await box.runningVersion() });
    }

    // Idempotent readiness: the first RPC runs onStart; re-running proves the
    // container still answers and the interception plane holds THIS bucket.
    if (url.pathname === '/setup') {
      try {
        return json({ ok: true, imageVersion: await box.prepare() });
      } catch (error) {
        return json({ error: describeThrown(error instanceof Error ? error : String(error)) });
      }
    }
    // Arm 1 executes in the OWNING DO over the SDK file surface (base64 boundary).
    if (url.pathname === '/arm/do-base64') {
      try {
        const result = String(body['op']) === 'put'
          ? await box.fileThroughOwnerToObject(String(body['file']), String(body['key']))
          : await box.objectThroughOwnerToFile(String(body['key']), String(body['file']));
        return json({ ok: true, ...result });
      } catch (error) {
        return json({ error: describeThrown(error instanceof Error ? error : String(error)) });
      }
    }

    if (url.pathname === '/grant/presign') {
      return json(await box.presign(String(body['key']), String(body['op']) === 'put' ? 'put' : 'get'));
    }

    if (url.pathname === '/temp-credentials') {
      return json(await box.temporaryCredentials(String(body['prefix'] ?? '')));
    }

    // Supervised operations: start-or-read by deterministic operationId, then
    // poll. A long transfer never holds a Worker/DO request open; the driver
    // holds the operation id and polls.
    if (url.pathname === '/op/start') {
      try {
        const outcome = await box.startOperation(
          String(body['operationId']),
          String(body['kind']) === 'seed' ? 'seed' : 'transfer',
          body,
        );
        return json({ ok: true, ...outcome });
      } catch (error) {
        return json({ error: describeThrown(error instanceof Error ? error : String(error)) });
      }
    }

    if (url.pathname === '/op/poll') {
      try {
        return json(await box.pollOperation(String(body['operationId'])));
      } catch (error) {
        return json({ error: describeThrown(error instanceof Error ? error : String(error)) });
      }
    }

    if (url.pathname === '/verify-object') {
      try {
        return json(await box.verifyObject(String(body['key'])));
      } catch (error) {
        return json({ error: describeThrown(error instanceof Error ? error : String(error)) });
      }
    }

    if (url.pathname === '/inventory') return json(await inventoryBucket(env.BACKUP_BUCKET));

    if (url.pathname === '/purge') return json(await purgePrefix(env.BACKUP_BUCKET, ''));

    // Disposable shutdown: destroy() the container and clear ephemeral DO state.
    if (url.pathname === '/destroy') {
      try {
        await box.destroyRun();
        return json({ ok: true });
      } catch (error) {
        return json({ error: describeThrown(error instanceof Error ? error : String(error)) });
      }
    }

    return jsonWithStatus({ error: 'not found' }, 404);
  },
} satisfies ExportedHandler<Env>;
