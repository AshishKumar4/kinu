/**
 * Worker entry point — exports all DO classes and routes agent requests.
 *
 * Routing order (Worker runs first for every non-hashed-asset path):
 *   0. Transport — plain HTTP is redirected to HTTPS before anything is
 *      served, and every HTTPS response leaves pinned with HSTS.
 *   1. Preview host — every host under PREVIEW_HOST_SUFFIX serves an isolated
 *      Workspace or Sandbox preview and nothing else.
 *   2. /pc/* — PC agent WebSocket tunnel + install endpoint.
 *   3. /login, /auth/*, /logout, /api/auth/* — OAuth/OIDC app auth.
 *   4. / — public landing page when no Kinu session is present.
 *   5. /install, /install.sh, /downloads/kinu, /api/cli/* — CLI install/auth/API.
 *   6. /api/health — public build-info endpoint (no auth).
 *   6b. /mcp/v1/* — MCP server; CLI-bearer-token or session auth + ownership
 *       enforced inside (external MCP clients can't do browser OAuth).
 *   7. AUTH GATE — every other request needs a Kinu session
 *      (or DEV_USER_EMAIL in local/staging dev).
 *   8. /api/feedback — in-product feedback; any signed-in user.
 *   8b. /api/control/* — admin control plane; an allowlisted operator only, and
 *       a fresh sign-in for anything that mutates.
 *   9. /api/user/* — user-scoped (profile, agents, credentials, codex flow).
 *   10. /api/workspaces/<name>/* — owner check via UserDO.hasWorkspace.
 *   11. /agents/* — Think DOs (chat WebSocket).
 *   12. env.ASSETS fallback — SPA for everything else.
 */

import { routeAgentRequest } from "agents";
import { ORCHESTRATOR_AGENT_SLUG } from "@kinu.run/core";
import { diagnostics, renderThrownChain, toKinuError } from "@kinu.run/core/obs";
import {
  extractOrchestratorAgentName,
  extractTicketOrchestratorAgentName,
  isForeignAgentNamespacePath,
} from "./agent-routing";
import { handlePcRequest } from "./pc-handler";
import { servePreviewRequest } from "./preview-proxy";
import { handleRunEventsRequest } from "./run-events-routes";
import { handleMcpRequest } from "./mcp-server";
import { handleHealthRequest } from "./health-route";
import { handleUserRequest } from "./user/routes";
import { handleCliRequest } from "./cli/routes";
import { handleAuthRequest } from "./auth/routes";
import { handleLandingRequest } from "./landing-route";
import { handleHubRequest } from "./events/routes";
import { handleFilesRequest } from "./files-routes";
import { handleInboundEmail } from "./email/handler";
import { MONITOR_SINGLETON } from "./monitor/monitor-do";
import { handleNimbusPreviewHostRequest } from "./nimbus-route";
import {
  authenticateRequest, AuthError, crossSiteRejection, isPublicPath,
  type AuthIdentity,
} from "./auth/session";
import {
  containPreviewResponse, hostOf, isPreviewHostRequest, previewHostSuffix, previewSuffixMetaName,
} from "./lib/preview-origin";
import { withAppSecurityHeaders } from "./lib/security-headers";
import { parseCliAgentConnectTicketUserId } from "./user/user-do";
import { ownerCaller } from "./user/workspace-capability";
import { CLI_SCOPES_HEADER } from "./cli/rpc-gate";
import { claimOwnedWorkspace } from "./user/workspace-access";
import { err } from "./lib/http";
import { handleFeedbackRequest } from "./feedback/routes";
import { handleControlRequest } from "./control-plane/routes";
import { observeIdentity } from "./control-plane/index-feed";
import { installAnalyticsDiagnostics } from "./analytics/install";

/** Public webhook delivery endpoint match. `/api/workspaces/<name>/webhook/<id>` —
 *  the only `/api/workspaces/<name>/...` route that bypasses browser OAuth (it has
 *  its own per-trigger HMAC / Bearer / mTLS gate). */
function isWebhookDeliveryPath(pathname: string): boolean {
  return /^\/api\/workspaces\/[^/]+\/webhook\/[^/]+$/.test(pathname);
}

