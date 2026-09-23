/**
 * Standalone entry for the onStart discrimination probes. Deployed ONLY from
 * `wrangler.probe.jsonc` — never from the bench config, never in product.
 *
 * Routes (all JSON; every POST/GET pair shares the same `op`/`box` id):
 *
 *   GET  /health                    liveness, no auth needed
 *   GET  /probe/resources           the declared resource inventory (below)
 *   POST /probe/gate?arm=&op=       P1: timer-inside | timer-outside | storage-inside
 *   GET  /probe/gate?op=            P1 stamps, read after the POST settles or resets
 *   POST /probe/onstart?mode=&box=  P2: start | ports — one minimal exec in onStart
 *   GET  /probe/onstart?box=        P2 stamps, read after the POST settles or resets
 *   POST /probe/onstart/destroy?box= tear the probe container down after a run
 *   POST /probe/reentry?box=&windowMs=&holdMs=&pending=  D8's control: the start block
 *                                   reopened while a timer set outside it is pending
 *   POST /probe/reentry/touch?box=  a request sent while the reentered hook holds
 *   GET  /probe/reentry?box=        reentry stamps, read after the POST settles or resets
 *
 * COMPLETE RESOURCE INVENTORY — everything a probe campaign creates, and how
 * it is removed. Per-run ids (`op`, `box`) are unique per run, so runs never
 * share Durable Object rows or container identities:
 *
 *   1. Worker `kinu-devbox-onstart-probe` — `wrangler delete` at campaign end.
 *   2. DO namespace `GateProbe` — rows keyed `probe:gate*` under
 *      `gate-<op>` ids; no cross-run reads; deleted with the Worker.
 *   3. DO namespace `OnStartExecProbe` — rows keyed `probe:exec` under
 *      `exec-<box>` ids; container torn down per run via
 *      POST /probe/onstart/destroy; namespace deleted with the Worker.
 *   4. Container app `kinu-devbox-onstart-probe-onstartexecprobe` — one
 *      instance per box id (`max_instances: 1` is per app, runs are serial);
 *      every run ends with the destroy route above, verified by a final
 *      GET /probe/onstart showing no live exec row.
 *   5. No R2 bucket, no queues, no alarms, no scheduled work — the probe
 *      creates none, so there is nothing else to sweep.
 */
import { ContainerProxy } from '@cloudflare/sandbox';
import { GateProbe, OnStartExecProbe, type ProbeBindings } from './onstart-probe';
import { REENTRY_PENDING } from './reentry';

export { ContainerProxy };

export { GateProbe, OnStartExecProbe };

interface ProbeEnv extends ProbeBindings {
  /** Supplied per deploy through `wrangler deploy --var`, never committed. */
  PROBE_TOKEN?: string;
}

/** One driver answer: the payload a route built, and the status it answers
 *  with. Nothing here reads inside the payload — only `JSON.stringify` does,
 *  and an RPC result carries `Disposable` beside its own fields. */
interface Answer {
  readonly payload: unknown;
  readonly status?: number;
}

