/**
 * Worker entry: exports every DO class and routes, in order: HTTPS upgrade, preview hosts, `/api/`
 * (api/app.ts), /pc, Access (/control*), public routes, auth, CSRF, agent sockets.
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { Cause, Effect, Result } from "effect";
import { routeAgentRequest } from "agents";
import { tracing, WorkerEntrypoint } from 'cloudflare:workers';
import { adoptTracing } from '@nimbus-sh/platform/tracing.js';
import { containerEventResolver, handleContainerEgress, handleContainerEvent, parseEgressParams, type KinuEgressParams } from './egress/outbound';
import { ORCHESTRATOR_AGENT_SLUG } from "@kinu.run/core";
import { diagnostics, settle, toKinuError, type ErrorCode, type KinuError, settleLogged } from "@kinu.run/core/obs";
import {
  extractOrchestratorAgentName,
  extractTicketOrchestratorAgentName,
  isForeignAgentNamespacePath, hostedActorRoute, HOSTED_ACTOR_ID_HEADER,
} from "@kinu.run/core";
import { releaseArtifact, releaseArtifactHead } from "@kinu.run/core";
import { DEPLOY_PAGE_PATH, RELEASE_ARTIFACT_NAME } from "@kinu.run/core/deploy";
import { servePreviewRequest } from "./preview-proxy";
import { AGENT_BUNDLE_DIRECTORY } from "./agent-facets";
import { mcpAgentResolver, mcpRoutes } from "./mcp-server";
import { cliPageRoutes } from "./cli/routes";
import { deployCallbackRoutes } from "./deploy/routes";
import { authPageRoutes } from "./auth/routes";
import { landingRoutes } from "./landing-route";
import { pcRoutes } from "./pc-routes";
import { handleInboundEmail } from "./email/handler";
import { MONITOR_SINGLETON } from "./monitor/monitor-do";
import { handleSlateShareHostRequest } from "./slate-share-route";
import { handleNimbusPreviewHostRequest } from "./nimbus-route";
import {
  authenticateRequest, AuthError, crossSiteRejection,
  type AuthIdentity,
} from "./auth/session";
import { containPreviewResponse, hostOf, isPreviewHostRequest, serveApp } from "@kinu.run/core";
import { parseCliAgentConnectTicketUserId } from "./user/user-do";
import { ownerCaller } from "@kinu.run/core";
import { appendIdentityHeaders } from "./cli/rpc-gate";
import { claimOwnedWorkspace } from "./user/workspace-ownership";
import { err } from "@kinu.run/core";
import { controlPlaneAccess } from "./control-plane/admin-caller";
import { CONTROL_PLANE_UI_ROUTE } from "./control-plane/access-gate";
import { observeIdentity, observeWorkspaceUse } from "./control-plane/index-feed";
import { installAnalyticsDiagnostics } from "@kinu.run/core/analytics";
import { api } from "./api/app";
import { beneath, rawParam, rawPath, routeError, type ApiVariables, type FamilyEnv } from "./api/context";
import { keepDevboxGolden } from './devbox-golden';

const RELEASE_ARTIFACT_PATH = `/downloads/:artifact{${RELEASE_ARTIFACT_NAME}}`;

// The one actor-bearing DO class: every actor in a workspace shares its SQLite.
export { OrchestratorAgent } from "./orchestrator";

export { KinuDevbox } from "./kinu-devbox";

export { CodexEgress } from "./egress/codex-egress";

// Loopback egress for `eval` programs (codemode-egress.ts); absent, they have no network.
export { CodemodeEgress } from "./codemode-egress";

export { CodemodeLauncher } from "./codemode-sandbox";

export { SlateBinding } from "./slates/bindings";

export { DevboxOutbound, DevboxStoreGateway } from '@kinu.run/devbox';

export class KinuEgress extends WorkerEntrypoint<Env, KinuEgressParams> {
  override fetch(request: Request): Promise<Response> {
    return handleContainerEgress(request, this.env, parseEgressParams(this.ctx));
  }
}

export class KinuEvents extends WorkerEntrypoint<Env, KinuEgressParams> {
  override fetch(request: Request): Promise<Response> {
    return handleContainerEvent(request, containerEventResolver(this.env), parseEgressParams(this.ctx));
  }
}

export { AgentWorkspaceRPC } from "./agent-facets";

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

// Without it Nimbus records no span: only its own Worker entry adopts.
adoptTracing(tracing);

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

function authenticateCliAgentTicketRequest(
  request: Request,
  env: Env,
): Effect.Effect<{ identity: AuthIdentity; request: Request } | Response | null, KinuError> {
  const url = new URL(request.url);
  const agentName = extractTicketOrchestratorAgentName(url.pathname);
  const ticket = url.searchParams.get('ticket');

  if (!agentName || !ticket) return Effect.succeed(null);

  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return Effect.succeed(new Response(JSON.stringify({ error: 'CLI agent tickets are only valid for WebSocket connections.' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }));
  }

  const userId = parseCliAgentConnectTicketUserId(ticket);

  if (!userId) {
    return Effect.succeed(new Response(JSON.stringify({ error: 'Invalid CLI agent connect ticket.' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }));
  }

  return Effect.catchCause(Effect.gen(function* () {
    const userDO = env.UserDO.get(env.UserDO.idFromName(userId));

    const verified = yield* Effect.promise(async () => userDO.verifyCliAgentConnectTicket(await ownerCaller(env), ticket, {
      userId,
      agentClass: ORCHESTRATOR_AGENT_SLUG,
      agentName,
      capability: 'agent.websocket',
    }));

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
  }), (failed) => Effect.fail(
    // A failure here is infrastructure, not a bad ticket: the router's `onError` answers its class, not 401.
    toKinuError({ doing: 'verifying a CLI agent connect ticket', cause: Cause.squash(failed), otherwise: 'io' }),
  ));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Per isolate: repeat in `scheduled` and every DO activation, which run in other isolates.
    installAnalyticsDiagnostics(env);
    const url = new URL(request.url);
    const upgrade = httpsUpgrade(url, env);

    if (upgrade) return upgrade;

    const response = await worker.fetch(request, env, ctx);

    return withTransportSecurity(response, url, env);
  },

  // Cloudflare Email Routing catch-all on EMAIL_DOMAIN.
  async email(message: ForwardableEmailMessage, env: Env) {
    await handleInboundEmail(message, env);
  },

  // Synthetic monitoring cron; a failed run must not take the schedule down.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    installAnalyticsDiagnostics(env);
    ctx.waitUntil(keepDevboxGolden(env.KinuDevbox));
    ctx.waitUntil((async () => {
      await settleLogged('monitor.check_failed', { doing: 'running the synthetic monitoring tick', otherwise: 'unavailable' }, async () => {
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
      });
    })());
  },
} satisfies ExportedHandler<Env>;

function wantsHtml(request: Request): boolean {
  if (new URL(request.url).pathname.startsWith('/agents/')) return false;

  const accept = request.headers.get('accept') ?? '';

  return request.method === 'GET' && (accept.includes('text/html') || accept.includes('*/*'));
}

