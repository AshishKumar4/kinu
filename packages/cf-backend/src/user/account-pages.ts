/**
 * A page open's routes as the account's object answers them (front-routes.ts), its own session check, theme and profile
 * read in-process: the landing page for a cookie that no longer holds, the app's page in the account's theme, a
 * workspace's page, which wakes the workspace, the roster socket, and an agent socket's admission. The main Worker
 * answers the account's other pages with the same shell.
 */
import { Hono, type Context } from 'hono';
import { Effect, Result } from 'effect';
import {
  accountTheme, APP_ROUTES, DEFAULT_THEME, ERROR_STATUS, err, extractOrchestratorAgentName, hostedActorRoute, objectNamed, ownerCaller,
  THEME_CONFIG_KEY, serveApp, type ObjectNamespace, type OwnerCapabilityEnv, type ThemeName, type UserCaller,
} from '@kinu.run/core';
import { settle, settleLogged, type KinuError } from '@kinu.run/core/obs';
import { sessionRouteGate } from '../auth/request-gate';
import { crossSiteRejection, sessionGate } from '../auth/session';
import { authenticateCliAgentTicketRequest, type CliAgentTicketEnv } from '../auth/cli-agent-ticket';
import { observeIdentity } from '../control-plane/index-feed';
import { addressedWorkspace, ownedWorkspace } from '../api/workspace';
import { claimOwnedWorkspace, type WorkspaceOwnershipEnv } from './workspace-ownership';
import { ROSTER_SOCKET_ROUTE, rosterSocket, type RosterSocketEnv } from './roster-socket';
import { landingRoutes } from '../landing-route';
import { appShell, type AgentSocketAdmission } from '../front-routes';
import { familyMount, ownerGate, rawPath, routeError, type FamilyEnv } from '../api/context';
import type { AuthEnv, AuthIdentity } from '../auth/session';
import type { IndexFeedEnv } from '../control-plane/index-feed';
import type { OrchestratorAgent } from '../orchestrator';
import type { UserDO } from './user-do';

type AccountShellEnv<Id> = Pick<Env, 'ASSETS' | 'PREVIEW_HOST_SUFFIX' | 'PREVIEW_HOST_PORT'> & OwnerCapabilityEnv & {
  readonly UserDO: ObjectNamespace<Id, Pick<UserDO, 'getConfig'>>;
};

/**
 * Behind sign-in: the page names the account's theme, so it paints in it on any device it opens on. The theme is only
 * a look: a read that fails is logged and the page is served in the default, never refused.
 */
export const accountShell = async <Id, E extends FamilyEnv<AccountShellEnv<Id>, { identity: AuthIdentity }>>(c: Context<E>): Promise<Response> => serveApp(c.req.raw, c.env, {
  theme: async () => {
    let theme: ThemeName = DEFAULT_THEME;

    await settleLogged('app.theme_read_failed', { doing: "reading the account's theme for its page", otherwise: 'unavailable' }, async () => {
      const account = objectNamed(c.env.UserDO, c.get('identity').userId);

      theme = accountTheme(await account.getConfig(await ownerCaller(c.env), THEME_CONFIG_KEY));
    });

    return theme;
  },
});

export type AccountPagesEnv = AuthEnv<DurableObjectId> & IndexFeedEnv<DurableObjectId> & AccountShellEnv<DurableObjectId>
  & RosterSocketEnv<DurableObjectId> & CliAgentTicketEnv<DurableObjectId>
  & WorkspaceOwnershipEnv<DurableObjectId, Pick<OrchestratorAgent, 'claimOwner' | 'resolveHostedActorRoute'>>;

interface AccountPagesVariables {
  identity: AuthIdentity;
  owner: UserCaller;
}

type AccountPagesContext = Context<FamilyEnv<AccountPagesEnv, AccountPagesVariables>>;

// A workspace's page wakes its object while the document, the app and its socket are still on the way: the claim
// the socket makes a moment later then finds it constructed. Cold, that construction measured 725 ms of a 3.2 s
// load (cmp-kinu-ux1, 2026-10-13). The socket's own claim, so a name the account does not hold wakes nothing; a
// failure is the socket's to answer, and here is only logged.
async function workspacePage(c: AccountPagesContext): Promise<Response> {
  const workspace = c.req.param('agentId');

  if (workspace !== undefined) {
    c.executionCtx.waitUntil(settleLogged('workspace.page_wake_failed', { doing: "waking a workspace for its page", otherwise: 'unavailable' },
      async () => { await claimOwnedWorkspace(c.env, c.get('identity').userId, workspace, c.get('identity').workspace); }));
  }

  return await accountShell(c);
}

/**
 * An agent socket's gate, asked by the Worker that passes the socket on: a CLI's connect ticket or the browser session,
 * the cross-site rule, the caller's claim on the workspace, then its hosted actor's route. The answer is who asks, which
 * the Worker writes over the socket's identity headers; a refusal is the Worker's answer too.
 */
function admitAgentSocket(c: AccountPagesContext): Effect.Effect<Response, KinuError> {
  return Effect.gen(function* () {
    const request = c.req.raw;
    const cliAgentTicket = yield* authenticateCliAgentTicketRequest(request, c.env);

    if (cliAgentTicket instanceof Response) return cliAgentTicket;
    // A CLI ticket is its own credential; the cross-site rule still holds over it.
    const identity = cliAgentTicket === null ? yield* sessionGate(request, c.env, addressedWorkspace(request)) : (crossSiteRejection(request) ?? cliAgentTicket.identity);

    if (identity instanceof Response) return identity;
    // After CSRF so cross-site requests never feed the index; workspaces are indexed only after the ownership check.
    observeIdentity(c.env, identity, { retain: c.executionCtx });
    const name = extractOrchestratorAgentName(c.req.path);

    if (name === null) return err(404, 'Not found');
    const owned = yield* Effect.promise(async () => ownedWorkspace(c, identity, name, request));

    if (Result.isFailure(owned)) return owned.failure;
    const hosted = hostedActorRoute(c.req.path);
    const target = hosted === null ? null : yield* Effect.promise(async () => owned.success.agent.resolveHostedActorRoute(hosted.name));

    if (target !== null && 'reason' in target) return Response.json(target, { status: ERROR_STATUS[target.reason] });

    const admission: AgentSocketAdmission = {
      userId: identity.userId, sessionTokenHash: identity.sessionTokenHash, cliScopes: identity.cliScopes, cliBearer: identity.cliBearer,
      hostedActorId: target?.actorId,
    };

    return Response.json(admission);
  });
}

/** Registration order is dispatch order. */
export function accountPages() {
  const pages = new Hono<FamilyEnv<AccountPagesEnv, AccountPagesVariables>>({ getPath: rawPath });

  familyMount(pages)(landingRoutes);

  for (const path of ['/', APP_ROUTES.workspace, `${APP_ROUTES.workspace}/*`]) pages.use(path, sessionRouteGate());

  pages.get('/', accountShell);

  pages.get(APP_ROUTES.workspace, workspacePage);

  pages.get(`${APP_ROUTES.workspace}/*`, workspacePage);

  // HEAD is the app shell's, as on every `/api` path (api/app.ts).
  pages.get(ROSTER_SOCKET_ROUTE, async (c, next) => (c.req.method === 'HEAD' ? appShell(c) : next()), sessionRouteGate(), ownerGate(), rosterSocket());

  pages.all('/agents/*', (c) => settle(admitAgentSocket(c)));

  pages.onError(routeError);

  return pages;
}