function json(answer: Answer): Response {
  return new Response(JSON.stringify(answer.payload), {
    status: answer.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Constant-time bearer comparison, the bench fixture's own shape. */
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

const PROBE_RESOURCES = {
  worker: 'kinu-devbox-onstart-probe',
  durableObjects: ['GateProbe', 'OnStartExecProbe'],
  containerApp: 'kinu-devbox-onstart-probe-onstartexecprobe',
  rowKeys: { gate: 'gate-<op>', exec: 'exec-<box>' },
  createsNothingElse: ['no R2 bucket', 'no queues', 'no alarms', 'no scheduled work'],
  perRunCleanup: 'POST /probe/onstart/destroy?box=<box>',
  campaignCleanup: 'wrangler delete --config packages/devbox/bench/wrangler.probe.jsonc',
} as const;

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    if (route === 'GET /health') return json({ payload: { ok: true } });

    if (route === 'GET /probe/resources') return json({ payload: { ok: true, resources: PROBE_RESOURCES } });

    if (!authorized(request, env.PROBE_TOKEN)) return json({ payload: { ok: false, error: 'unauthorized' }, status: 401 });

    switch (route) {
      case 'POST /probe/gate': {
        const op = url.searchParams.get('op') ?? '';

        if (op === '') return json({ payload: { ok: false, error: 'op is required' }, status: 400 });

        const probe = env.GateProbe.get(env.GateProbe.idFromName(`gate-${op}`));

        return json({ payload: { ok: true, op, stamp: await probe.probe(url.searchParams.get('arm') ?? 'timer-inside') } });
      }

      case 'GET /probe/gate': {
        const op = url.searchParams.get('op') ?? '';

        if (op === '') return json({ payload: { ok: false, error: 'op is required' }, status: 400 });

        const probe = env.GateProbe.get(env.GateProbe.idFromName(`gate-${op}`));

        return json({ payload: { ok: true, op, stamp: await probe.probeReport() } });
      }

      case 'POST /probe/onstart': {
        const box = url.searchParams.get('box') ?? '';

        if (box === '') return json({ payload: { ok: false, error: 'box is required' }, status: 400 });

        const probe = env.OnStartExecProbe.get(env.OnStartExecProbe.idFromName(`exec-${box}`));

        return json({ payload: { ok: true, box, stamp: await probe.probeStart(url.searchParams.get('mode') ?? 'start') } });
      }

      case 'GET /probe/onstart': {
        const box = url.searchParams.get('box') ?? '';

        if (box === '') return json({ payload: { ok: false, error: 'box is required' }, status: 400 });

        const probe = env.OnStartExecProbe.get(env.OnStartExecProbe.idFromName(`exec-${box}`));

        return json({ payload: { ok: true, box, stamp: await probe.probeReport() } });
      }

      case 'POST /probe/onstart/destroy': {
        const box = url.searchParams.get('box') ?? '';

        if (box === '') return json({ payload: { ok: false, error: 'box is required' }, status: 400 });

        const probe = env.OnStartExecProbe.get(env.OnStartExecProbe.idFromName(`exec-${box}`));

        return json({ payload: { ok: true, box, ...(await probe.destroyProbe()) } });
      }

      case 'POST /probe/reentry':
      case 'POST /probe/reentry/touch':
      case 'GET /probe/reentry':
        return await reentryRoute(route, url, env);

      default:
        return json({ payload: { ok: false, error: `unknown probe route: ${route}` }, status: 404 });
    }
  },
};

/** The reentry control's three routes on one box's probe object. */
async function reentryRoute(route: string, url: URL, env: ProbeEnv): Promise<Response> {
  const box = url.searchParams.get('box') ?? '';

  if (box === '') return json({ payload: { ok: false, error: 'box is required' }, status: 400 });

  const probe = env.OnStartExecProbe.get(env.OnStartExecProbe.idFromName(`exec-${box}`));

  if (route === 'POST /probe/reentry/touch') return json({ payload: { ok: true, box, at: await probe.touch() } });

  if (route === 'GET /probe/reentry') return json({ payload: { ok: true, box, stamp: await probe.reentryReport() } });
  const windowMs = Number(url.searchParams.get('windowMs') ?? '5000');
  const holdMs = Number(url.searchParams.get('holdMs') ?? '2000');
  const pending = REENTRY_PENDING.find((kind) => kind === (url.searchParams.get('pending') ?? 'connection'));

  if (!Number.isInteger(windowMs) || !Number.isInteger(holdMs) || windowMs < 0 || holdMs < 0 || pending === undefined) {
    return json({ payload: { ok: false, error: `windowMs and holdMs must be non-negative integers; pending one of ${REENTRY_PENDING.join(', ')}` }, status: 400 });
  }

  return json({ payload: { ok: true, box, stamp: await probe.probeReentry(windowMs, holdMs, pending) } });
}