/** Dev hosts (localhost, LAN) match neither and stay on plain HTTP. */
function isPublishedHost(url: URL, env: Env): boolean {
  if (isPreviewHostRequest(url, env)) return true;

  return url.hostname.toLowerCase() === hostOf(env.CLI_PUBLIC_ORIGIN);
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

/** Preview hosts serve only previews: no session is minted there. Share labels first, so neither parser sees the other's. */
const previewHost = new Hono<FamilyEnv<Env, object>>({ getPath: rawPath });

previewHost.use('*', async (c, next) => {
  const share = await handleSlateShareHostRequest(c.req.raw, c.env);

  return share === null ? await next() : containPreviewResponse(share);
});

previewHost.use('*', async (c, next) => {
  const nimbus = await handleNimbusPreviewHostRequest(c.req.raw, c.env);

  return nimbus === null ? await next() : containPreviewResponse(nimbus);
});

previewHost.all('*', async (c) => await servePreviewRequest(c.req.raw, c.env));

previewHost.onError(routeError);

/** Every other code is a workspace failure: 500. */
const HOSTED_ACTOR_ROUTE_STATUS: Partial<Readonly<Record<ErrorCode, number>>> = {
  missing: 404,
  denied: 403,
};

/** `request`: a CLI ticket stripped. */
interface WorkerVariables extends ApiVariables {
  request: Request;
}

type WorkerEnv = FamilyEnv<Env, WorkerVariables>;

/** Registration order is dispatch order. */
const worker = new Hono<WorkerEnv>({ getPath: rawPath });

function mount<Bindings extends object, Variables extends object>(
  family: Hono<FamilyEnv<Bindings, Variables>> & (Env extends Bindings ? unknown : never),
): void {
  worker.route('/', family);
}

const appShell = async (c: Context<WorkerEnv>): Promise<Response> => serveApp(c.req.raw, c.env);

worker.use('*', async (c, next) => (isPreviewHostRequest(new URL(c.req.url), c.env)
  ? await previewHost.fetch(c.req.raw, c.env, c.executionCtx)
  : await next()));

worker.all('/api/*', beneath<WorkerEnv>('/api', async (c) => api.fetch(c.req.raw, c.env, c.executionCtx)));

mount(pcRoutes);

// Access before every bypass.
worker.use(CONTROL_PLANE_UI_ROUTE, controlPlaneAccess);

mount(authPageRoutes);

mount(landingRoutes);

mount(cliPageRoutes);

// Public: release artifacts, and the deploy door's OAuth return, which its state cookie authorizes.
// Hono runs HEAD through the GET route.
worker.get(RELEASE_ARTIFACT_PATH, async (c) => await (c.req.method === 'HEAD' ? releaseArtifactHead : releaseArtifact)(c.env.RELEASES_BUCKET, rawParam(c, 'artifact')));

worker.all(RELEASE_ARTIFACT_PATH, async () => err(405, 'Method not allowed.'));

mount(deployCallbackRoutes);

// MCP does its own auth: external clients cannot pass the browser-session gate.
mount(mcpRoutes(mcpAgentResolver));

/** Vite dev paths never bypass auth on a published host. */
const viteDevAsset: MiddlewareHandler<WorkerEnv> = async (c, next) =>
  (isPublishedHost(new URL(c.req.url), c.env) ? next() : serveApp(c.req.raw, c.env));

for (const prefix of ['/src', '/@vite', '/@fs', '/node_modules', '/.vite']) {
  worker.all(`${prefix}/*`, beneath<WorkerEnv>(prefix, viteDevAsset));
}

worker.all('/@react-refresh', viteDevAsset);

worker.all('/client-node-stubs.ts', viteDevAsset);

worker.all(`${AGENT_BUNDLE_DIRECTORY}/*`, () => new Response('Not found', { status: 404 }));

// Public: the blueprint page's data is signature-checked; the deploy page's run key is its authority.
for (const path of ['/login', '/logout', DEPLOY_PAGE_PATH]) worker.all(path, appShell);

for (const prefix of ['/auth', '/assets', '/shared/blueprint']) worker.all(`${prefix}/*`, beneath<WorkerEnv>(prefix, appShell));

worker.use('*', (c, next) => settle(Effect.gen(function* () {
  const request = c.req.raw;
  let identity: AuthIdentity;
  let routed = request;
  const cliAgentTicket = yield* authenticateCliAgentTicketRequest(request, c.env);

  if (cliAgentTicket instanceof Response) return cliAgentTicket;

  if (cliAgentTicket) {
    identity = cliAgentTicket.identity;
    routed = cliAgentTicket.request;
  } else {
    const authenticated = yield* Effect.catchCause(Effect.promise(() => authenticateRequest(request, c.env)), (failed) => {
      const e = Cause.squash(failed);

      return e instanceof AuthError ? Effect.succeed(authError(request, e)) : Effect.failCause(failed);
    });

    if (authenticated instanceof Response) return authenticated;
    identity = authenticated;
  }

  const crossSite = crossSiteRejection(request);

  if (crossSite) return crossSite;

  // After CSRF so cross-site requests never feed the index; workspaces are
  // indexed only after the ownership check below.
  observeIdentity(c.env, identity, { retain: c.executionCtx });
  c.set('identity', identity);
  c.set('request', routed);
  yield* Effect.promise(() => next());
})));

worker.all('/agents/*', async (c, next) => {
  // Refuse any namespace/facet path outside the public actor grammar before SDK routing.
  if (isForeignAgentNamespacePath(c.req.path)) return err(404, 'Not found');

  const agentName = extractOrchestratorAgentName(c.req.path);

  if (!agentName) return next();

  // routeAgentRequest maps every DO binding by slug; the rejection above keeps
  // UserDO and KinuDevbox unreachable.
  const identity = c.get('identity');
  const claim = await claimOwnedWorkspace(c.env, identity.userId, agentName);

  if (Result.isFailure(claim)) return err(claim.failure.status, claim.failure.error);

  observeWorkspaceUse(c.env, identity, agentName, { retain: c.executionCtx });

  const routed = c.get('request');
  const headers = appendIdentityHeaders(routed.headers, identity);

  const hosted = hostedActorRoute(c.req.path);

  if (hosted) {
    const root = c.env.OrchestratorAgent.get(c.env.OrchestratorAgent.idFromName(agentName));
    const target = await root.resolveHostedActorRoute(hosted.name);

    if ('reason' in target) {
      return Response.json(target, { status: HOSTED_ACTOR_ROUTE_STATUS[target.reason] ?? 500 });
    }

    headers.set(HOSTED_ACTOR_ID_HEADER, target.actorId);
  }

  return (await routeAgentRequest(new Request(routed, { headers }), c.env)) ?? next();
});

worker.notFound(appShell);

worker.onError(routeError);
