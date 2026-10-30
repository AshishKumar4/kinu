/** `/api/*` as one Hono app: registration order is dispatch order, so this file's order is the gate order. */
import { Hono, type ExecutionContext as HonoExecutionContext } from 'hono';
import { getAgentByName } from 'agents';
import type { OrchestratorAgent } from '../orchestrator';
import { CLIENT_ERROR_ENDPOINT, healthResponse, REAL_CLOCK, serveApp } from '@kinu.run/core';
import { crossSiteRejection, requestIdentity } from '../auth/session';
import { sessionRouteGate } from '../auth/request-gate';
import { authApiRoutes } from '../auth/routes';
import { builtinAccountRoutes, builtinAuthRoutes } from '../auth/builtin';
import { CONTROL_PLANE_API_ROUTE } from '../control-plane/access-gate';
import { controlPlaneAccess } from '../control-plane/admin-caller';
import { controlRoutes } from '../control-plane/routes';
import { cliRoutes } from '../cli/routes';
import { aiProxyRoutes } from '../user/ai-proxy';
import { webSearchRoutes } from '../user/web-search-route';
import { providerProxyRoutes } from '../user/provider-proxy';
import { accountRoutes } from '../user/account-routes';
import { mailHandRoutes, mailRoutes } from '../mail/routes';
import { consentRoutes } from '../slates/consent-routes';
import { userRoutes } from '../user/routes';
import { deployRoutes } from '../deploy/routes';
import { updatesRoutes } from '../updates/routes';
import { sharedPublicRoutes, sharedRoutes } from '../shared/routes';
import { galleryRoutes } from '../gallery/routes';
import { partRoutes } from '../slates/part-routes';
import { driveRoutes } from '../drive/routes';
import { feedbackRoutes } from '../feedback/routes';
import { clientErrorRoutes } from '../client-error/route';
import { hubRoutes, webhookDeliveryRoutes } from '../events/routes';
import { runEventsRoutes } from '../run-events-routes';
import { evalAbortRoutes } from '../eval/abort-route';
import { activationRoutes } from './activations-route';
import { wakeRoutes } from './wake-route';
import { filesRoutes } from '../files-routes';
import { terminalRouteDeps, terminalRoutes } from '../terminal-route';
import { routeError, apiPath, beneath, familyMount, type FamilyEnv } from './context';
import { workspaceGate, type ClaimedWorkspace } from './workspace';

const app = new Hono<FamilyEnv<Env>>({ getPath: apiPath });

/** Each family mounts at the root, its declared bindings checked against `Env`. */
const mount = familyMount(app);

// Access before every bypass on the admin API.
app.use(CONTROL_PLANE_API_ROUTE, controlPlaneAccess);

mount(authApiRoutes);

mount(builtinAuthRoutes);

mount(aiProxyRoutes);

// The deployment's own web search, behind the same CLI bearer gate as the inference proxy.
mount(webSearchRoutes);

mount(providerProxyRoutes);

mount(cliRoutes);

mount(deployRoutes);

app.get('/api/health', async (c) => healthResponse(c.req.raw, c.env));

mount(sharedPublicRoutes);

mount(galleryRoutes);

// Unanswered public paths are the app shell's.
app.all('/api/health', async (c) => serveApp(c.req.raw, c.env));

app.all('/api/auth/*', beneath<FamilyEnv<Env>>('/api/auth', async (c) => serveApp(c.req.raw, c.env)));

// Delivery is public: no gate claimed the workspace, so it reaches the object itself.
mount(webhookDeliveryRoutes((env: Env) => (name: string) => getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, name)));

// Ahead of the session gate: a crash on a page anyone may open is reported too. A live session behind a report is read
// here as the gate reads it, the cross-site rule with it; no session is no refusal.
app.use(CLIENT_ERROR_ENDPOINT, async (c, next) => {
  const crossSite = crossSiteRejection(c.req.raw);

  if (crossSite !== null) return crossSite;
  const identity = await requestIdentity(c.req.raw, c.env);

  if (identity !== null) c.set('identity', identity);
  await next();
});

mount(clientErrorRoutes);

app.use('/api/*', sessionRouteGate());

mount(feedbackRoutes);

mount(controlRoutes);

// Ahead of userRoutes: owner_only account methods.
mount(accountRoutes);

// Ahead of userRoutes' catch-all: the person's own mail, from their account's Mailbox.
mount(mailRoutes);

mount(consentRoutes);

mount(builtinAccountRoutes);

mount(userRoutes);

mount(sharedRoutes);

mount(partRoutes);

mount(driveRoutes);

mount(updatesRoutes);

app.use('/api/workspaces/:name/*', workspaceGate);

mount(runEventsRoutes<Env, ClaimedWorkspace>(REAL_CLOCK));

mount(evalAbortRoutes);

mount(activationRoutes);

mount(wakeRoutes);

mount(mailHandRoutes);

mount(hubRoutes<Env, ClaimedWorkspace>());

mount(filesRoutes<Env, ClaimedWorkspace>());

mount(terminalRoutes<Env, ClaimedWorkspace>(terminalRouteDeps));

app.notFound(async (c) => serveApp(c.req.raw, c.env));

app.onError(routeError);

/** A GET route here never answered HEAD (Hono's does), so HEAD dispatches on the table without GET routes. */
const headless = new Hono<FamilyEnv<Env>>({ getPath: apiPath });

for (const route of app.routes) {
  if (route.method !== 'GET') headless.on(route.method, route.path, route.handler);
}

headless.notFound(async (c) => serveApp(c.req.raw, c.env));

headless.onError(routeError);

export const api = {
  /** The route table, middleware included, in dispatch order. */
  routes: app.routes,
  fetch(request: Request, env: Env, ctx: HonoExecutionContext): Response | Promise<Response> {
    return (request.method === 'HEAD' ? headless : app).fetch(request, env, ctx);
  },
};
