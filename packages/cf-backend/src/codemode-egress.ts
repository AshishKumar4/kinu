/**
 * Outbound network policy for eval and resident slate code, exported via
 * workerd `enable_ctx_exports` as the WorkerLoader `globalOutbound`. It is also
 * the one door from sandbox code to a Browser Run session: a WebSocket upgrade
 * to {@link BROWSER_GATE_HOST} reaches a session the calling actor opened, or a
 * new Kitesurf browser, and no credential enters the sandbox.
 * Applies `refusedHostname` like `egress/outbound.ts` and `web/url-safety.ts`.
 * redirect:manual so no unjudged destination is followed. Unmeasured residual:
 * public names resolving to private addresses are not caught here.
 */

import { WorkerEntrypoint, exports } from 'cloudflare:workers';
import { KITESURF_SESSION_ID, parseWorkspacePreviewLabel, previewHostSuffix, refusedHostname, type PreviewSuffixEnv } from '@kinu.run/core';
import { diagnostics, KinuError, toKinuError } from '@kinu.run/core/obs';

/** Loopback throws reach the caller as opaque `internal error`, so failures
 *  travel as responses (codemode-node-shim.ts `createFetch` rethrows). */
export const EGRESS_FAILURE_HEADER = 'x-kinu-egress-failure';

export interface CodemodeEgressProps {
  readonly workspace: string | null;
  /** The actor whose program this is; null for slate code, which reaches only a new Kitesurf browser. */
  readonly actor: string | null;
}

/** The host `connectBrowser` dials; the path's last segment is a session id or `kitesurf`. */
export const BROWSER_GATE_HOST = 'browser.kinu.invalid';

/** What the gate asks of the workspace object and of Browser Run, and nothing more. */
interface BrowserOwners {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { ownsBrowserSession(actorId: string, sessionId: string): Promise<boolean> };
}

interface BrowserSockets {
  fetch(input: string, init: RequestInit): Promise<Response>;
  connectSession(sessionId: string): Promise<{ webSocket: { fetch(input: string, init: RequestInit): Promise<Response> } }>;
}

type EgressEnv = PreviewSuffixEnv & { readonly BROWSER: BrowserSockets; readonly OrchestratorAgent: BrowserOwners };

/** The path puppeteer asks for a Kitesurf browser, which Browser Run creates on connect. */
const KITESURF_CONNECT = 'https://browser-run.invalid/v1/devtools/browser?browser=kitesurf';

async function browserGate(request: Request, env: EgressEnv, props: CodemodeEgressProps): Promise<Response> {
  const id = new URL(request.url).pathname.split('/').at(-1) ?? '';
  const upgrade = { headers: { Upgrade: 'websocket' } };

  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response(`${BROWSER_GATE_HOST} answers only a WebSocket upgrade`, { status: 400, headers: { [EGRESS_FAILURE_HEADER]: '1' } });
  }

  if (id === KITESURF_SESSION_ID) return await env.BROWSER.fetch(KITESURF_CONNECT, upgrade);

  const owned = props.workspace !== null && props.actor !== null
    && await env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(props.workspace)).ownsBrowserSession(props.actor, id);

  if (!owned) {
    diagnostics.failure('egress.browser_refused', new KinuError('denied', 'a browser session the caller did not open'), { seam: 'codemode' });

    return new Response(`browser ${id} is not one this agent opened`, { status: 403, headers: { [EGRESS_FAILURE_HEADER]: '1' } });
  }

  return await (await env.BROWSER.connectSession(id)).webSocket.fetch('https://browser-run.invalid/', upgrade);
}

function ownPreviewHost(url: URL, env: PreviewSuffixEnv, workspace: string): boolean {
  const suffix = previewHostSuffix(env);

  if (suffix === null || !url.hostname.endsWith(`.${suffix}`)) return false;

  return parseWorkspacePreviewLabel(url.hostname.slice(0, -suffix.length - 1))?.workspace === workspace;
}

async function forwardCodemodeEgress(request: Request, env: EgressEnv, props: CodemodeEgressProps): Promise<Response> {
  const url = new URL(request.url);
  const self = exports.default;
  const { workspace } = props;

  if (url.hostname === BROWSER_GATE_HOST) return await browserGate(request, env, props);

  if (self !== undefined && workspace !== null && ownPreviewHost(url, env, workspace)) return await self.fetch(request);

  const refusal = refusedHostname(url.hostname);

  if (refusal !== null) {
    diagnostics.failure(
      'egress.private_destination',
      new KinuError('denied', refusal.error),
      { host: url.hostname, seam: 'codemode' },
    );

    return Response.json(refusal, {
      status: 403,
      headers: { [EGRESS_FAILURE_HEADER]: '1' },
    });
  }

  try {
    return await fetch(new Request(request, {
      redirect: request.redirect === 'error' ? 'error' : 'manual',
    }));
  } catch (cause) {
    const error = toKinuError({ doing: 'forwarding an eval program\'s request', cause, otherwise: 'unavailable' });
    diagnostics.failure('egress.upstream_failed', error, { host: url.hostname, seam: 'codemode' });

    return new Response(`Kinu could not complete the request to ${url.hostname} (${error.code}).`, {
      status: error.code === 'timeout' ? 504 : 502,
      headers: { [EGRESS_FAILURE_HEADER]: '1' },
    });
  }
}

export class CodemodeEgress extends WorkerEntrypoint<EgressEnv, CodemodeEgressProps> {
  override async fetch(request: Request): Promise<Response> {
    return await forwardCodemodeEgress(request, this.env, this.ctx.props);
  }
}

/** Null outside workerd (test harnesses). */
export function codemodeEgress(props: CodemodeEgressProps): Fetcher | null {
  return exports.CodemodeEgress?.({ props }) ?? null;
}
