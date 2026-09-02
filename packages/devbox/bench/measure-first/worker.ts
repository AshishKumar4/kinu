/**
 * LANE 0 FIXTURE. Not product surface and not deployed by `bun run deploy`.
 * `probe.ts` deploys it as an ephemeral Worker under a per-run name, drives its
 * workers.dev origin, and deletes the Worker, the container application and
 * the bucket in a finally.
 *
 * The Durable Object is MeasureBox, a thin subclass of the upstream
 * `@cloudflare/sandbox` Sandbox and deliberately NOT a Devbox: the numbers here
 * are about the platform (kernel, FUSE, disk, R2 through the SDK's intercepted
 * endpoint), and a Devbox would put its own ticks, fences and mounts inside the
 * measurement window. What the product does with the platform is measured by
 * `scripts/bench-devbox-strategies.ts`, not here.
 *
 * Routes, all token-guarded and all JSON: `/health`, `/exec`, `/put`, `/start`,
 * `/mount`, `/unmount`, `/head`, `/purge`, `/destroy`. `/mount` is the same
 * SDK call the candidate arm makes (`mountBucket` with an R2 binding), which is
 * what puts `http://r2.internal` on the container's outbound path.
 *
 * SECURITY. Every route execs commands inside a container, so an absent token
 * refuses everything and the comparison is constant-time. A fixture that
 * outlives its run is inert rather than an open exec endpoint.
 */
import type { ExecOptions } from '@cloudflare/sandbox';

import { ContainerProxy, Sandbox, getSandbox } from '@cloudflare/sandbox';
import * as v from 'valibot';

import { describeThrown } from '../../src/index';

export { ContainerProxy };

interface MeasureEnv {
  BACKUP_BUCKET: R2Bucket;
  MeasureBox: DurableObjectNamespace<MeasureBox>;
  /** Supplied per run through `wrangler deploy --var`, never committed. */
  MEASURE_TOKEN?: string;
}

const BINDING = 'BACKUP_BUCKET';
const BOX_ID = 'measure-first';

export class MeasureBox extends Sandbox<MeasureEnv> {
  override async onStart(): Promise<void> {
    // Container startup runs under blockConcurrencyWhile; nothing measured
    // belongs inside that window.
    await super.onStart();
  }

  /** The candidate arm's own call, so the endpoint under measurement is the
   *  one `src/devbox.ts` hands its s3fs mount. */
  async mountStore(path: string, prefix: string): Promise<void> {
    await this.mountBucket(BINDING, path, { prefix, readOnly: false });
  }

  async unmountStore(path: string): Promise<void> {
    await this.unmountBucket(path);
  }

  /** Kill every process this run started, then the SDK teardown, then the
   *  storage: a destroyed run leaves no process, no container and no row. A
   *  process whose record already completed answers the same way as one that
   *  was never started, so that refusal is not a leak either. */
  override async destroy(): Promise<void> {
    const failures: string[] = [];
    for (const process of await this.listProcesses()) {
      if (process.status === 'running') {
        try {
          await this.killProcess(process.id, 'SIGKILL');
        } catch (error) {
          failures.push(`kill ${process.id}: ${describeThrown({ cause: error })}`);
        }
      }
    }
    try {
      await super.destroy();
    } catch (error) {
      failures.push(`sandbox destroy: ${describeThrown({ cause: error })}`);
    }
    await this.ctx.storage.deleteAll();
    if (failures.length > 0) throw new Error(failures.join('; '));
  }
}

const BodySchema = v.object({
  command: v.optional(v.string()),
  cwd: v.optional(v.string()),
  timeoutMs: v.optional(v.number()),
  path: v.optional(v.string()),
  content: v.optional(v.string()),
  processId: v.optional(v.string()),
  prefix: v.optional(v.string()),
  key: v.optional(v.string()),
});
type Body = v.InferOutput<typeof BodySchema>;

