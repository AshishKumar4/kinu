/** `/api/*` as one Hono app: registration order is dispatch order, so this file's order is the gate order. */
import { Hono } from 'hono';
import { err, healthResponse, REAL_CLOCK, serveApp } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { AuthError, authenticateRequest, crossSiteRejection } from '../auth/session';
import { authApiRoutes } from '../auth/routes';
import { verifyControlPlaneAccess } from '../control-plane/access-gate';
import { adminDenialMessage, adminDenialStatus, reportAdminDenial } from '../control-plane/admin-caller';
import { observeIdentity } from '../control-plane/index-feed';
import { controlRoutes } from '../control-plane/routes';
import { cliRoutes } from '../cli/routes';
import { aiProxyRoutes } from '../user/ai-proxy';
import { providerProxyRoutes } from '../user/provider-proxy';
import { accountRoutes } from '../user/account-routes';
import { userRoutes } from '../user/routes';
import { deployRoutes } from '../deploy/routes';
import { updatesRoutes } from '../updates/routes';
import { sharedPublicRoutes, sharedRoutes } from '../shared/routes';
import { driveRoutes } from '../drive/routes';
import { feedbackRoutes } from '../feedback/routes';
import { clientErrorRoutes } from '../client-error/route';
import { hubAgentResolver, hubRoutes, webhookDeliveryResolver, webhookDeliveryRoutes } from '../events/routes';
import { runEventsResolver, runEventsRoutes } from '../run-events-routes';
import { evalAbortRoutes } from '../eval/abort-route';
import { filesAgentResolver, filesRoutes } from '../files-routes';
import { terminalRouteDeps, terminalRoutes } from '../terminal-route';
import { apiError, apiPath, beneath, type FamilyEnv } from './context';
import { workspaceGate } from './workspace';

const app = new Hono<FamilyEnv<Env>>({ getPath: apiPath });

/** Checks each family's declared bindings against `Env`. */
function mount<Bindings extends object, Variables extends object>(
  family: Hono<FamilyEnv<Bindings, Variables>> & (Env extends Bindings ? unknown : never),
): void {
  app.route('/', family);
}

// Access before every bypass on the admin API.
app.use('/api/control/*', async (c, next) => {
  const access = await verifyControlPlaneAccess(c.req.raw, c.env);

  if (!access.ok) {
    reportAdminDenial(access.denial, new URL(c.req.url).pathname, c.req.method);

    return err(adminDenialStatus(access.denial), adminDenialMessage(access.denial));
  }

  c.set('access', access.access);
  await next();
});

mount(authApiRoutes);

mount(aiProxyRoutes);

mount(providerProxyRoutes);

mount(cliRoutes);

mount(deployRoutes);

app.get('/api/health', async (c) => healthResponse(c.req.raw, c.env));

mount(sharedPublicRoutes);

// Unanswered public paths are the app shell's.
app.all('/api/health', async (c) => serveApp(c.req.raw, c.env));

app.all('/api/auth/*', beneath<FamilyEnv<Env>>('/api/auth', async (c) => serveApp(c.req.raw, c.env)));

mount(webhookDeliveryRoutes(webhookDeliveryResolver));

app.use('/api/*', async (c, next) => {
  let identity;

  try {
    identity = await authenticateRequest(c.req.raw, c.env);
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 500;
    const message = e instanceof AuthError ? e.message : renderThrownChain({ cause: e });

    return new Response(JSON.stringify({ error: message }), { status, headers: { 'content-type': 'application/json' } });
  }

  const crossSite = crossSiteRejection(c.req.raw);

  if (crossSite) return crossSite;
  c.set('identity', identity);
  await next();
});

// After the cross-site check: cross-site requests never feed the index.
app.use('/api/*', async (c, next) => {
  observeIdentity(c.env, c.get('identity'), { retain: c.executionCtx });
  await next();
});

mount(feedbackRoutes);

mount(clientErrorRoutes);

mount(controlRoutes);

// Ahead of userRoutes: owner_only account methods.
mount(accountRoutes);

mount(userRoutes);

mount(sharedRoutes);

mount(driveRoutes);

mount(updatesRoutes);

app.use('/api/workspaces/:name/*', workspaceGate);

mount(runEventsRoutes(REAL_CLOCK, runEventsResolver));

mount(evalAbortRoutes);

mount(hubRoutes(hubAgentResolver));

mount(filesRoutes(filesAgentResolver));

mount(terminalRoutes(terminalRouteDeps));

app.notFound(async (c) => serveApp(c.req.raw, c.env));

app.onError(apiError);

/** A GET route here never answered HEAD (Hono's does), so HEAD dispatches on the table without GET routes. */
const headless = new Hono<FamilyEnv<Env>>({ getPath: apiPath });

for (const route of app.routes) {
  if (route.method !== 'GET') headless.on(route.method, route.path, route.handler);
}

headless.notFound(async (c) => serveApp(c.req.raw, c.env));

headless.onError(apiError);

export const api = {
  /** The route table, middleware included, in dispatch order. */
  routes: app.routes,
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return (request.method === 'HEAD' ? headless : app).fetch(request, env, ctx);
  },
};
