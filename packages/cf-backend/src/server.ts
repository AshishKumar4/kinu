/**
 * Worker entry point — exports all DO classes and routes agent requests.
 *
 * Routing order (Worker runs first for every non-hashed-asset path):
 *   1. proxyToSandbox — if the host is a preview URL (PORT-SANDBOX-TOKEN.host),
 *      forward to the sandbox container.
 *   2. /pc/* — PC agent WebSocket tunnel + install endpoint.
 *   3. /api/health — public build-info endpoint (no auth).
 *   4. AUTH GATE — every other request must carry a valid CF Access JWT
 *      (or DEV_USER_EMAIL in local dev). Public paths are listed in
 *      `isPublicPath`.
 *   5. /api/user/* — user-scoped (profile, agents, credentials, codex flow).
 *   6. /api/agents/<name>/* — owner check via UserDO.hasAgent.
 *   7. /agents/* — Think DOs (chat WebSocket).
 *   8. env.ASSETS fallback — SPA for everything else.
 */

import { routeAgentRequest } from "agents";
import { handlePcRequest } from "./pc-handler.js";
import { proxyPreviewRequest } from "./preview-proxy.js";
import { handleRunEventsRequest } from "./run-events-routes.js";
import { handleMcpRequest } from "./mcp-server.js";
import { handleHealthRequest } from "./health-route.js";
import { handleUserRequest } from "./user/routes.js";
import { handleHubRequest } from "./events/routes.js";
import {
  authenticateRequest, AccessAuthError, isPublicPath,
  type AccessIdentity,
} from "./auth/access.js";

/** Public webhook delivery endpoint match. `/api/agents/<name>/webhook/<id>` —
 *  the only `/api/agents/<name>/...` route that bypasses CF Access (it has
 *  its own per-trigger HMAC / Bearer / mTLS gate). */
function isWebhookDeliveryPath(pathname: string): boolean {
  return /^\/api\/agents\/[^/]+\/webhook\/[^/]+$/.test(pathname);
}

export { OrchestratorAgent } from "./orchestrator.js";
// ExplorationAgent is the single Facet class for parallel sub-agent work.
// MCTS mode: explore() / evaluate() / generateReflection() — short rollouts.
// Head mode: initHead() / runAsHead() / abortHead() — multi-step branching heads.
export { ExplorationAgent } from "./exploration.js";
export { ProteusSandbox } from "./proteus-sandbox.js";
export { UserDO } from "./user/user-do.js";

