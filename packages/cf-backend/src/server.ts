/**
 * Worker entry point: exports every DO class and routes requests. Order matters:
 * HTTPS upgrade, preview hosts, /pc, the Cloudflare Access gate (/control*,
 * /api/control* only), public routes, the auth gate, CSRF, then signed-in routes.
 */

import { routeAgentRequest } from "agents";
import { ORCHESTRATOR_AGENT_SLUG, REAL_CLOCK } from "@kinu.run/core";
import { diagnostics, renderThrownChain, toKinuError, type ErrorCode } from "@kinu.run/core/obs";
import {
  extractOrchestratorAgentName,
  extractTicketOrchestratorAgentName,
  isForeignAgentNamespacePath, hostedActorRoute,
} from "@kinu.run/core";
import { firstResponse, handlePcRequest } from "@kinu.run/core";
import { servePreviewRequest } from "./preview-proxy";
import { handleRunEventsRequest, handleWorkspaceOverviewRequest, runEventsResolver } from "./run-events-routes";
import { handleEvalAbortRequest } from "./eval/abort-route";
import { handleMcpRequest, mcpAgentResolver } from "./mcp-server";
import { handleHealthRequest } from "@kinu.run/core";
import { handleClientErrorRequest } from "./client-error/route";
import { handleUserRequest } from "./user/routes";
import { handleAccountRequest } from "./user/account-routes";
import { handleCliRequest } from "./cli/routes";
import { handleReleaseArtifactRequest } from "@kinu.run/core";
import { handleDeployRequest } from "./deploy/routes";
import { handleUpdatesRequest } from "./updates/routes";
import { handleAuthRequest } from "./auth/routes";
import { handleLandingRequest } from "./landing-route";
import { handleSharedPublicRequest, handleSharedRequest } from "./shared/routes";
import { handleDriveRequest } from "./drive/routes";
import {
  handleHubRequest, handleWebhookDeliveryRequest, hubAgentResolver, webhookDeliveryResolver,
} from "./events/routes";
import { handleFilesRequest } from "./files-routes";
import { handleTerminalRequest, terminalRouteDeps } from "./terminal-route";
import { handleInboundEmail } from "./email/handler";
import { MONITOR_SINGLETON } from "./monitor/monitor-do";
import { handleSlateShareHostRequest } from "./slate-share-route";
import { handleNimbusPreviewHostRequest } from "./nimbus-route";
import {
  authenticateRequest, AuthError, crossSiteRejection, isPublicPath,
  type AuthIdentity,
} from "./auth/session";
import {
  containPreviewResponse, hostOf, isPreviewHostRequest, previewHostSuffix, previewSuffixMetaName,
} from "@kinu.run/core";
import { withAppSecurityHeaders } from "@kinu.run/core";
import { parseCliAgentConnectTicketUserId } from "./user/user-do";
import { ownerCaller } from "@kinu.run/core";
import { AUTH_TIME_HEADER, CLI_BEARER_HEADER, CLI_SCOPES_HEADER, SESSION_BEARER_HEADER, USER_ID_HEADER } from "./cli/rpc-gate";
import { claimOwnedWorkspace } from "./user/workspace-ownership";
import { err } from "@kinu.run/core";
import { handleFeedbackRequest } from "./feedback/routes";
import { handleControlRequest } from "./control-plane/routes";
import {
  isControlPlaneSurface, verifyControlPlaneAccess, type AccessIdentity,
} from "./control-plane/access-gate";
import {
  adminDenialMessage, adminDenialStatus, reportAdminDenial,
} from "./control-plane/admin-caller";
import { observeIdentity, observeWorkspaceUse } from "./control-plane/index-feed";
import { installAnalyticsDiagnostics } from "@kinu.run/core/analytics";

// The one actor-bearing DO class: every actor in a workspace shares its SQLite.
export { OrchestratorAgent } from "./orchestrator";

export { KinuSandbox } from "./kinu-sandbox";

// Loopback egress for `eval` programs (codemode-egress.ts); absent, they have no network.
export { CodemodeEgress } from "./codemode-egress";

