/**
 * The main Worker's entry: exports every DO class and routes, in order: HTTPS upgrade, preview hosts, what the front
 * Worker answers too (front-routes.ts), `/api/` (api/app.ts), /pc, Access (/control*), public routes, auth.
 */

import { Hono, type MiddlewareHandler } from "hono";
import { getAgentByName } from "agents";
import { exports, tracing, WorkerEntrypoint } from 'cloudflare:workers';
import type { EgressStreams, EgressTlsTarget } from '@nimbus-sh/core/_shared/workspace-network.js';
import { adoptTracing } from '@nimbus-sh/platform/tracing.js';
import {
  containerEventResolver, handleContainerEvent, handleEgressConnect, handleEgressTls, parseEgressParams, parseEgressPrincipal,
  type EgressParams, type KinuEgressParams,
} from './egress/outbound';
import { forwardEgress, githubRecorder } from './egress/policy';
import { forwardNodeProgramCall, NODE_PROGRAM_HOST } from './node-program';
import type { OrchestratorAgent } from './orchestrator';
import { objectNamed, APP_ROUTES, PREVIEW_ENTRY_PATH } from "@kinu.run/core";
import { diagnostics, settleLogged } from "@kinu.run/core/obs";
import { releaseArtifact, releaseArtifactHead } from "@kinu.run/core";
import { DEPLOY_PAGE_PATH, DEVBOX_TOOLS_PART, RELEASE_ARTIFACT_NAME } from "@kinu.run/core/deploy";
import { servePreviewRequest } from "./preview-proxy";
import { AGENT_BUNDLE_DIRECTORY } from "./agent-facets";
import { mcpAgentResolver, mcpRoutes } from "./mcp-server";
import { cliPageRoutes } from "./cli/routes";
import { deployCallbackRoutes } from "./deploy/routes";
import { authPageRoutes } from "./auth/routes";
import { pcRoutes } from "./pc-routes";
import { opsRoutes } from "./ops-routes";
import { handleInboundMail } from "./mail/handler";
import { MONITOR_SINGLETON } from "./monitor/monitor-do";
import { handleSlateShareHostRequest } from "./slate-share-route";
import { handleNimbusPreviewHostRequest, previewEntry } from "./nimbus-route";
import { requestAccount, requestIdentity } from "./auth/session";
import { sessionRouteGate } from "./auth/request-gate";
import { APP_FONTS_PATH, appFontFile, containPreviewResponse, hostOf, httpsUpgrade, isPreviewHostRequest, isPublishedHost, mailHostRedirect, published, serveApp, SLATE_FONTS_PATH, VISITOR_SHELL } from "@kinu.run/core";
import { err } from "@kinu.run/core";
import { controlPlaneAccess } from "./control-plane/admin-caller";
import { CONTROL_PLANE_UI_ROUTE } from "./control-plane/access-gate";
import { installAnalyticsDiagnostics } from "@kinu.run/core/analytics";
import { api } from "./api/app";
import { beneath, familyMount, rawParam, rawPath, routeError, type ApiVariables, type FamilyEnv } from "./api/context";
import { keepDevboxGolden } from './devbox-golden';
import { appShell, frontRoutes } from './front-routes';
import { accountShell } from './user/account-pages';

const RELEASE_ARTIFACT_PATH = `/downloads/:artifact{${RELEASE_ARTIFACT_NAME}}`;

/** The computer's tools parts a self-deployment copies into its store bucket (`ReleaseComputer`). */
const DEVBOX_TOOLS_PATH = `/downloads/devbox-tools/:part{${DEVBOX_TOOLS_PART.slice('devbox-tools/'.length)}}`;

// The one actor-bearing DO class: every actor in a workspace shares its SQLite.
export { OrchestratorAgent } from "./orchestrator";

export { KinuDevbox } from "./kinu-devbox";


// Loopback egress for `eval` programs (codemode-egress.ts); absent, they have no network.
export { CodemodeEgress } from "./codemode-egress";

export { CodemodeLauncher } from "./codemode-sandbox";

export { SlateBinding } from "./slates/bindings";

export { PartBinding } from "./slates/part-binding";

export { DevboxGateway } from '@kinu.run/devbox';

/** The sandbox container's outbound HTTP, and a Nimbus workspace's egress (`NimbusWorkspaceOptions.egress`). */
export class KinuEgress extends WorkerEntrypoint<Env, EgressParams> {
  override fetch(request: Request): Promise<Response> {
    const principal = parseEgressPrincipal(this.ctx);

    // A Node program's namespace call (`node-program.ts`): no network has this host, so it never leaves.
    if (new URL(request.url).hostname === NODE_PROGRAM_HOST) {
      return forwardNodeProgramCall(request, principal, async (workspace) => await getAgentByName<Env, OrchestratorAgent>(this.env.OrchestratorAgent, workspace));
    }

    return forwardEgress(request, this.env, principal, { self: exports.default, github: githubRecorder(this.env.OrchestratorAgent, this.ctx), seam: 'container' });
  }

  /** A Nimbus workspace program's plain socket (`handleEgressConnect`); a container's raw sockets go straight out (D82). */
  override connect(socket: Socket): Promise<void> {
    return handleEgressConnect(socket, parseEgressPrincipal(this.ctx));
  }

