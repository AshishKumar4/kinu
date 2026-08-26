/**
 * The ephemeral CaptureSound probe Worker: one unique deployment per run,
 * destroyed by its own driver.
 *
 * Three routes, all behind the per-run bearer token supplied through
 * `wrangler deploy --var CAPTURE_PROBE_TOKEN:<token>`:
 *
 *   GET  /health    readiness: an authorized 200 (an unauthenticated 401
 *                   proves only that SOMETHING is answering).
 *   POST /probe     body {source}: writes the probe script into the REAL
 *                   container (cloudflare/sandbox:0.12.8), runs it with bun,
 *                   and returns {exitCode, stdout, stderr}. The probe prints
 *                   exactly one JSON report line on stdout; diagnostics go to
 *                   stderr by its own convention.
 *   POST /shutdown  stops the box so teardown's container-application delete
 *                   finds nothing running.
 *
 * The probe source travels in the request rather than being bundled here: the
 * fixture under test stays the single copy of that file
 * (`scripts/fixtures/capture-probe/probe.ts`), and a redeploy is never needed
 * to measure a probe revision.
 */

import { Sandbox } from '@cloudflare/sandbox';
import * as v from 'valibot';

interface CaptureProbeStub {
  runProbe(source: string): Promise<{ exitCode: number; stdout: string; stderr: string; imageVersion: string }>;
  disposeEphemeralProbe(): Promise<void>;
}

interface CaptureProbeNamespace {
  idFromName(name: string): string;
  get(id: string): CaptureProbeStub;
}

interface DisposableProbeStorage {
  deleteAll(): Promise<void>;
}
interface ProbeEnv {
  /** Supplied per run through `--var`; absent makes every route 401. */
  readonly CAPTURE_PROBE_TOKEN?: string;
  readonly CaptureProbeBox: CaptureProbeNamespace;
}

const PROBE_DIR = '/tmp/capture-probe';
const EXPECTED_SANDBOX_VERSION = '0.12.8';


const ProbeRequestSchema = v.strictObject({
  source: v.pipe(v.string(), v.minLength(1)),
});

export class CaptureProbeBox extends Sandbox<ProbeEnv> {
  declare readonly ctx: { readonly storage: DisposableProbeStorage };

  /**
   * Called once per CONTAINER start, not per DO activation. This fixture has no
   * durable Head to mount — it is Wave-0 capability evidence — but it still
   * follows the ownership boundary: create/reconnect the container-local probe
   * daemon state idempotently and prove bun is runnable before control RPCs.
   * A DO reset while the container lives does not run this again and cannot
   * duplicate the process or interfere with it.
   */
  override async onStart(): Promise<void> {
    await super.onStart();
    const ready = await this.exec([
      'set -eu',
      `test "${'${SANDBOX_VERSION:-unknown}'}" = "${EXPECTED_SANDBOX_VERSION}"`,
      `mkdir -p ${PROBE_DIR}`,
      'command -v bun >/dev/null',
      `printf ready > ${PROBE_DIR}/daemon.ready`,
    ].join('\n'));
    if (ready.exitCode !== 0) throw new Error(`probe daemon readiness failed: ${ready.stderr}`);
  }

  /**
   * One container control message, one multiline atomic phase. The DO does not
   * walk files, sync, hash, or coordinate capture steps; it asks the container
   * daemon to run the whole probe process and returns its small result.
   */
  async runProbe(source: string): Promise<{ exitCode: number; stdout: string; stderr: string; imageVersion: string }> {
    const encoded = Buffer.from(source, 'utf8').toString('base64');
    const result = await this.exec([
      'set -eu',
      `actual="${'${SANDBOX_VERSION:-unknown}'}"`,
      `test "$actual" = "${EXPECTED_SANDBOX_VERSION}" || { echo "STALE_IMAGE:$actual" >&2; exit 78; }`,
      'printf "CAPTURE_IMAGE_VERSION:%s\\n" "$actual"',
      `mkdir -p ${PROBE_DIR}`,
      `printf '%s' '${encoded}' | base64 -d > ${PROBE_DIR}/probe.ts`,
      `cd ${PROBE_DIR}`,
      'exec bun probe.ts',
    ].join('\n'));
    const imageLine = result.stdout.split('\n').find((line) => line.startsWith('CAPTURE_IMAGE_VERSION:'));
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      imageVersion: imageLine?.slice('CAPTURE_IMAGE_VERSION:'.length) ?? 'unknown',
    };
  }

  /** Teardown-only: destroy the container, then clear fixture DO state. */
  async disposeEphemeralProbe(): Promise<void> {
    await this.destroy();
    await this.ctx.storage.deleteAll();
  }
}

function authorized(request: Request, env: ProbeEnv): boolean {
  const expected = env.CAPTURE_PROBE_TOKEN;
  // An absent token refuses everything, constant-shape: a misconfigured deploy
  // is inert instead of open.
  if (expected === undefined || expected.length === 0) return false;
  const header = request.headers.get('authorization');
  return header === `Bearer ${expected}`;
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    if (!authorized(request, env)) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    const url = new URL(request.url);
    const box = env.CaptureProbeBox.get(env.CaptureProbeBox.idFromName('capture-probe'));

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/shutdown') {
      await box.disposeEphemeralProbe();
      return Response.json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/probe') {
      const raw = await request.text();
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch (error) {
        console.warn(`[capture-probe] rejected malformed probe request: ${String(error)}`);
        return Response.json({ error: 'body is not JSON' }, { status: 400 });
      }
      const parsed = v.safeParse(ProbeRequestSchema, body);
      if (!parsed.success) {
        return Response.json({ error: 'body.source must be non-empty probe source text' }, { status: 400 });
      }
      try {
        return Response.json(await box.runProbe(parsed.output.source));
      } catch (error) {
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        console.warn(`[capture-probe] probe RPC failed: ${detail}`);
        return Response.json({ error: detail }, { status: 500 });
      }
    }

    return Response.json({ error: `no route for ${request.method} ${url.pathname}` }, { status: 404 });
  },
};
