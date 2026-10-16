/**
 * Worker entry: exports every DO class and routes, in order: HTTPS upgrade, preview hosts, `/api/`
 * (api/app.ts), /pc, Access (/control*), public routes, auth, CSRF, agent sockets.
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { Cause, Effect, Result } from "effect";
import { routeAgentRequest } from "agents";
import { tracing, WorkerEntrypoint } from 'cloudflare:workers';
import { adoptTracing } from '@nimbus-sh/platform/tracing.js';
import type { EgressStreams, EgressTlsTarget } from '@nimbus-sh/core/_shared/workspace-network.js';
import {
  containerEventResolver, GitHubEgressRecorder, handleContainerEgress, handleContainerEvent, handleEgressConnect, handleEgressTls,
  parseEgressParams, workspaceGrants, type KinuEgressParams,
} from './egress/outbound';
import { objectNamed, APP_ROUTES, ERROR_STATUS, PREVIEW_ENTRY_PATH } from "@kinu.run/core";
import { diagnostics, settle, toKinuError, type KinuError, settleLogged } from "@kinu.run/core/obs";
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
import { opsRoutes } from "./ops-routes";
import { handleInboundEmail } from "./email/handler";
import { MONITOR_SINGLETON } from "./monitor/monitor-do";
import { handleSlateShareHostRequest } from "./slate-share-route";
import { handleNimbusPreviewHostRequest, previewEntry } from "./nimbus-route";
import {
  crossSiteRejection, sessionGate,
  type AuthIdentity,
} from "./auth/session";
import { APP_FONTS_PATH, appFontFile, containPreviewResponse, hostOf, isPreviewHostRequest, serveApp, SLATE_FONTS_PATH } from "@kinu.run/core";
import { parseCliAgentConnectTicketUserId } from "./user/sessions";
import { accountTheme, DEFAULT_THEME, ownerCaller, THEME_CONFIG_KEY, type ThemeName } from "@kinu.run/core";
import { claimOwnedWorkspace } from "./user/workspace-ownership";
import { ownedWorkspace } from "./api/workspace";
import { err } from "@kinu.run/core";
import { controlPlaneAccess } from "./control-plane/admin-caller";
import { CONTROL_PLANE_UI_ROUTE } from "./control-plane/access-gate";
import { observeIdentity } from "./control-plane/index-feed";
import { installAnalyticsDiagnostics } from "@kinu.run/core/analytics";
import { api } from "./api/app";
import { beneath, familyMount, rawParam, rawPath, routeError, type ApiVariables, type FamilyEnv } from "./api/context";
import { keepDevboxGolden } from './devbox-golden';

const RELEASE_ARTIFACT_PATH = `/downloads/:artifact{${RELEASE_ARTIFACT_NAME}}`;

// The one actor-bearing DO class: every actor in a workspace shares its SQLite.
export { OrchestratorAgent } from "./orchestrator";

export { KinuDevbox } from "./kinu-devbox";


// Loopback egress for `eval` programs (codemode-egress.ts); absent, they have no network.
export { CodemodeEgress } from "./codemode-egress";

export { CodemodeLauncher } from "./codemode-sandbox";

export { SlateBinding } from "./slates/bindings";

export { DevboxGateway } from '@kinu.run/devbox';

/** The sandbox container's outbound HTTP, and a Nimbus workspace's egress (`NimbusWorkspaceOptions.egress`). */
export class KinuEgress extends WorkerEntrypoint<Env, KinuEgressParams> {
  override fetch(request: Request): Promise<Response> {
    const params = parseEgressParams(this.ctx);

    return handleContainerEgress(request, this.env, params, { grants: workspaceGrants(this.env), github: params && new GitHubEgressRecorder(this.env, this.ctx, params) });
  }

  /** A Nimbus workspace program's plain socket (`handleEgressConnect`); a container's raw sockets go straight out (D82). */
  override connect(socket: Socket): Promise<void> {
    return handleEgressConnect(socket, parseEgressParams(this.ctx));
  }

  /** A workspace program's TLS socket, made here (`handleEgressTls`); Nimbus calls it for each one. */
  connectTls(target: EgressTlsTarget): Promise<EgressStreams> {
    return handleEgressTls(target, parseEgressParams(this.ctx));
  }
}

export class KinuEvents extends WorkerEntrypoint<Env, KinuEgressParams> {
  override fetch(request: Request): Promise<Response> {
    return handleContainerEvent(request, containerEventResolver(this.env), parseEgressParams(this.ctx));
  }
}

export { AgentIsolateTail, AgentWorkspaceRPC } from "./agent-facets";

export { UserDO } from "./user/user-do";

