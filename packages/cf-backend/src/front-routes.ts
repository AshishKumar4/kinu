/**
 * Where the routes a page open takes are answered, on both of the deployment's Workers: the app's files and the landing
 * page here; the account's page and roster socket by the account's object (user/account-pages.ts); the agent socket by
 * the workspace's object, once the account's object has admitted it. The objects check the session, so this module
 * reads no secret and links nothing a page open does not run: the front Worker that runs it starts within a
 * connection's TLS handshake (front.ts).
 */
import { Hono, type Context } from 'hono';
import * as v from 'valibot';
import { routeAgentRequest } from 'agents/routing';
import {
  ACCESS_TOKEN_SCOPES, APP_ROUTES, err, extractOrchestratorAgentName, HOSTED_ACTOR_ID_HEADER, isForeignAgentNamespacePath, markDocument,
  objectNamed, serveApp,
} from '@kinu.run/core';
import { landingPage } from './landing-route';
import { ROSTER_SOCKET_ROUTE } from './user/roster-socket';
import { cliAgentTicketOf, withoutCliAgentTicket } from './auth/cli-agent-ticket';
import { appendIdentityHeaders } from './cli/rpc-gate';
import { beneath, rawPath, type FamilyEnv } from './api/context';
import type { RequestAccount } from './auth/session';

export type FrontRoutesEnv = Pick<Env, 'ASSETS' | 'UserDO' | 'OrchestratorAgent' | 'CLI_PUBLIC_ORIGIN' | 'PREVIEW_HOST_SUFFIX' | 'PREVIEW_HOST_PORT'>;

/** The account's object answers these for a request whose credential names it. */
export const ACCOUNT_PAGES = ['/', APP_ROUTES.workspace, `${APP_ROUTES.workspace}/*`, ROSTER_SOCKET_ROUTE] as const;

/** The account's object's answer to a Worker that asks whether an agent socket may open (user/account-pages.ts): who
 *  asks, and the hosted actor the socket is for. */
export const AgentSocketAdmissionSchema = v.object({
  userId: v.string(),
  sessionTokenHash: v.optional(v.string()),
  cliScopes: v.optional(v.array(v.picklist(ACCESS_TOKEN_SCOPES))),
  cliBearer: v.optional(v.object({ tokenHash: v.string(), generation: v.number() })),
  hostedActorId: v.optional(v.string()),
});

export type AgentSocketAdmission = v.InferOutput<typeof AgentSocketAdmissionSchema>;

/** The socket's request as its workspace's object takes it: every identity header written from the admission. */
function admittedSocket(request: Request, admission: AgentSocketAdmission): Request {
  const headers = appendIdentityHeaders(request.headers, admission);

  if (admission.hostedActorId !== undefined) headers.set(HOSTED_ACTOR_ID_HEADER, admission.hostedActorId);

  return new Request(withoutCliAgentTicket(request), { headers });
}

/** The app's page as a file of it, or as any route nobody else answers. */
export const appShell = async <E extends FamilyEnv<Pick<FrontRoutesEnv, 'ASSETS' | 'PREVIEW_HOST_SUFFIX' | 'PREVIEW_HOST_PORT'>, object>>(c: Context<E>): Promise<Response> => serveApp(c.req.raw, c.env);

/** `accountOf` reads whose account a request is, as far as the Worker running these routes can. */
export function frontRoutes<B extends FrontRoutesEnv>(accountOf: (request: Request, env: B) => Promise<RequestAccount>) {
  const routes = new Hono<FamilyEnv<B, object>>({ getPath: rawPath });

  routes.get('/assets/kinu-icon.svg', async () => new Response(markDocument(), {
    headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600, must-revalidate' },
  }));

  routes.all('/assets/*', beneath('/assets', appShell));

  for (const path of ACCOUNT_PAGES) {
    routes.get(path, async (c, next) => {
      const account = await accountOf(c.req.raw, c.env);

      if (account === 'none' && c.req.path === '/') return landingPage(c.req.raw, c.env);

      return typeof account === 'object' ? objectNamed(c.env.UserDO, account.id).fetch(c.req.raw) : next();
    });
  }

  routes.all('/agents/*', async (c, next) => {
    // Refuse any namespace/facet path outside the public actor grammar before SDK routing: routeAgentRequest maps every
    // DO binding by slug, and this keeps every object but the workspace's unreachable.
    if (isForeignAgentNamespacePath(c.req.path)) return err(404, 'Not found');

    if (extractOrchestratorAgentName(c.req.path) === null) return next();
    const ticket = cliAgentTicketOf(c.req.raw);

    if (ticket instanceof Response) return ticket;
    const account = ticket === null ? await accountOf(c.req.raw, c.env) : { id: ticket.userId };

    if (typeof account !== 'object') return next();
    // The account's object admits it before the workspace's object is reached, so a name the account does not hold
    // wakes nothing (workspace-ownership.ts).
    const admitted = await objectNamed(c.env.UserDO, account.id).fetch(c.req.raw);

    if (!admitted.ok) return admitted;

    return (await routeAgentRequest(admittedSocket(c.req.raw, v.parse(AgentSocketAdmissionSchema, await admitted.json())), c.env)) ?? next();
  });

  return routes;
}