function json<Answer>(payload: Answer, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

/** Constant-time bearer comparison; an absent expected token refuses everything. */
function authorized(request: Request, expected: string | undefined): boolean {
  if (expected === undefined || expected.length === 0) return false;
  const offered = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (offered.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= offered.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function body(request: Request): Promise<Body> {
  if (request.method !== 'POST') return {};
  const text = await request.text();
  if (text.length === 0) return {};
  return v.parse(BodySchema, JSON.parse(text));
}

export default {
  async fetch(request: Request, env: MeasureEnv): Promise<Response> {
    if (!authorized(request, env.MEASURE_TOKEN)) return json({ ok: false, error: 'unauthorized' }, 401);
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true });
    let input: Body;
    try {
      input = await body(request);
    } catch (error) {
      return json({ ok: false, error: `malformed body: ${describeThrown({ cause: error })}` }, 400);
    }
    const box = getSandbox(env.MeasureBox, BOX_ID, { transport: 'rpc', keepAlive: true });
    const started = Date.now();
    try {
      switch (`${request.method} ${url.pathname}`) {
        case 'POST /exec': {
          const options: ExecOptions = { timeout: input.timeoutMs ?? 300_000 };
          if (input.cwd !== undefined) options.cwd = input.cwd;
          const result = await box.exec(input.command ?? 'true', options);
          return json({
            ok: result.exitCode === 0, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
            ms: Date.now() - started,
          });
        }
        case 'POST /put': {
          const path = input.path ?? '';
          if (path.length === 0) return json({ ok: false, error: 'path is required' }, 400);
          await box.writeFile(path, input.content ?? '');
          return json({ ok: true, path, bytes: (input.content ?? '').length, ms: Date.now() - started });
        }
        case 'POST /start': {
          const processId = input.processId ?? '';
          if (processId.length === 0) return json({ ok: false, error: 'processId is required' }, 400);
          const existing = await box.getProcess(processId);
          if (existing !== null) {
            return json({ ok: true, processId, status: existing.status, started: false, ms: Date.now() - started });
          }
          const process = await box.startProcess(input.command ?? 'true', { processId, autoCleanup: false });
          return json({ ok: true, processId, status: process.status, started: true, ms: Date.now() - started });
        }
        case 'POST /mount': {
          const path = input.path ?? '';
          if (path.length === 0) return json({ ok: false, error: 'path is required' }, 400);
          await box.mountStore(path, input.prefix ?? 'measure');
          return json({ ok: true, path, ms: Date.now() - started });
        }
        case 'POST /unmount': {
          const path = input.path ?? '';
          if (path.length === 0) return json({ ok: false, error: 'path is required' }, 400);
          await box.unmountStore(path);
          return json({ ok: true, path, ms: Date.now() - started });
        }
        case 'GET /head': {
          // What the STORE holds under one key, through the binding: the only
          // reader of R2's own checksums, which no HTTP receipt carries.
          const key = url.searchParams.get('key') ?? '';
          if (key.length === 0) return json({ ok: false, error: 'key is required' }, 400);
          const object = await env.BACKUP_BUCKET.head(key);
          if (object === null) return json({ ok: false, key, exists: false, ms: Date.now() - started }, 404);
          const hex = (bytes: ArrayBuffer | undefined): string | null =>
            bytes === undefined ? null : [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
          return json({
            ok: true, key, exists: true, size: object.size, etag: object.etag, httpEtag: object.httpEtag,
            uploaded: object.uploaded.toISOString(),
            checksums: {
              md5: hex(object.checksums.md5), sha1: hex(object.checksums.sha1), sha256: hex(object.checksums.sha256),
              sha384: hex(object.checksums.sha384), sha512: hex(object.checksums.sha512),
            },
            ms: Date.now() - started,
          });
        }
        case 'POST /purge': {
          // The bucket is this run's own; an empty prefix is the whole store.
          let purged = 0;
          for (;;) {
            const page = await env.BACKUP_BUCKET.list({ prefix: input.prefix ?? '' });
            const keys = page.objects.map((object) => object.key);
            if (keys.length === 0) break;
            await env.BACKUP_BUCKET.delete(keys);
            purged += keys.length;
          }
          return json({ ok: true, purged, ms: Date.now() - started });
        }
        case 'POST /destroy': {
          await box.destroy();
          return json({ ok: true, ms: Date.now() - started });
        }
        default:
          return json({ ok: false, error: `no route for ${request.method} ${url.pathname}` }, 404);
      }
    } catch (error) {
      return json({ ok: false, error: describeThrown({ cause: error }), ms: Date.now() - started }, 502);
    }
  },
};