// Mossaic Drive DOs, renamed to avoid clashing with `UserDO`; the SDK
// addresses them by binding name (`MOSSAIC_USER`, `MOSSAIC_SHARD`).
export { UserDO as MossaicUserDO, ShardDO as MossaicShardDO } from "@mossaic/sdk";

export { MonitorDO } from "./monitor/monitor-do";

export { GalleryDO } from "./gallery/gallery-do";

export { ControlPlaneDO } from "./control-plane/control-plane-do";

export { DeployRunDO } from "./deploy/deploy-do";

// Exports are what workerd exposes on `ctx.exports` (`enable_ctx_exports`).
// SupervisorRPC comes from its declaring module, never `@nimbus-sh/sdk/worker`,
// whose root composes a hosted fabric first (first-write-wins per isolate), nor
// `@nimbus-sh/worker/workspace-host`, whose re-exports put the whole hosted runtime
// (shell, npm engine, node runtime, facet manager) in every isolate's startup: it
// is imported where a workspace composes one (`workspace-host.ts`).
export { SupervisorRPC } from "@nimbus-sh/worker/session/supervisor-rpc";

// Without it Nimbus records no span: only its own Worker entry adopts.
adoptTracing(tracing);

function authenticateCliAgentTicketRequest(
  request: Request,
  env: Env,
): Effect.Effect<{ identity: AuthIdentity; request: Request } | Response | null, KinuError> {
  const url = new URL(request.url);
  const agentName = extractTicketOrchestratorAgentName(url.pathname);
  const ticket = url.searchParams.get('ticket');

  if (!agentName || !ticket) return Effect.succeed(null);

  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return Effect.succeed(err(400, 'CLI agent tickets are only valid for WebSocket connections.'));
  }

  const userId = parseCliAgentConnectTicketUserId(ticket);

  if (!userId) {
    return Effect.succeed(err(401, 'Invalid CLI agent connect ticket.'));
  }

  return Effect.catchCause(Effect.gen(function* () {
    const userDO = objectNamed(env.UserDO, userId);

    const verified = yield* Effect.promise(async () => userDO.verifyCliAgentConnectTicket(await ownerCaller(env), ticket, {
      userId,
      agentName,
    }));

    if (!verified.ok || !verified.user) {
      return err(401, verified.error ?? 'Invalid CLI agent connect ticket.');
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

    return published(response, url, env);
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
        const monitor = objectNamed(env.MonitorDO, MONITOR_SINGLETON);
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

/** The header naming the version of this Worker that answered a request. */
const VERSION_HEADER = 'x-kinu-version';

/** What every response a published host serves carries: HSTS, and the version that answered. `includeSubDomains`
 *  deliberately covers preview hosts (the zone cert has the wildcard); no `preload`. A new version reaches the edge
 *  over seconds, so the version a deploy's smoke test reads is the one that answered it, not the one it just uploaded
 *  (2026-10-08: 23 s after the deploy of b8340eebf, one of its requests was answered by the reset placeholder before
 *  it). 101 passes untouched: handshake headers are immutable. */
function published(response: Response, url: URL, env: Env): Response {
  if (url.protocol !== 'https:' || response.status === 101 || !isPublishedHost(url, env)) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set('strict-transport-security', HSTS);

  if (env.CF_VERSION_METADATA !== undefined) headers.set(VERSION_HEADER, env.CF_VERSION_METADATA.id);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Preview hosts serve only previews: no session is minted there. Share labels first, so neither parser sees the other's. */
const previewHost = new Hono<FamilyEnv<Env, object>>({ getPath: rawPath });

// The app's own faces, on every preview host's own origin, so a slate's page sets its text as the chat does; any other
// name under the path is the page's own to answer.
previewHost.get(`${SLATE_FONTS_PATH}:file`, async (c, next) => {
  const file = appFontFile(c.req.param('file'));

  return file === null ? await next() : await c.env.ASSETS.fetch(new Request(new URL(`${APP_FONTS_PATH}${file}`, c.req.url)));
});

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

/** `request`: a CLI ticket stripped. */
interface WorkerVariables extends ApiVariables {
  request: Request;
}

type WorkerEnv = FamilyEnv<Env, WorkerVariables>;

/** Registration order is dispatch order. */
const worker = new Hono<WorkerEnv>({ getPath: rawPath });

/** Each family mounts at the root, its declared bindings checked against `Env`. */
const mount = familyMount(worker);

const appShell = async (c: Context<WorkerEnv>): Promise<Response> => serveApp(c.req.raw, c.env);

/**
 * Behind sign-in: the page names the account's theme, so it paints in it on any device it opens on. The theme is only
 * a look: a read that fails is logged and the page is served in the default, never refused.
 */
const accountShell = async (c: Context<WorkerEnv>): Promise<Response> => serveApp(c.req.raw, c.env, {
  theme: async () => {
    let theme: ThemeName = DEFAULT_THEME;

    await settleLogged('app.theme_read_failed', { doing: "reading the account's theme for its page", otherwise: 'unavailable' }, async () => {
      const account = objectNamed(c.env.UserDO, c.get('identity').userId);

      theme = accountTheme(await account.getConfig(await ownerCaller(c.env), THEME_CONFIG_KEY));
    });

    return theme;
  },
});

worker.use('*', async (c, next) => (isPreviewHostRequest(new URL(c.req.url), c.env)
  ? await previewHost.fetch(c.req.raw, c.env, c.executionCtx)
  : await next()));

worker.all('/api/*', beneath<WorkerEnv>('/api', async (c) => api.fetch(c.req.raw, c.env, c.executionCtx)));

mount(pcRoutes);

// Before any session: its own pass (ops-routes.ts).
mount(opsRoutes);

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
// The Gallery and a shared slate's part frames are only their shell: their own routes decide what a visitor reads.
for (const path of ['/login', '/logout', DEPLOY_PAGE_PATH, '/gallery']) worker.all(path, appShell);

for (const prefix of ['/auth', '/assets', '/shared/blueprint', '/gallery', '/s']) worker.all(`${prefix}/*`, beneath<WorkerEnv>(prefix, appShell));

worker.use('*', (c, next) => settle(Effect.gen(function* () {
  const request = c.req.raw;
  const cliAgentTicket = yield* authenticateCliAgentTicketRequest(request, c.env);

  if (cliAgentTicket instanceof Response) return cliAgentTicket;
  // A CLI ticket is its own credential; the cross-site rule still holds over it.
  const identity = cliAgentTicket === null ? yield* sessionGate(request, c.env) : (crossSiteRejection(request) ?? cliAgentTicket.identity);

  if (identity instanceof Response) return identity;
  const routed = cliAgentTicket?.request ?? request;

  // After CSRF so cross-site requests never feed the index; workspaces are
  // indexed only after the ownership check below.
  observeIdentity(c.env, identity, { retain: c.executionCtx });
  c.set('identity', identity);
  c.set('request', routed);
  yield* Effect.promise(() => next());
})));

// Behind sign-in: a preview's owner is sent on to it with a ticket for its host, anyone else told it is not theirs.
worker.get(PREVIEW_ENTRY_PATH, async (c) => await previewEntry(c.req.raw, c.env, c.get('identity').userId));

worker.all('/agents/*', async (c, next) => {
  // Refuse any namespace/facet path outside the public actor grammar before SDK routing.
  if (isForeignAgentNamespacePath(c.req.path)) return err(404, 'Not found');

  const agentName = extractOrchestratorAgentName(c.req.path);

  if (!agentName) return next();

  // routeAgentRequest maps every DO binding by slug; the rejection above keeps
  // UserDO and KinuDevbox unreachable.
  const owned = await ownedWorkspace(c, c.get('identity'), agentName, c.get('request'));

  if (Result.isFailure(owned)) return owned.failure;
  const { agent, request } = owned.success;
  const hosted = hostedActorRoute(c.req.path);

  if (hosted === null) return (await routeAgentRequest(request, c.env)) ?? next();
  const target = await agent.resolveHostedActorRoute(hosted.name);

  if ('reason' in target) return Response.json(target, { status: ERROR_STATUS[target.reason] });
  const headers = new Headers(request.headers);

  headers.set(HOSTED_ACTOR_ID_HEADER, target.actorId);

  return (await routeAgentRequest(new Request(request, { headers }), c.env)) ?? next();
});

// A workspace's page wakes its object while the document, the app and its socket are still on the way: the claim
// the socket makes a moment later then finds it constructed. Cold, that construction measured 725 ms of a 3.2 s
// load (cmp-kinu-ux1, 2026-10-13). The socket's own claim, so a name the account does not hold wakes nothing; a
// failure is the socket's to answer, and here is only logged.
const workspacePage = async (c: Context<WorkerEnv>): Promise<Response> => {
  const workspace = c.req.param('agentId');

  if (workspace !== undefined) {
    c.executionCtx.waitUntil(settleLogged('workspace.page_wake_failed', { doing: "waking a workspace for its page", otherwise: 'unavailable' },
      async () => { await claimOwnedWorkspace(c.env, c.get('identity').userId, workspace); }));
  }

  return await accountShell(c);
};

worker.get(APP_ROUTES.workspace, workspacePage);

worker.get(`${APP_ROUTES.workspace}/*`, workspacePage);

worker.notFound(accountShell);

worker.onError(routeError);
