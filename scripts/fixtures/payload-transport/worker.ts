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
 *   do-base64            the owning DO pulls the file out of the container
 *                        through `readFile()` (base64 across the RPC boundary —
 *                        the current product path) and writes decoded bytes to
 *                        the binding; GET streams back via `writeFile()`
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
import { Sandbox, ContainerProxy } from '@cloudflare/sandbox';
import * as v from 'valibot';
import { operationNeedsStart } from './decision';
import { HarnessResultSchema } from './wire';
import type { HarnessResult } from './wire';

// The harness ships as RAW TEXT inside this Worker's bundle (wrangler Text rule)
// so onStart can install it. The .bundle.txt twin is byte-identical to
// container-harness.ts by test — one source of truth, mechanically gated.
// @ts-expect-error -- bundled as raw text by wrangler rules, not as a module
import HARNESS_TS from './container-harness.bundle.txt';

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

const RequestBodySchema = v.record(v.string(), v.string());


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

function decodeBase64(value: string): Uint8Array {
  const raw = atob(value);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
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
const OperationSpecSchema = v.record(v.string(), v.string());
type OperationSpec = v.InferOutput<typeof OperationSpecSchema>;

export class PayloadBenchSandbox extends Sandbox<Env> {
  private runningImageVersion: string | undefined;

  /**
   * Idempotent readiness: reconnect/start the container daemon, verify the
   * RUNNING image version against the pinned one, install the harness from the
   * bundled source, and prove bun can execute it. Safe to call again after any
   * DO reset; nothing here assumes prior local state.
   */
  override async onStart(): Promise<void> {
    await super.onStart();
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
    this.runningImageVersion = actualVersion;
    await this.writeFile(HARNESS_PATH, HARNESS_TS);
    const ready = await this.exec('cd /tmp/payload-bench && bun --version', { timeout: 60_000 });
    if (ready.exitCode !== 0) throw new Error(`harness runtime not ready: ${ready.stderr.slice(0, 200)}`);
    const bucketName = this.env.BUCKET_NAME;
    if (bucketName === undefined) throw new Error('BUCKET_NAME is not configured');
    await this.mountBucket(bucketName, `/mnt/${bucketName}`, { prefix: '' });
  }

  async runtimeImageVersion(): Promise<string> {
    if (this.runningImageVersion === undefined) {
      throw new Error('container onStart did not record image identity');
    }
    return this.runningImageVersion;
  }
  async prepare(): Promise<string> {
    await this.exec('true', { timeout: 60_000 });
    return this.runtimeImageVersion();
  }


  async control(): Promise<void> {}

  /** Arm 1 PUT — the CURRENT product path: base64 across the RPC boundary. */
  async fileThroughOwnerToObject(file: string, key: string): Promise<{ ms: number; sha256: string }> {
    const started = Date.now();
    const read = await this.readFile(file);
    const bytes = read.encoding === 'base64' ? decodeBase64(read.content) : encoder.encode(read.content);
    await this.env.BACKUP_BUCKET.put(key, bytes);
    return { ms: Date.now() - started, sha256: await sha256Of(bytes) };
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
  async startOperation(operationId: string, kind: 'seed' | 'transfer', spec: OperationSpec): Promise<{ started: boolean; exitCode: number | null }> {
    // DETERMINISTIC REDRIVE: the process table lives in the container daemon,
    // not in this DO. A RUNNING process is read, never duplicated; an EXITED
    // process is final — its result stays pollable instead of being rerun.
    const existing = await this.getProcess(operationId).catch((error) => { throw new Error(`process lookup failed: ${describeThrown(error instanceof Error ? error : String(error))}`, { cause: error }); });
    if (!operationNeedsStart(existing)) {
      return { started: false, exitCode: existing!.exitCode ?? null };
    }
    let command: string;
    let env: Record<string, string | undefined> | undefined;
    if (kind === 'seed') {
      const files = v.parse(v.array(v.object({ path: v.string(), sizeMiB: v.number() })), JSON.parse(spec['files']!));
      command = [
        'cd /tmp/payload-bench',
        ...files.map((file) =>
          `bun harness.ts seed --path ${JSON.stringify(file.path)} --size-mib ${file.sizeMiB} --seed ${spec['seed']}`),
      ].join(' && ');
    } else {
      const mode = spec['mode']!;
      if (mode !== 'loopback' && mode !== 'direct' && mode !== 'sigv4') throw new Error(`unknown transfer mode ${mode}`);
      const parts = [
        'cd /tmp/payload-bench && bun harness.ts transfer',
        `--mode ${mode}`,
        `--op ${spec['op']}`,
        `--path ${JSON.stringify(spec['file']!)}`,
      ];
      if (spec['url'] !== undefined) parts.push(`--url ${JSON.stringify(spec['url'])}`);
      if (spec['endpoint'] !== undefined) parts.push(`--endpoint ${JSON.stringify(spec['endpoint'])}`);
      if (spec['key'] !== undefined) parts.push(`--key ${JSON.stringify(spec['key'])}`);
      command = parts.join(' ');
      // Credential values travel ONLY here — never into the command string.
      env = {
        BENCH_R2_ACCESS_KEY_ID: spec['accessKeyId'],
        BENCH_R2_SECRET_ACCESS_KEY: spec['secretAccessKey'],
        BENCH_R2_SESSION_TOKEN: spec['sessionToken'],
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
    const body = request.method === 'POST' && request.body !== null
      ? v.parse(RequestBodySchema, await request.json())
      : v.parse(RequestBodySchema, {});

    if (url.pathname === '/shape') return json({ ok: true });

    if (url.pathname === '/control') {
      await box.control();
      return json({ ok: true });
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