function authError(e: AccessAuthError): Response {
  return new Response(JSON.stringify({ error: e.message }), {
    status: e.status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Verify the caller owns the agent named in the URL. Returns 404 if the
 *  agent isn't in this user's registry. We auto-register on first POST so
 *  agent creation works, but other routes require it to already exist. */
async function ensureAgentOwnership(
  env: Env,
  identity: AccessIdentity,
  agentName: string,
  request: Request,
): Promise<Response | null> {
  const userDO = env.UserDO.get(env.UserDO.idFromName(identity.userId));
  if (!(await userDO.hasAgent(agentName))) {
    // Auto-register on the FIRST chat-or-RPC call against an agent. Browsers
    // that hit /agents/.../<name> for the first time get their agent recorded
    // in UserDO without a separate registration step.
    const ua = request.headers.get('user-agent') ?? '';
    const looksInteractive = ua.toLowerCase().includes('mozilla')
      || request.headers.get('upgrade')?.toLowerCase() === 'websocket';
    if (looksInteractive) {
      await userDO.registerAgent(agentName, agentName);
    } else {
      return new Response(JSON.stringify({ error: `Agent ${agentName} not in your registry. Create it via POST /api/user/agents first.` }), {
        status: 404, headers: { 'content-type': 'application/json' },
      });
    }
  }
  // Claim ownership on the orchestrator's own agent_soul. Idempotent;
  // throws if the agent is already owned by a different user — translate
  // to 403 for the caller, surfacing the real error so we can diagnose
  // boot/schema issues rather than masking them as "name taken".
  const orchestrator = env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(agentName));
  try {
    await orchestrator.claimOwner(identity.userId);
  } catch (e) {
    const msg = (e as Error).message ?? '';
    const status = /owned by a different user/i.test(msg) ? 403 : 500;
    console.error(`[server] claimOwner(${agentName}) failed:`, msg);
    return new Response(JSON.stringify({ error: msg }), {
      status, headers: { 'content-type': 'application/json' },
    });
  }
  return null;
}

function extractAgentName(pathname: string): string | null {
  // /api/agents/<name>/...
  let m = pathname.match(/^\/api\/agents\/([^/]+)/);
  if (m) return decodeURIComponent(m[1]);
  // /agents/orchestrator-agent/<name>/...  (Think framework convention)
  m = pathname.match(/^\/agents\/[^/]+\/([^/]+)/);
  if (m) return decodeURIComponent(m[1]);
  // /mcp/v1/<name>
  m = pathname.match(/^\/mcp\/v1\/([^/]+)/);
  if (m) return decodeURIComponent(m[1]);
  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // 1. Preview proxy — sandbox container, token-gated via URL itself.
    const previewResp = await proxyPreviewRequest(request, env);
    if (previewResp) return previewResp;

    // 2. PC agent tunnel — its own auth (token in connect message).
    if (url.pathname.startsWith("/pc/")) {
      return handlePcRequest(request, env);
    }

    // 3. Public — build-info health.
    const healthResp = handleHealthRequest(request);
    if (healthResp) return healthResp;

    // 4. Public bypass list.
    if (isPublicPath(url.pathname)) {
      return env.ASSETS.fetch(request);
    }

    // 4b. Webhook delivery — public-but-per-trigger-authenticated. The
    //     hub's webhook ingress (HMAC / Bearer / mTLS) is the gate.
    if (isWebhookDeliveryPath(url.pathname)) {
      const m = url.pathname.match(/^\/api\/agents\/([^/]+)\/webhook\//);
      if (m) {
        const hubResp = await handleHubRequest(request, env, decodeURIComponent(m[1]));
        if (hubResp) return hubResp;
      }
    }

    // 5. Auth gate. Everything below requires an authenticated identity.
    let identity: AccessIdentity;
    try { identity = await authenticateRequest(request, env); }
    catch (e) {
      if (e instanceof AccessAuthError) return authError(e);
      return new Response(JSON.stringify({ error: (e as Error).message }), {
        status: 500, headers: { 'content-type': 'application/json' },
      });
    }

    // 6. /api/user/* — user-scoped routes.
    const userResp = await handleUserRequest(request, env, identity);
    if (userResp) return userResp;

    // 7. Per-agent routes — verify ownership.
    const agentName = extractAgentName(url.pathname);
    if (agentName) {
      const denial = await ensureAgentOwnership(env, identity, agentName, request);
      if (denial) return denial;
      // Inject the userId so downstream handlers can resolve UserDO without
      // re-running auth. Worker → DO requests preserve headers.
      const reqWithId = new Request(request, {
        headers: appendHeader(request.headers, 'x-proteus-user-id', identity.userId),
      });

      const runEventsResp = await handleRunEventsRequest(reqWithId, env);
      if (runEventsResp) return runEventsResp;
      const mcpResp = await handleMcpRequest(reqWithId, env);
      if (mcpResp) return mcpResp;
      // EventsHub authenticated routes: /triggers, /events
      const hubResp = await handleHubRequest(reqWithId, env, agentName);
      if (hubResp) return hubResp;
      const agentResp = await routeAgentRequest(reqWithId, env);
      if (agentResp) return agentResp;
    }

    // 8. SPA fallback.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

function appendHeader(h: Headers, name: string, value: string): Headers {
  const next = new Headers(h);
  next.set(name, value);
  return next;
}