export { OrchestratorAgent } from "./orchestrator";
// ExplorationAgent is the single Facet class for parallel sub-agent work.
// MCTS mode: explore() / evaluate() / generateReflection() — short rollouts.
// Head mode: initHead() / runAsHead() / abortHead() — multi-step branching heads.
export { ExplorationAgent } from "./exploration";
export { SubordinateAgent } from "./subordinate-agent";
export { KinuSandbox } from "./kinu-sandbox";
// REQUIRED for outbound interception, and silent if forgotten. The Sandbox DO
// builds its interception fetchers from `ctx.exports.ContainerProxy`, so
// without this export `applyOutboundInterception` throws and no egress handler
// ever runs — meaning every request would leave the container unintercepted
// while the secret vault still believed it was substituting. Pinned by
// tests/unit-egress-interception.test.ts.
export { ContainerProxy } from "@cloudflare/sandbox";
export { UserDO } from "./user/user-do";
// Synthetic monitoring's durable state: open incidents + the alert outbox.
export { MonitorDO } from "./monitor/monitor-do";
// The admin control plane's index and audit log. One instance ("site").
export { ControlPlaneDO } from "./control-plane/control-plane-do";
// All nine are load-bearing, and only ONE is bound by `class_name`
// (NimbusSession). The other eight are resolved by workerd's
// `enable_ctx_exports`, which walks THIS module's exports and auto-populates
// loopback Service Bindings — Nimbus then looks them up by string key
// (`ctxExports.NimbusDOStub`), so a missing export is an absent property:
// no build error, no type error, a runtime failure when that path first runs.
// NimbusSession's own constructor captures them, because in prod the outer
// Worker and the DO are separate isolates. Our compatibility_date 2025-12-01
// clears the >= 2025-11-17 threshold by 14 days (Nimbus's inline "2026-04-01+"
// comments are its dogfood's date, not the real bound).
//
// Measured 2026-08-18, before deleting any of them for bundle size: the whole
// eight-export surface is 10.70 KiB gzip, 0.15% of a 6,983 KiB bundle, because
// nimbus-session.js re-exports the six binding shims from bindings.js and
// imports cirrus-real, so only supervisor-rpc.js is a distinct module at all.
// SupervisorRPC is the trap: the sole 6.29 KiB saving AND the only one that
// fails SILENTLY — loader-pool.js guards `if (ctxExports?.SupervisorRPC)` and
// skips wiring env.SUPERVISOR, so facets get undefined and npm/git break later
// with unrelated errors. The six shims at least throw by name. The real weight
// is the ~1,369 KiB NimbusSession subgraph (esbuild-wasm, sql.js,
// isomorphic-git), which is a dependency question, not an export-list one.
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