export { SlateBinding } from "./slates/bindings";

// Required: the Sandbox DO builds outbound interception from
// `ctx.exports.ContainerProxy`; without it egress goes unintercepted.
export { ContainerProxy } from "@cloudflare/sandbox";

export { UserDO } from "./user/user-do";

// Mossaic Drive DOs, renamed to avoid clashing with `UserDO`; the SDK
// addresses them by binding name (`MOSSAIC_USER`, `MOSSAIC_SHARD`).
export { UserDO as MossaicUserDO, ShardDO as MossaicShardDO } from "@mossaic/sdk";

export { MonitorDO } from "./monitor/monitor-do";

export { ControlPlaneDO } from "./control-plane/control-plane-do";

export { DeployRunDO } from "./deploy/deploy-do";

// Exports are what workerd exposes on `ctx.exports` (`enable_ctx_exports`).
// SupervisorRPC comes from its declaring module, never `@nimbus-sh/sdk/worker`,
// whose root composes a hosted fabric first (first-write-wins per isolate).
export { SupervisorRPC } from "@nimbus-sh/worker/workspace-host";

async function serveApp(request: Request, env: Env): Promise<Response> {
  const suffix = previewHostSuffix(env);
  const asset = await env.ASSETS.fetch(request);

  const configured = suffix && asset.headers.get('content-type')?.includes('text/html')
    ? new HTMLRewriter().on('head', {
        element(element) {
          element.append(`<meta name="${previewSuffixMetaName()}" content="${suffix}">`, { html: true });
        },
      }).transform(asset)
    : asset;

  return withAppSecurityHeaders(
    configured,
    new URL(request.url),
    suffix ? `https://*.${suffix}` : null,
  );
}

function authError(request: Request, e: AuthError): Response {
  if (e.status === 401 && wantsHtml(request)) {
    const url = new URL(request.url);
    const login = new URL('/login', url.origin);
    login.searchParams.set('return_to', url.pathname + url.search + url.hash);

    return new Response(null, {
      status: 302,
      headers: { location: login.toString(), 'cache-control': 'no-store' },
    });
  }

  return new Response(JSON.stringify({ error: e.message }), {
    status: e.status,
    headers: { 'content-type': 'application/json' },
  });
}

function extractAgentName(pathname: string): string | null {
  let m = pathname.match(/^\/api\/workspaces\/([^/]+)/);

  if (m) return decodeURIComponent(m[1]);
  const orchestratorName = extractOrchestratorAgentName(pathname);

  if (orchestratorName) return orchestratorName;

  return null;
}

