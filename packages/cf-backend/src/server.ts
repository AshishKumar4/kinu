/**
 * Worker entry point — exports all DO classes and routes agent requests.
 *
 * Routing order (Worker runs first for every non-hashed-asset path):
 *   1. proxyToSandbox — if the host is a preview URL (PORT-SANDBOX-TOKEN.host),
 *      forward to the sandbox container.
 *   2. /pc/* — PC agent WebSocket tunnel + install endpoint.
 *   3. /login, /auth/*, /logout, /api/auth/* — OAuth/OIDC app auth.
 *   4. / — public landing page when no Proteus session is present.
 *   5. /install, /install.sh, /downloads/proteus, /api/cli/* — CLI install/auth/API.
 *   6. /api/health — public build-info endpoint (no auth).
 *   6b. /mcp/v1/* — MCP server; CLI-bearer-token or session auth + ownership
 *       enforced inside (external MCP clients can't do browser OAuth).
 *   7. AUTH GATE — every other request needs a Proteus browser session
 *      (or DEV_USER_EMAIL in local/staging dev).
 *   8. /api/user/* — user-scoped (profile, agents, credentials, codex flow).
 *   9. /api/workspaces/<name>/* — owner check via UserDO.hasWorkspace.
 *   10. /agents/* — Think DOs (chat WebSocket).
 *   11. env.ASSETS fallback — SPA for everything else.
 */

import { routeAgentRequest } from "agents";
import { ORCHESTRATOR_AGENT_SLUG } from "@proteus/core";
import {
  extractOrchestratorAgentName,
  extractTicketOrchestratorAgentName,
  isForeignAgentNamespacePath,
} from "./agent-routing.js";
import { handlePcRequest } from "./pc-handler.js";
import { proxyPreviewRequest } from "./preview-proxy.js";
import { handleRunEventsRequest } from "./run-events-routes.js";
import { handleMcpRequest } from "./mcp-server.js";
import { handleHealthRequest } from "./health-route.js";
import { handleUserRequest } from "./user/routes.js";
import { handleCliRequest } from "./cli/routes.js";
import { handleAuthRequest } from "./auth/routes.js";
import { handleLandingRequest } from "./landing-route.js";
import { handleHubRequest } from "./events/routes.js";
import { handleInboundEmail } from "./email/handler.js";
import { handleNimbusPreviewRequest } from "./nimbus-route.js";
import {
  authenticateRequest, AuthError, isPublicPath,
  type AuthIdentity,
} from "./auth/session.js";
import { withD1Bookmark as withD1BookmarkCookie } from "./auth/d1-store.js";
import { parseCliAgentConnectTicketUserId } from "./user/user-do.js";
import { OWNER_SESSION } from "./user/workspace-capability.js";
import { CLI_SCOPES_HEADER } from "./cli/rpc-gate.js";
import { claimOwnedWorkspace } from "./user/workspace-access.js";
import { err } from "./lib/http.js";

/** Public webhook delivery endpoint match. `/api/workspaces/<name>/webhook/<id>` —
 *  the only `/api/workspaces/<name>/...` route that bypasses browser OAuth (it has
 *  its own per-trigger HMAC / Bearer / mTLS gate). */
function isWebhookDeliveryPath(pathname: string): boolean {
  return /^\/api\/workspaces\/[^/]+\/webhook\/[^/]+$/.test(pathname);
}

export { OrchestratorAgent } from "./orchestrator.js";
// ExplorationAgent is the single Facet class for parallel sub-agent work.
// MCTS mode: explore() / evaluate() / generateReflection() — short rollouts.
// Head mode: initHead() / runAsHead() / abortHead() — multi-step branching heads.
export { ExplorationAgent } from "./exploration.js";
export { SubordinateAgent } from "./subordinate-agent.js";
export { ProteusSandbox } from "./proteus-sandbox.js";
export { UserDO } from "./user/user-do.js";
export {
  NimbusSession,
  SupervisorRPC,
  NimbusAssetsRPC,
  NimbusLoaderRPC,
  NimbusLoadedWorker,
  NimbusLoadedEntrypoint,
  NimbusDurableObjectNamespace,
  NimbusDOStub,
  CirrusHmrRPC,
} from "@nimbus-sh/sdk/worker";

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

/** Verify the caller owns the agent named in the URL via the shared
 *  registry-membership + claimOwner policy. Returns a denial response or
 *  null when access is granted. */
async function ensureAgentOwnership(
  env: Env,
  identity: AuthIdentity,
  agentName: string,
): Promise<Response | null> {
  const result = await claimOwnedWorkspace(env, identity.userId, agentName);
  return result.ok ? null : err(result.status, result.error);
}

