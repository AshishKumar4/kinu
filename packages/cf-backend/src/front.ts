/**
 * The front Worker: it owns the app's host and answers what a page open needs (front-routes.ts) from code that starts
 * within a connection's TLS handshake, and passes every other request to the main Worker, which holds every Durable
 * Object and whose start each new connection waited for (L29).
 */
import { Hono } from 'hono';
import { hostOf, httpsUpgrade, isPreviewHostRequest, mailHostRedirect, published } from '@kinu.run/core';
import { installAnalyticsDiagnostics } from '@kinu.run/core/analytics';
import { frontRoutes, type FrontRoutesEnv } from './front-routes';
import { sessionAccount } from './auth/session';
import { MAIN_SERVICE_BINDING } from '@kinu.run/core/deploy';
import { familyMount, rawPath, routeError, type FamilyEnv } from './api/context';

export interface FrontEnv extends FrontRoutesEnv, Pick<Env, 'CF_VERSION_METADATA' | 'AGENT_METRICS' | 'FEEDBACK_MARKERS' | 'CONTROL_PLANE_OPS'> {
  /** The main Worker: every request the front does not answer. */
  readonly [MAIN_SERVICE_BINDING]: Fetcher;
}

const front = new Hono<FamilyEnv<FrontEnv, object>>({ getPath: rawPath });

familyMount(front)(frontRoutes<FrontEnv>(async (request) => sessionAccount(request)));

front.all('*', async (c) => c.env.MAIN.fetch(c.req.raw));

front.onError(routeError);

export default {
  async fetch(request: Request, env: FrontEnv, ctx: ExecutionContext) {
    installAnalyticsDiagnostics(env);
    const url = new URL(request.url);

    // The main Worker's route holds the zone's other hosts; one that reaches here goes on before any route runs, so a
    // preview's host never reads the app's files.
    if (isPreviewHostRequest(url, env) || mailHostRedirect(url, hostOf(env.CLI_PUBLIC_ORIGIN)) !== null) return env.MAIN.fetch(request);
    const upgrade = httpsUpgrade(url, env);

    if (upgrade) return upgrade;

    return published(await front.fetch(request, env, ctx), url, env);
  },
} satisfies ExportedHandler<FrontEnv>;
