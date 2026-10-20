/**
 * Outbound network policy for eval and resident slate code, exported via
 * workerd `enable_ctx_exports` as the WorkerLoader `globalOutbound`. It is also
 * the one door from sandbox code to a Browser Run session: a WebSocket upgrade
 * to {@link BROWSER_GATE_HOST} reaches a session the calling actor opened, or a
 * new Kitesurf browser, and no credential enters the sandbox.
 * Every other request meets the one forwarding policy every program's request does (`egress/policy.ts`), for the
 * principal the program runs for. Unmeasured residual: public names resolving to private addresses are not caught here.
 */

import { WorkerEntrypoint, exports } from 'cloudflare:workers';
import { objectNamed, KITESURF_SESSION_ID, type EgressPrincipal } from '@kinu.run/core';
import { diagnostics, KinuError } from '@kinu.run/core/obs';
import { EGRESS_FAILURE_HEADER } from './egress/send-out';
import { forwardEgress, githubRecorder, type EgressPolicyEnv, type GitHubWorkspace } from './egress/policy';

export interface CodemodeEgressProps {
  /**
   * Whom the program runs for. Its `actorId` is whose browser sessions it reaches; null for slate code, which reaches only
   * a new Kitesurf browser. A preview's slate runs as the owner, unbounded by a share's grant; a shared one, as a viewer.
   */
  readonly principal: EgressPrincipal;
}

/** The host `connectBrowser` dials; the path's last segment is a session id or `kitesurf`. */
export const BROWSER_GATE_HOST = 'browser.kinu.invalid';

interface BrowserSockets {
  fetch(input: string, init: RequestInit): Promise<Response>;
  connectSession(sessionId: string): Promise<{ webSocket: { fetch(input: string, init: RequestInit): Promise<Response> } }>;
}

/** The workspace object, as far as this egress needs it: whether an agent opened a browser session, and the owner's GitHub work. */
type WorkspaceObject = GitHubWorkspace & { ownsBrowserSession(actorId: string, sessionId: string): Promise<boolean> };

type EgressEnv = EgressPolicyEnv & { readonly BROWSER: BrowserSockets; readonly OrchestratorAgent: DurableObjectNamespace<WorkspaceObject> };

/** The path puppeteer asks for a Kitesurf browser, which Browser Run creates on connect. */
const KITESURF_CONNECT = 'https://browser-run.invalid/v1/devtools/browser?browser=kitesurf';

async function browserGate(request: Request, env: EgressEnv, props: CodemodeEgressProps): Promise<Response> {
  const id = new URL(request.url).pathname.split('/').at(-1) ?? '';
  const upgrade = { headers: { Upgrade: 'websocket' } };

  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response(`${BROWSER_GATE_HOST} answers only a WebSocket upgrade`, { status: 400, headers: { [EGRESS_FAILURE_HEADER]: '1' } });
  }

  if (id === KITESURF_SESSION_ID) return await env.BROWSER.fetch(KITESURF_CONNECT, upgrade);

  const { workspace, actorId } = props.principal;
  const owned = actorId !== null && await objectNamed(env.OrchestratorAgent, workspace).ownsBrowserSession(actorId, id);

  if (!owned) {
    diagnostics.failure('egress.browser_refused', new KinuError('denied', 'a browser session the caller did not open'), { seam: 'codemode' });

    return new Response(`browser ${id} is not one this agent opened`, { status: 403, headers: { [EGRESS_FAILURE_HEADER]: '1' } });
  }

  return await (await env.BROWSER.connectSession(id)).webSocket.fetch('https://browser-run.invalid/', upgrade);
}

export class CodemodeEgress extends WorkerEntrypoint<EgressEnv, CodemodeEgressProps> {
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).hostname === BROWSER_GATE_HOST) return await browserGate(request, this.env, this.ctx.props);

    return await forwardEgress(request, this.env, this.ctx.props.principal, { self: exports.default, github: githubRecorder(this.env.OrchestratorAgent, this.ctx), seam: 'codemode' });
  }
}

/** Null outside workerd (test harnesses). */
export function codemodeEgress(props: CodemodeEgressProps): Fetcher | null {
  return exports.CodemodeEgress?.({ props }) ?? null;
}