function extractAgentName(pathname: string): string | null {
  // /api/workspaces/<name>/...
  let m = pathname.match(/^\/api\/workspaces\/([^/]+)/);
  if (m) return decodeURIComponent(m[1]);
  // /agents/orchestrator-agent/<name>/...  (Think framework convention)
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
    const verified = await userDO.verifyCliAgentConnectTicket(OWNER_SESSION, ticket, {
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
    return {
      identity: {
        userId: verified.user.id,
        email: verified.user.email,
        displayName: verified.user.displayName,
        sub: 'cli',
        provider: 'cli',
        authTime: Date.now(),
        ...(verified.scopes ? { cliScopes: verified.scopes } : {}),
      },
      request: new Request(url.toString(), request),
    };
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // 1. Preview proxy — sandbox container, token-gated via URL itself.
    const previewResp = await proxyPreviewRequest(request, env);
    if (previewResp) return previewResp;

    // 2. PC agent tunnel — its own auth (short-lived ticket + UserDO token hash).
    if (url.pathname.startsWith("/pc/")) {
      return handlePcRequest(request, env);
    }

    // 3. OAuth/OIDC login, callback, session, logout.
    const appAuthResp = await handleAuthRequest(request, env, ctx);
    if (appAuthResp) return appAuthResp;

    // 4. Public landing page for visitors with no Proteus session.
    const landingResp = await handleLandingRequest(request, env);
    if (landingResp) return landingResp;

    // 5. CLI install + device-code auth + token-authenticated account API.
    const cliResp = await handleCliRequest(request, env, ctx);
    if (cliResp) return cliResp;

    // 6. Public — build-info health.
    const healthResp = await handleHealthRequest(request, env);
    if (healthResp) return healthResp;

    // 6b. MCP server — its own auth (CLI bearer token for external MCP
    //     clients, which can never pass the browser-session gate below;
    //     session/dev identity otherwise) + per-agent ownership inside.
    if (url.pathname.startsWith("/mcp/v1/")) {
      const mcpResp = await handleMcpRequest(request, env);
      if (mcpResp) return mcpResp;
    }

    // 7. Public bypass list.
    if (isPublicPath(url.pathname)) {
      return env.ASSETS.fetch(request);
    }

    // 7b. Webhook delivery — public-but-per-trigger-authenticated. The
    //     hub's webhook ingress (HMAC / Bearer / mTLS) is the gate.
    if (isWebhookDeliveryPath(url.pathname)) {
      const m = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/webhook\//);
      if (m) {
        const hubResp = await handleHubRequest(request, env, decodeURIComponent(m[1]));
        if (hubResp) return hubResp;
      }
    }

    // 8. Auth gate. Everything below requires an authenticated identity.
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
        return new Response(JSON.stringify({ error: (e as Error).message }), {
          status: 500, headers: { 'content-type': 'application/json' },
        });
      }
    }

    const nimbusResp = await handleNimbusPreviewRequest(authenticatedRequest, env, identity.userId);
    if (nimbusResp) return withD1Bookmark(nimbusResp, identity);

    // 9. /api/user/* — user-scoped routes.
    const userResp = await handleUserRequest(authenticatedRequest, env, identity, ctx);
    if (userResp) return withD1Bookmark(userResp, identity);

    // 10. Per-agent routes — reject every namespace/facet path outside the
    // closed public actor grammar before ownership lookup or SDK routing.
    if (isForeignAgentNamespacePath(url.pathname)) {
      return withD1Bookmark(err(404, 'Not found'), identity);
    }

    // Verify ownership of the root workspace. A direct subordinate facet is
    // owned through its parent workspace; extractAgentName returns that parent.
    const agentName = extractAgentName(url.pathname);
    if (agentName) {
      // SECURITY (F1): routeAgentRequest (partyserver) maps EVERY DO namespace
      // binding by slug, and its facet router recursively resolves literal
      // /sub/{class}/{name} segments. The closed-path rejection above keeps
      // UserDO, ExplorationAgent, ProteusSandbox and Nimbus* worker-side-only.
      const denial = await ensureAgentOwnership(env, identity, agentName);
      if (denial) return withD1Bookmark(denial, identity);
      // Inject the userId so downstream handlers can resolve UserDO without
      // re-running auth. Worker → DO requests preserve headers.
      const reqWithId = new Request(authenticatedRequest, {
        headers: appendIdentityHeaders(authenticatedRequest.headers, identity),
      });

      const runEventsResp = await handleRunEventsRequest(reqWithId, env);
      if (runEventsResp) return withD1Bookmark(runEventsResp, identity);
      // EventsHub authenticated routes: /triggers, /events
      const hubResp = await handleHubRequest(reqWithId, env, agentName);
      if (hubResp) return withD1Bookmark(hubResp, identity);
      const agentResp = await routeAgentRequest(reqWithId, env);
      if (agentResp) return withD1Bookmark(agentResp, identity);
    }

    // 11. SPA fallback.
    return withD1Bookmark(await env.ASSETS.fetch(request), identity);
  },

  // Mission Inbox — Cloudflare Email Routing (catch-all rule on EMAIL_DOMAIN)
  // delivers inbound mail here. Addressing, trust gating, and the turn wake
  // live in email/handler.ts + the agent's acceptEmailDelivery RPC.
  async email(message: ForwardableEmailMessage, env: Env) {
    await handleInboundEmail(message, env);
  },
} satisfies ExportedHandler<Env>;

function appendIdentityHeaders(h: Headers, identity: AuthIdentity): Headers {
  const next = new Headers(h);
  next.set('x-proteus-user-id', identity.userId);
  if (identity.authTime) next.set('x-proteus-auth-time', String(identity.authTime));
  // Always rewritten from the verified identity so a client can never smuggle
  // (or strip) the scope restriction the DO websocket boundary enforces.
  next.delete(CLI_SCOPES_HEADER);
  if (identity.cliScopes) next.set(CLI_SCOPES_HEADER, identity.cliScopes.join(','));
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

function withD1Bookmark(response: Response, identity: AuthIdentity): Response {
  if (response.status === 101) return response;
  return withD1BookmarkCookie(response, identity.d1Bookmark);
}