  /** A workspace program's TLS socket, made here (`handleEgressTls`); Nimbus calls it for each one. */
  connectTls(target: EgressTlsTarget): Promise<EgressStreams> {
    return handleEgressTls(target, parseEgressPrincipal(this.ctx));
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
export { MossaicUserDO, MossaicShardDO } from "./drive/mossaic-objects";

export { MonitorDO } from "./monitor/monitor-do";

export { ControlPlaneDO } from "./control-plane/control-plane-do";

export { MailNameDO } from "./mail/mailname-do";

export { MailboxDO } from "./mail/mailbox-do";

export { DeployRunDO } from "./deploy/deploy-do";

export { CliAuthDO } from "./cli/auth-do";

// Exports are what workerd exposes on `ctx.exports` (`enable_ctx_exports`).
// SupervisorRPC comes from its declaring module, never `@nimbus-sh/sdk/worker`,
// whose root composes a hosted fabric first (first-write-wins per isolate), nor
// `@nimbus-sh/worker/workspace-host`, whose re-exports put the whole hosted runtime
// (shell, npm engine, node runtime, facet manager) in every isolate's startup: it
// is imported where a workspace composes one (`workspace-host.ts`).
export { SupervisorRPC } from "@nimbus-sh/worker/session/supervisor-rpc";

// Without it Nimbus records no span: only its own Worker entry adopts.
adoptTracing(tracing);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Per isolate: repeat in `scheduled` and every DO activation, which run in other isolates.
    installAnalyticsDiagnostics(env);
    const url = new URL(request.url);
    // First: mail.<domain> answers nothing of its own, and its host would otherwise read as a preview's.
    const mail = mailHostRedirect(url, hostOf(env.CLI_PUBLIC_ORIGIN));

    if (mail) return mail;
    const upgrade = httpsUpgrade(url, env);

    if (upgrade) return upgrade;

    const response = await worker.fetch(request, env, ctx);

    return published(response, url, env);
  },

  // Cloudflare Email Routing catch-all on EMAIL_DOMAIN: the one inbound mail path (mail/router.ts).
  async email(message: ForwardableEmailMessage, env: Env) {
    await handleInboundMail(message, env);
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

type WorkerEnv = FamilyEnv<Env, ApiVariables>;

/** Registration order is dispatch order. */
const worker = new Hono<WorkerEnv>({ getPath: rawPath });

/** Each family mounts at the root, its declared bindings checked against `Env`. */
const mount = familyMount(worker);

worker.use('*', async (c, next) => (isPreviewHostRequest(new URL(c.req.url), c.env)
  ? await previewHost.fetch(c.req.raw, c.env, c.executionCtx)
  : await next()));

// Ahead of every family: the front Worker answers these itself (front.ts), so both Workers answer them alike.
mount(frontRoutes<Env>(requestAccount));

worker.all('/api/*', beneath<WorkerEnv>('/api', async (c) => api.fetch(c.req.raw, c.env, c.executionCtx)));

mount(pcRoutes);

// Before any session: its own pass (ops-routes.ts).
mount(opsRoutes);

// Access before every bypass.
worker.use(CONTROL_PLANE_UI_ROUTE, controlPlaneAccess);

mount(authPageRoutes);

mount(cliPageRoutes);

// Public: release artifacts, and the deploy door's OAuth return, which its state cookie authorizes.
// Hono runs HEAD through the GET route.
worker.get(RELEASE_ARTIFACT_PATH, async (c) => await (c.req.method === 'HEAD' ? releaseArtifactHead : releaseArtifact)(c.env.RELEASES_BUCKET, rawParam(c, 'artifact')));

worker.all(RELEASE_ARTIFACT_PATH, async () => err(405, 'Method not allowed.'));

worker.get(DEVBOX_TOOLS_PATH, async (c) => await (c.req.method === 'HEAD' ? releaseArtifactHead : releaseArtifact)(c.env.RELEASES_BUCKET, `devbox-tools/${rawParam(c, 'part')}`));

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

// The Gallery's list is Explore's apps (owner, 2026-10-20); its address goes there, and a listed slate's page stays.
worker.get('/gallery', (c) => c.redirect(`${APP_ROUTES.explore}?kind=app`));

// Public: the blueprint page's data is signature-checked; the deploy page's run key is its authority.
// A listed slate's page, a live share's entry and a shared slate's part frames are only their shell: their own routes
// decide what a visitor reads, and whom a share admits.
// The connect finish page reads nothing of an account and says only what its address says: a sign-in that ends after
// its session expired must still reach it, tell the page that began it and close, not land on sign-in.
for (const path of ['/login', '/logout', DEPLOY_PAGE_PATH, APP_ROUTES.connected, '/privacy', '/terms']) worker.all(path, appShell);

for (const prefix of ['/auth', '/shared/blueprint', '/shared/live', '/gallery', '/s']) worker.all(`${prefix}/*`, beneath<WorkerEnv>(prefix, appShell));

/**
 * Explore is public. Signed out, its page is marked a visitor's, which the app draws under the public bar, reading nothing
 * of an account; signed in, it goes on through the gate to the account's own page, rail and theme. A session that could
 * not be read fails the request, which `routeError` records and answers by its class.
 */
const exploreShell: MiddlewareHandler<WorkerEnv> = async (c, next) =>
  (await requestIdentity(c.req.raw, c.env) === null ? serveApp(c.req.raw, c.env, VISITOR_SHELL) : next());

for (const path of [APP_ROUTES.explore, `${APP_ROUTES.explore}/*`]) worker.get(path, exploreShell);

worker.use('*', sessionRouteGate());

// Behind sign-in: a preview's owner is sent on to it with a ticket for its host, anyone else told it is not theirs.
worker.get(PREVIEW_ENTRY_PATH, async (c) => await previewEntry(c.req.raw, c.env, c.get('identity').userId));

worker.notFound(accountShell);

worker.onError(routeError);