/** The SPA and every other static asset, under the app's document policy. */
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
    return {
      identity,
      request: new Request(url.toString(), request),
    };
  } catch (err) {
    return new Response(JSON.stringify({ error: renderThrownChain({ cause: err }) }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Composes the analytics sink onto the console logger for THIS isolate, so
    // core's dotted diagnostics events reach the fleet datasets as well as
    // Workers Logs. Idempotent per invocation. It has to be repeated in
    // `scheduled` and inside every Durable Object activation: a sink installed
    // in the Worker isolate is invisible to code running inside a DO, which is a
    // different isolate with its own module scope.
    installAnalyticsDiagnostics(env);
    const url = new URL(request.url);
    // Cleartext gets a redirect and nothing else; everything actually served
    // leaves through the one pin.
    const upgrade = httpsUpgrade(url, env);
    if (upgrade) return upgrade;
    return withTransportSecurity(await route(request, env, ctx, url), url, env);
  },

  // Mission Inbox — Cloudflare Email Routing (catch-all rule on EMAIL_DOMAIN)
  // delivers inbound mail here. Addressing, trust gating, and the turn wake
  // live in email/handler.ts + the agent's acceptEmailDelivery RPC.
  async email(message: ForwardableEmailMessage, env: Env) {
    await handleInboundEmail(message, env);
  },

  // Synthetic monitoring — the cron trigger in wrangler.jsonc. Probes the
  // public surface (health/build stamp, the CLI download checksum pair, the
  // sign-in page) and emails the owner when something breaks, so an outage is
  // self-reported rather than user-reported. All state and alert dedupe live
  // in MonitorDO; a failed run must not take the schedule down with it.
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
  next.set('x-kinu-user-id', identity.userId);
  if (identity.authTime) next.set('x-kinu-auth-time', String(identity.authTime));
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

/**
 * The hostnames this deployment publishes over HTTPS.
 *
 * Derived from the two vars that already state what this deployment is on the
 * internet — the same pair the preview router keys on — rather than from a new
 * flag or a hand-maintained private-address list. A dev server on localhost or
 * a LAN address matches neither and is left on plain HTTP, which is what makes
 * `vite dev` keep working with nothing to remember.
 */
function isPublishedHost(url: URL, env: Env): boolean {
  if (isPreviewHostRequest(url, env)) return true;
  return url.hostname.toLowerCase() === hostOf(env.CLI_PUBLIC_ORIGIN);
}

/** Vite's unbundled client graph exists only on an unpublished dev host.
 * Production serves hashed `/assets/*`; these paths must never bypass auth on
 * a published host. */
function isViteDevAssetPath(url: URL, env: Env): boolean {
  if (isPublishedHost(url, env)) return false;
  return ['/src/', '/@vite/', '/@fs/', '/node_modules/', '/.vite/']
    .some((prefix) => url.pathname.startsWith(prefix))
    || url.pathname === '/@react-refresh'
    || url.pathname === '/client-node-stubs.ts';
}

/**
 * Redirect cleartext to HTTPS.
 *
 * Nothing upstream does this: a zone carries no "Always Use HTTPS" rule by
 * default and a Workers custom domain does not add one, so plain-HTTP requests
 * reach the Worker and are answered in the clear. Measured against the
 * then-production origin on 2026-08-16: `http://<host>/install.sh` returned 200
 * and baked an `http://` download origin into the script it hands to `sh`.
 * `url.protocol` is the client-facing scheme at this edge, confirmed by that
 * same probe, so no `CF-Visitor` parsing is involved.
 */
function httpsUpgrade(url: URL, env: Env): Response | null {
  if (url.protocol !== 'http:' || !isPublishedHost(url, env)) return null;
  // The port is dropped rather than carried: Cloudflare's other plaintext
  // ports (8080, 2052, …) have no TLS counterpart on this zone.
  return Response.redirect(`https://${url.hostname}${url.pathname}${url.search}`, 301);
}

// One year: a pin that lapses between visits is not a pin.
const HSTS = 'max-age=31536000; includeSubDomains';

/**
 * Pin the browser to HTTPS for this host.
 *
 * `includeSubDomains` deliberately reaches the preview hosts. They are strict
 * subdomains of the app host (`isPreviewHostRequest` matches `.<suffix>` and
 * the app host is the suffix itself), they are matched before app auth, and
 * they serve agent-authored HTML — the hosts most worth pinning. Every one of
 * them is this same Worker behind the zone certificate, whose SANs include the
 * second-level wildcard, so subdomain inclusion cannot strand a preview on a
 * hostname that has no TLS. No `preload`: that is a one-way submission over the
 * whole subtree.
 *
 * 101 passes through untouched — a WebSocket handshake's headers are immutable
 * and its socket does not survive reconstruction (same rule, and reason, as
 * `containPreviewResponse`).
 */
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

/** The host-aware route table. Transport security is settled by the caller. */
async function route(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  // 1. Preview host — Workspace and Sandbox each get one hostname per exposed
  //    port, capability-gated by that hostname. It is the ONLY thing served there: no
  //    SPA, no login, no OAuth callback, so nothing ever mints a session on
  //    those origins and hostile preview HTML has none to steal
  //    (lib/preview-origin.ts).
  if (isPreviewHostRequest(url, env)) {
    const nimbus = await handleNimbusPreviewHostRequest(request, env);
    if (nimbus) return containPreviewResponse(nimbus);
    return servePreviewRequest(request, env);
  }

  // 2. PC agent tunnel — its own auth (short-lived ticket + UserDO token hash).
  if (url.pathname.startsWith("/pc/")) {
    return handlePcRequest(request, env);
  }

  // 3. OAuth/OIDC login, callback, session, logout.
  const appAuthResp = await handleAuthRequest(request, env, ctx);
  if (appAuthResp) return appAuthResp;

  // 4. Public landing page for visitors with no Kinu session.
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

  // Vite's source modules are public assets only on a local dev host. Without
  // this, the landing document loads but every hydration/CSS request receives
  // the sign-in page from the auth gate below.
  if (isViteDevAssetPath(url, env)) {
    return serveApp(request, env);
  }

  // 7. Public bypass list.
  if (isPublicPath(url.pathname)) {
    return serveApp(request, env);
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
      const message = renderThrownChain({ cause: e });
      return new Response(JSON.stringify({ error: message }), {
        status: 500, headers: { 'content-type': 'application/json' },
      });
    }
  }

  // 8b. CSRF. Everything below is reachable with the ambient session cookie,
  //     so a state-changing request must prove the app issued it.
  const crossSite = crossSiteRejection(request);
  if (crossSite) return crossSite;

  // The control-plane index learns who exists from the request path, retained so
  // it never delays a response and memoised per isolate so it is not a Durable
  // Object round trip per request. Every row it writes is a derived fact whose
  // source of truth is a UserDO, which is why a dropped observation costs a
  // briefly stale operator list and nothing else. Placed after the CSRF gate so
  // a cross-site request never feeds it.
  observeIdentity(env, identity, {
    workspace: extractAgentName(url.pathname),
    retain: ctx,
  });

  // 8. /api/feedback — any signed-in user may file a report. Deliberately not on
  //    the public bypass list: a report carries a screenshot of a signed-in
  //    session, so an unauthenticated writer would be an anonymous upload
  //    endpoint.
  const feedbackResp = await handleFeedbackRequest(authenticatedRequest, env, identity);
  if (feedbackResp) return feedbackResp;

  // 8b. /api/control/* — the admin control plane. The allowlist, the
  //     dev-identity refusal and the step-up window all live inside that module,
  //     never here: a route whose authorization is performed by its caller is one
  //     refactor away from being unguarded.
  const controlResp = await handleControlRequest(authenticatedRequest, env, identity);
  if (controlResp) return controlResp;

  // 9. /api/user/* — user-scoped routes.
  const userResp = await handleUserRequest(authenticatedRequest, env, identity, ctx);
  if (userResp) return userResp;

  // 10. Per-agent routes — reject every namespace/facet path outside the
  // closed public actor grammar before ownership lookup or SDK routing.
  if (isForeignAgentNamespacePath(url.pathname)) {
    return err(404, 'Not found');
  }

  // Verify ownership of the root workspace. A direct subordinate facet is
  // owned through its parent workspace; extractAgentName returns that parent.
  const agentName = extractAgentName(url.pathname);
  if (agentName) {
    // SECURITY (F1): routeAgentRequest (partyserver) maps EVERY DO namespace
    // binding by slug, and its facet router recursively resolves literal
    // /sub/{class}/{name} segments. The closed-path rejection above keeps
    // UserDO, ExplorationAgent, KinuSandbox and Nimbus* worker-side-only.
    const denial = await ensureAgentOwnership(env, identity, agentName);
    if (denial) return denial;
    // Inject the userId so downstream handlers can resolve UserDO without
    // re-running auth. Worker → DO requests preserve headers.
    const reqWithId = new Request(authenticatedRequest, {
      headers: appendIdentityHeaders(authenticatedRequest.headers, identity),
    });

    const runEventsResp = await handleRunEventsRequest(reqWithId, env);
    if (runEventsResp) return runEventsResp;
    // EventsHub authenticated routes: /triggers, /events
    const hubResp = await handleHubRequest(reqWithId, env, agentName);
    if (hubResp) return hubResp;
    // File uploads: HTTP rather than an agent RPC, because the RPC transport
    // is the chat WebSocket and its frame ceiling is below ordinary files.
    const filesResp = await handleFilesRequest(reqWithId, env, agentName);
    if (filesResp) return filesResp;
    const agentResp = await routeAgentRequest(reqWithId, env);
    if (agentResp) return agentResp;
  }

  // 11. SPA fallback.
  return serveApp(request, env);
}