async function authenticateCliAgentTicketRequest(
  request: Request,
  env: Env,
): Promise<{ identity: AuthIdentity; request: Request } | Response | null> {
  const url = new URL(request.url);
  const agentName = extractTicketOrchestratorAgentName(url.pathname);
  const ticket = url.searchParams.get('ticket');

  if (!agentName || !ticket) return null;

  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response(JSON.stringify({ error: 'CLI agent tickets are only valid for WebSocket connections.' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const userId = parseCliAgentConnectTicketUserId(ticket);

  if (!userId) {
    return new Response(JSON.stringify({ error: 'Invalid CLI agent connect ticket.' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  try {
    const userDO = env.UserDO.get(env.UserDO.idFromName(userId));

    const verified = await userDO.verifyCliAgentConnectTicket(await ownerCaller(env), ticket, {
      userId,
      agentClass: ORCHESTRATOR_AGENT_SLUG,
      agentName,
      capability: 'agent.websocket',
    });

    if (!verified.ok || !verified.user) {
      return new Response(JSON.stringify({ error: verified.error ?? 'Invalid CLI agent connect ticket.' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }

    url.searchParams.delete('ticket');

    const identity: AuthIdentity = {
        userId: verified.user.id,
        email: verified.user.email,
        displayName: verified.user.displayName,
        sub: 'cli',
        provider: 'cli',
        authTime: Date.now(),
    };

    if (verified.scopes) identity.cliScopes = verified.scopes;

    // Persisted on the connection so revocation can name the socket.
    if (verified.tokenHash && verified.authGeneration !== undefined) {
      identity.cliBearer = { tokenHash: verified.tokenHash, generation: verified.authGeneration };
    }

    return {
      identity,
      request: new Request(url.toString(), request),
    };
  } catch (cause) {
    // A throw here is infrastructure, not a bad ticket: 500, not 401.
    return new Response(JSON.stringify({ error: renderThrownChain({ cause }) }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Per isolate: repeat in `scheduled` and every DO activation, which run in other isolates.
    installAnalyticsDiagnostics(env);
    const url = new URL(request.url);
    const upgrade = httpsUpgrade(url, env);

    if (upgrade) return upgrade;

    return withTransportSecurity(await route(request, env, ctx, url), url, env);
  },

  // Cloudflare Email Routing catch-all on EMAIL_DOMAIN.
  async email(message: ForwardableEmailMessage, env: Env) {
    await handleInboundEmail(message, env);
  },

  // Synthetic monitoring cron; a failed run must not take the schedule down.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    installAnalyticsDiagnostics(env);
    ctx.waitUntil((async () => {
      try {
        const monitor = env.MonitorDO.get(env.MonitorDO.idFromName(MONITOR_SINGLETON));
        const result = await monitor.check();

        if (result.failing.length > 0 || result.recovered.length > 0) {
          diagnostics.event('monitor.check_settled', {
            failing: result.failing.length,
            alerting: result.alerting.length,
            recovered: result.recovered.length,
            emails: result.emails,
            emailSkipped: result.skipped !== undefined,
          });
        }
      } catch (e) {
        diagnostics.failure('monitor.check_failed', toKinuError({
          doing: 'running the synthetic monitoring tick',
          cause: e,
          otherwise: 'unavailable',
        }));
      }
    })());
  },
} satisfies ExportedHandler<Env>;

function appendIdentityHeaders(h: Headers, identity: AuthIdentity): Headers {
  const next = new Headers(h);
  next.set(USER_ID_HEADER, identity.userId);

  if (identity.authTime) next.set(AUTH_TIME_HEADER, String(identity.authTime));
  // Identity headers are always rewritten from the verified identity so a
  // client can never smuggle or strip scopes, bearer, or session hash.
  next.delete(CLI_SCOPES_HEADER);

  if (identity.cliScopes) next.set(CLI_SCOPES_HEADER, identity.cliScopes.join(','));
  next.delete(CLI_BEARER_HEADER);

  if (identity.cliBearer) {
    next.set(CLI_BEARER_HEADER, `${identity.cliBearer.tokenHash}:${identity.cliBearer.generation}`);
  }

  next.delete(SESSION_BEARER_HEADER);

  if (identity.sessionTokenHash) {
    next.set(SESSION_BEARER_HEADER, identity.sessionTokenHash);
  }

  return next;
}

function wantsHtml(request: Request): boolean {
  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/agents/')) {
    return false;
  }

  const accept = request.headers.get('accept') ?? '';

  return request.method === 'GET' && (accept.includes('text/html') || accept.includes('*/*'));
}

/** Dev hosts (localhost, LAN) match neither and stay on plain HTTP. */
function isPublishedHost(url: URL, env: Env): boolean {
  if (isPreviewHostRequest(url, env)) return true;

  return url.hostname.toLowerCase() === hostOf(env.CLI_PUBLIC_ORIGIN);
}

/** Vite dev paths must never bypass auth on a published host. */
function isViteDevAssetPath(url: URL, env: Env): boolean {
  if (isPublishedHost(url, env)) return false;

  return ['/src/', '/@vite/', '/@fs/', '/node_modules/', '/.vite/']
    .some((prefix) => url.pathname.startsWith(prefix))
    || url.pathname === '/@react-refresh'
    || url.pathname === '/client-node-stubs.ts';
}

/** Nothing upstream redirects: measured 2026-08-16, plain HTTP reached the Worker
 *  and `url.protocol` is the client-facing scheme (no `CF-Visitor` needed). */
function httpsUpgrade(url: URL, env: Env): Response | null {
  if (url.protocol !== 'http:' || !isPublishedHost(url, env)) return null;

  // Drop the port: other plaintext ports have no TLS counterpart on this zone.
  return Response.redirect(`https://${url.hostname}${url.pathname}${url.search}`, 301);
}

const HSTS = 'max-age=31536000; includeSubDomains';

/** `includeSubDomains` deliberately covers preview hosts (the zone cert has the
 *  wildcard); no `preload`. 101 passes untouched: handshake headers are immutable. */
function withTransportSecurity(response: Response, url: URL, env: Env): Response {
  if (url.protocol !== 'https:' || response.status === 101 || !isPublishedHost(url, env)) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set('strict-transport-security', HSTS);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Share hosts are checked first so neither parser sees the other's input. */
async function routePreviewHost(request: Request, env: Env): Promise<Response> {
  const share = await handleSlateShareHostRequest(request, env);

  if (share) return containPreviewResponse(share);
  const nimbus = await handleNimbusPreviewHostRequest(request, env);

  if (nimbus) return containPreviewResponse(nimbus);

  return servePreviewRequest(request, env);
}

/** Every other code is a workspace failure: 500. */
const HOSTED_ACTOR_ROUTE_STATUS: Partial<Readonly<Record<ErrorCode, number>>> = {
  missing: 404,
  denied: 403,
};

async function route(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  // Preview hosts serve only previews: no session is ever minted there
  // (core preview/preview-origin.ts).
  if (isPreviewHostRequest(url, env)) return await routePreviewHost(request, env);

  if (url.pathname.startsWith("/pc/")) {
    return handlePcRequest(request, env);
  }

  // Cloudflare Access must run before every bypass (auth, public list, ASSETS,
  // DO writes) and only on `isControlPlaneSurface` paths, never previews or the app.
  let controlAccess: AccessIdentity | null = null;

  if (isControlPlaneSurface(url.pathname)) {
    const access = await verifyControlPlaneAccess(request, env);

    if (!access.ok) {
      reportAdminDenial(access.denial, url.pathname, request.method);

      return err(adminDenialStatus(access.denial), adminDenialMessage(access.denial));
    }

    controlAccess = access.access;
  }

  const appAuthResp = await handleAuthRequest(request, env, ctx);

  if (appAuthResp) return appAuthResp;

  const landingResp = await handleLandingRequest(request, env);

  if (landingResp) return landingResp;

  const cliResp = await handleCliRequest(request, env, ctx);

  if (cliResp) return cliResp;

  // Public: the deploy door is authorized by its run key, blueprints by a signed id.
  const publicResp = await firstResponse(request, [
    (req) => handleReleaseArtifactRequest(req, env.RELEASES_BUCKET),
    (req) => handleDeployRequest(req, env),
    (req) => handleHealthRequest(req, env),
    (req) => handleSharedPublicRequest(req, env),
  ]);

  if (publicResp) return publicResp;

  // MCP does its own auth: external clients cannot pass the browser-session gate.
  if (url.pathname.startsWith("/mcp/v1/")) {
    const mcpResp = await handleMcpRequest(request, env, mcpAgentResolver(env));

    if (mcpResp) return mcpResp;
  }

  if (isViteDevAssetPath(url, env)) {
    return serveApp(request, env);
  }

  if (isPublicPath(url.pathname)) {
    return serveApp(request, env);
  }

  // Webhook delivery: the URL's route capability is its gate.
  const webhookResp = await handleWebhookDeliveryRequest(request, env, webhookDeliveryResolver(env));

  if (webhookResp) return webhookResp;

  let identity: AuthIdentity;
  let authenticatedRequest = request;
  const cliAgentTicket = await authenticateCliAgentTicketRequest(request, env);

  if (cliAgentTicket instanceof Response) return cliAgentTicket;

  if (cliAgentTicket) {
    identity = cliAgentTicket.identity;
    authenticatedRequest = cliAgentTicket.request;
  } else {
    try { identity = await authenticateRequest(request, env); }
    catch (e) {
      if (e instanceof AuthError) return authError(request, e);
      const message = renderThrownChain({ cause: e });

      return new Response(JSON.stringify({ error: message }), {
        status: 500, headers: { 'content-type': 'application/json' },
      });
    }
  }

  const crossSite = crossSiteRejection(request);

  if (crossSite) return crossSite;

  // After CSRF so cross-site requests never feed the index; workspaces are
  // indexed only after the ownership check below.
  observeIdentity(env, identity, { retain: ctx });

  // Not public: reports carry screenshots, so it would be an anonymous upload endpoint.
  const feedbackResp = await handleFeedbackRequest(authenticatedRequest, env, identity);

  if (feedbackResp) return feedbackResp;

  // Not public: an unauthenticated writer would be a log-injection endpoint.
  const clientErrorResp = await handleClientErrorRequest(authenticatedRequest, env, identity);

  if (clientErrorResp) return clientErrorResp;

  // Admin authorization lives inside the module; entered only with a verified Access identity.
  if (controlAccess !== null) {
    const controlResp = await handleControlRequest(
      authenticatedRequest, env, identity, controlAccess,
    );

    if (controlResp) return controlResp;
  }

  // Account-authority endpoints answer first: they write owner_only UserDO methods.
  const accountResp = await firstResponse(authenticatedRequest, [
    (req) => handleAccountRequest(req, env, identity),
    (req) => handleUserRequest(req, env, identity, ctx),
    (req) => handleSharedRequest(req, env, identity),
    (req) => handleDriveRequest(req, env, identity),
    (req) => handleUpdatesRequest(req, env, identity),
  ]);

  if (accountResp) return accountResp;

  // Refuse any namespace/facet path outside the public actor grammar before SDK routing.
  if (isForeignAgentNamespacePath(url.pathname)) {
    return err(404, 'Not found');
  }

  const agentName = extractAgentName(url.pathname);

  if (agentName) {
    // routeAgentRequest maps every DO binding by slug; the rejection above keeps
    // UserDO and KinuSandbox unreachable.
    const claim = await claimOwnedWorkspace(env, identity.userId, agentName);

    if (!claim.ok) return err(claim.status, claim.error);

    observeWorkspaceUse(env, identity, agentName, { retain: ctx });

    const reqWithId = new Request(authenticatedRequest, {
      headers: appendIdentityHeaders(authenticatedRequest.headers, identity),
    });

    const agent = claim.agent;

    const eventsResp = await firstResponse(reqWithId, [
      (req) => handleWorkspaceOverviewRequest(req, () => agent.getWorkspaceOverview()),
      (req) => handleRunEventsRequest(req, runEventsResolver(env), REAL_CLOCK),
      (req) => handleEvalAbortRequest(req, identity, () => agent.evalAbortActivation()),
    ]);

    if (eventsResp) return eventsResp;
    const hubResp = await handleHubRequest(reqWithId, env, agentName, hubAgentResolver(env));

    if (hubResp) return hubResp;
    // Files and terminal bypass agent RPC: the chat socket's frame ceiling is too small.
    const filesResp = await handleFilesRequest(reqWithId, env, agentName);

    if (filesResp) return filesResp;
    const terminalResp = await handleTerminalRequest(reqWithId, terminalRouteDeps(env), agentName, ctx);

    if (terminalResp) return terminalResp;
    // Routed unchanged; only refuse names this workspace does not host.
    const hosted = hostedActorRoute(url.pathname);

    if (hosted) {
      const root = env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(agentName));
      const target = await root.resolveHostedActorRoute(hosted.name);

      if ('reason' in target) {
        return Response.json(target, { status: HOSTED_ACTOR_ROUTE_STATUS[target.reason] ?? 500 });
      }
    }

    const agentResp = await routeAgentRequest(reqWithId, env);

    if (agentResp) return agentResp;
  }

  return serveApp(request, env);
}
