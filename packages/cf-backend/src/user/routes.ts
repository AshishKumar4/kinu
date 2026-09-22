/**
 * `/api/user/*` HTTP routes. All operations are user-scoped — the auth
 * middleware resolves the caller's Kinu `userId` before any of these
 * handlers run.
 *
 * Routes:
 *   POST   /api/user/onboarding/complete         — first-run setup finished (account-routes.ts)
 *   PATCH  /api/user/profile                     — rename the owner (account-routes.ts)
 *   GET    /api/user/profile                     — user info
 *   GET    /api/user/profile-catalog               — the account's role/tier catalog envelope
 *   PUT    /api/user/profile-catalog               — compare-and-swap update ({ catalog, expectedVersion })
 *   GET    /api/user/cli                           — CLI setup commands
 *   GET    /api/user/workspaces                    — agent roster page (?cursor=&limit=, nextCursor walks)
 *   POST   /api/user/workspaces                    — register new agent
 *   POST   /api/user/workspaces/:name/touch        — update last_visited
 *   DELETE /api/user/workspaces/:name              — remove from registry
 *   GET    /api/user/credentials                   — key/kind/timestamps only; no secret is readable back
 *   POST   /api/user/credentials/:key              — set
 *   DELETE /api/user/credentials/:key              — delete
 *   PATCH  /api/user/devices/:id                   — rename a device (the name every surface shows)
 *   GET    /api/user/devices/consents              — per-(workspace, device) bindings
 *   PUT    /api/user/devices/:id/sandbox           — the device's Sandbox switch (owner only)
 *   DELETE /api/user/devices/:id/consent           — revoke a workspace's binding on a device
 *   GET    /api/user/codex                         — Codex status
 *   POST   /api/user/codex/start                   — start device flow
 *   POST   /api/user/codex/poll                    — poll device flow
 *   DELETE /api/user/codex                         — disconnect Codex
 *   GET    /api/user/config                        — list all defaults
 *   GET    /api/user/config/:key                   — single default
 *   PUT    /api/user/config/:key                   — set default
 *   GET    /api/user/models                        — union of available models
 *   GET    /api/user/providers                     — connected provider summary
 *   GET    /api/user/providers/catalog             — connectable providers (BYO key)
 *   GET    /api/user/cloudflare/accounts           — accounts this login can see + selection
 *   PUT    /api/user/cloudflare/account            — pick which account serves Workers AI
 *   GET    /api/user/cloudflare/gateways           — the user's AI Gateways + selection
 *   PUT    /api/user/cloudflare/gateway            — select an AI Gateway (or null)
 *   GET    /api/user/mcp/servers                   — list configured MCP servers
 *   POST   /api/user/mcp/servers                   — add a new MCP server
 *   DELETE /api/user/mcp/servers/:id               — remove an MCP server
 *   PATCH  /api/user/mcp/servers/:id               — edit name / headers / allowed_tools
 *   GET    /api/user/mcp/callback                  — OAuth 2.1 redirect handler
 */
import type { AuthIdentity } from '../auth/session';
import type { UserDO } from './user-do';
import { PROFILE_CATALOG_CONFIG_KEY } from '@kinu.run/core';
import { DEVICE_TIERS, JsonValueSchema } from '@kinu.run/core';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';
import { buildCliAuthCommand, buildCliInstallCommand, buildCliSetupCommand, normalizeCliOrigin } from '@kinu.run/core';
import { listAvailableModels, listProviderCatalog } from './available-models';
import {
  handleCreateWorkspaceRequest, notifyWorkspacesCredentialsChanged, type CreateWorkspaceEnv,
} from './workspace-access';
import type { CloudWorkspaceRegistry } from './workspace-create';
import type { ObjectNamespace } from '@kinu.run/core';
import { err, json, safeJson } from '@kinu.run/core';
import { retryTransientDO } from '@kinu.run/core';
import { OwnerCapabilityUnavailableError, ownerCaller, type UserCaller } from '@kinu.run/core';
import { isControlPlaneOperator, type AdminGateEnv } from '../control-plane/admin-caller';
import * as v from 'valibot';

const OptionalLabelSchema = v.object({ label: v.optional(v.string()) });

/** Every call `/api/user/*` makes on the signed-in account's own object. One
 *  projection of the class per route family, joined here because one dispatcher
 *  holds one stub for all of them. */
export type UserRoutesAuthority = CloudWorkspaceRegistry & Pick<
  UserDO,
  'ensureProfile' | 'userMcp_warmConnections' | 'getProfile' | 'getProfileCatalog' | 'putProfileCatalog'
  | 'listWorkspaces' | 'touchWorkspace' | 'removeWorkspace'
  | 'listDevices' | 'acknowledgeUnstoppedDevice' | 'revokeDevice' | 'renameDevice' | 'listDeviceConsents'
  | 'setDeviceTier' | 'revokeDeviceConsent'
  | 'listCredentials' | 'setCredential' | 'deleteCredential' | 'listActiveWorkspaces'
  | 'getCodexStatus' | 'disconnectCodex' | 'startCodexDeviceFlow' | 'pollCodexDeviceFlow'
  | 'listConfig' | 'getConfig' | 'setConfig' | 'listConnectedProviders'
  | 'listCloudflareAccounts' | 'selectCloudflareAccount' | 'listAIGateways' | 'selectAIGateway'
  | 'userMcp_list' | 'userMcp_presets' | 'userMcp_add' | 'userMcp_remove' | 'userMcp_update'
  | 'userMcp_handleOAuthCallback'
>;

/** Every binding `/api/user/*` reads: the create route's whole reach, the
 *  operator allowlist the profile read answers with, and the CLI origin the
 *  setup commands are rendered against. */
export interface UserRoutesEnv<Id> extends CreateWorkspaceEnv<Id>, AdminGateEnv {
  UserDO: ObjectNamespace<Id, UserRoutesAuthority>;
  CLI_PUBLIC_ORIGIN?: string;
}

function getUserDOStub<Id>(env: UserRoutesEnv<Id>, userId: string): UserRoutesAuthority {
  return env.UserDO.get(env.UserDO.idFromName(userId));
}

/** Users whose MCP connections we've already kicked off warming for this
 *  isolate. Warm-once-per-process so a cold UserDO re-establishes connections
 *  in parallel with the first orchestrator turn, not on its 5s critical path. */
const warmedMcpUsers = new Set<string>();

/** Everything the workspace roster listing reads: the UserDO stub that owns
 *  the roster, the owner caller it answers to, and the request URL that
 *  carries the page cursor and limit. */
interface WorkspaceRosterContext {
  readonly stub: Pick<UserDO, 'listWorkspaces'>;
  readonly owner: UserCaller;
  readonly url: URL;
}

/** GET /api/user/workspaces — one roster page. Parses and bounds the limit,
 *  then maps a garbage cursor to a 400. */
async function listWorkspaceRoster(ctx: WorkspaceRosterContext): Promise<Response> {
  const cursor = ctx.url.searchParams.get('cursor');
  const limitRaw = ctx.url.searchParams.get('limit');
  const limit = limitRaw === null || limitRaw.trim() === '' ? undefined : Number(limitRaw);

  // The roster bounds live in user-do's clampRosterLimit. This check only
  // keeps a non-number from arriving as NaN, which otherwise reads as a
  // throw from the registry rather than as a bad request.
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    return err(400, 'Workspace roster limit must be a positive integer.');
  }

  try {
    return json({ body: await ctx.stub.listWorkspaces(ctx.owner, { cursor, limit }) });
  } catch (e) {
    const message = renderThrownChain({ cause: e });

    // Matched by message because the DO RPC boundary carries no error class.
    // User-do holds this string verbatim as wire contract.
    if (message.startsWith('Invalid workspace roster cursor')) return err(400, message);
    throw e;
  }
}

/** What every `/api/user/*` route family reads: the request with its parsed
 *  address, the caller the middleware resolved, and the account object the
 *  dispatcher holds one stub of. */
interface UserRouteContext<Id> {
  readonly request: Request;
  readonly env: UserRoutesEnv<Id>;
  readonly identity: AuthIdentity;
  readonly ctx: Pick<ExecutionContext, 'waitUntil'> | undefined;
  readonly url: URL;
  readonly path: string;
  readonly method: string;
  readonly owner: UserCaller;
  readonly stub: UserRoutesAuthority;
}

/** One family of routes: the answer it owns, or null when the address is not
 *  one of its own. */
type UserRouteFamily = <Id>(route: UserRouteContext<Id>) => Promise<Response | null>;

/** The origin the CLI commands are rendered against: the configured public
 *  origin where the deployment declares one, this request's own otherwise. */
function cliOriginFor<Id>(env: UserRoutesEnv<Id>, url: URL): string {
  const configured = env.CLI_PUBLIC_ORIGIN ?? '';

  return normalizeCliOrigin(configured === '' ? url.origin : configured);
}

/** /api/user/profile and the account's role/tier catalog. */
async function handleProfileRoutes<Id>(route: UserRouteContext<Id>): Promise<Response | null> {
  const { request, env, identity, path, method, owner, stub } = route;

  if (path === '/profile' && method === 'GET') {
    const profile = await stub.getProfile(await ownerCaller(env));
    // Whether this session's email is an operator address, read through the SAME
    // allowlist function `authorizeAdmin` uses rather than by a second reading of
    // the var — so the nav entry and the gate cannot disagree about who is on the
    // list, and the link is absent for everyone the gate would 404.
    //
    // It is NOT authorization, and it cannot be: the gate's outer half is a
    // Cloudflare Access assertion, and Access covers `/control*` and
    // `/api/control*` only — this profile read carries none. So the flag answers
    // the one half it can see and the gate answers both on every control-plane
    // request. An operator who is on the allowlist but outside the Access policy
    // sees the link and gets a 404 behind it, which is the correct failure: the
    // remedy is an Access policy change, and hiding the link would hide the
    // problem.
    const controlPlane = isControlPlaneOperator(env, identity);

    return json({ body: profile === null ? null : { ...profile, controlPlane } });
  }

  if (path === '/profile-catalog' && method === 'GET') {
    return json({ body: await stub.getProfileCatalog(owner) });
  }

  if (path === '/profile-catalog' && method === 'PUT') {
    const body = await safeJson(request, v.object({
      catalog: JsonValueSchema,
      expectedVersion: v.number(),
    }));

    if (!body) return err(400, 'Body must be { catalog, expectedVersion }.');
    const result = await stub.putProfileCatalog(owner, body.catalog, body.expectedVersion);

    if (result.ok) return json({ body: result.envelope });

    if (result.kind === 'conflict') {
      return json({
        body: {
          error: `Version conflict: the stored catalog is at version ${result.currentVersion}.`,
          currentVersion: result.currentVersion,
          currentDigest: result.currentDigest,
        },
      }, { status: 409 });
    }

    return err(400, result.reason);
  }

  return null;
}

/** /api/user/cli — the commands that install and point a CLI at this
 *  deployment. */
function handleCliRoutes<Id>(route: UserRouteContext<Id>): Promise<Response | null> {
  const { env, url, path, method } = route;

  if (path !== '/cli' || method !== 'GET') return Promise.resolve(null);
  const cliOrigin = cliOriginFor(env, url);

  return Promise.resolve(json({
    body: {
      publicOrigin: cliOrigin,
      installCommand: buildCliInstallCommand({ origin: cliOrigin }),
      setupCommand: buildCliSetupCommand(cliOrigin),
      authCommand: buildCliAuthCommand(cliOrigin),
    },
  }));
}

/** /api/user/workspaces* — the roster page, registration, and the two
 *  per-workspace actions. */
async function handleWorkspaceRoutes<Id>(route: UserRouteContext<Id>): Promise<Response | null> {
  const { request, env, identity, url, path, method, owner, stub } = route;

  if (path === '/workspaces' && method === 'GET') {
    return listWorkspaceRoster({ stub, owner, url });
  }

  if (path === '/workspaces' && method === 'POST') {
    return handleCreateWorkspaceRequest({ request, env, userId: identity.userId, userDO: stub });
  }

  const agentTouchMatch = path.match(/^\/workspaces\/([^/]+)\/touch$/);

  if (agentTouchMatch && method === 'POST') {
    try {
      await stub.touchWorkspace(await ownerCaller(env), decodeURIComponent(agentTouchMatch[1]));

      return json({ body: { ok: true } });
    }
    catch (e) { return err(400, renderThrownChain({ cause: e })); }
  }

  const agentMatch = path.match(/^\/workspaces\/([^/]+)$/);

  if (agentMatch && method === 'DELETE') {
    try {
      await stub.removeWorkspace(await ownerCaller(env), decodeURIComponent(agentMatch[1]), identity.userId);

      return json({ body: { ok: true } });
    }
    catch (e) { return err(400, renderThrownChain({ cause: e })); }
  }

  return null;
}

/**
 * /api/user/devices* — the machines themselves, their per-(workspace, device)
 * bindings, and the Sandbox switch.
 *
 * The bare `/devices/:id` arms are read BEFORE `/devices/consents`, so a
 * DELETE of the literal path `/devices/consents` revokes a device named
 * `consents` rather than listing bindings. That order is the shipped answer
 * and the reason these routes stay in one family in one sequence.
 */
async function handleDeviceRoutes<Id>(route: UserRouteContext<Id>): Promise<Response | null> {
  const { request, env, url, path, method, stub } = route;

  if (path === '/devices' && method === 'GET') {
    return json({ body: await stub.listDevices(await ownerCaller(env)) });
  }

  if (path === '/devices' && method === 'POST') {
    const body = await safeJson(request, OptionalLabelSchema);
    const cliOrigin = cliOriginFor(env, url);

    const installCommand = buildCliInstallCommand({
      origin: cliOrigin,
      setup: false,
      connect: true,
      label: body?.label,
    });

    return json({ body: { origin: cliOrigin, installCommand } }, { status: 201 });
  }

  const deviceAcknowledgeMatch = path.match(/^\/devices\/([^/]+)\/unstopped$/);

  if (deviceAcknowledgeMatch && method === 'DELETE') {
    try {
      const result = await stub.acknowledgeUnstoppedDevice(await ownerCaller(env), decodeURIComponent(deviceAcknowledgeMatch[1]));

      if (!result.ok) return err(404, 'No unconfirmed command incident matched this revoked device');

      return json({ body: { ok: true } });
    } catch (e) {
      return err(400, renderThrownChain({ cause: e }));
    }
  }

  const deviceMatch = path.match(/^\/devices\/([^/]+)$/);

  if (deviceMatch && method === 'DELETE') {
    try {
      const result = await stub.revokeDevice(await ownerCaller(env), decodeURIComponent(deviceMatch[1]));

      return json({ body: result });
    } catch (e) {
      return err(400, renderThrownChain({ cause: e }));
    }
  }

  if (deviceMatch && method === 'PATCH') {
    const body = await safeJson(request, v.object({ name: v.optional(v.string()) }));
    const name = body?.name?.trim();

    if (!name) return err(400, 'Body must be { name }');
    const result = await stub.renameDevice(await ownerCaller(env), decodeURIComponent(deviceMatch[1]), name);

    if (!result.ok) return err(404, 'device not found');

    return json({ body: { ok: true } });
  }

  if (path === '/devices/consents' && method === 'GET') {
    return json({ body: await stub.listDeviceConsents(await ownerCaller(env)) });
  }

  const consentMatch = path.match(/^\/devices\/([^/]+)\/consent$/);
  // ── The device's Sandbox switch. Owner session only: the UserDO refuses a
  //    workspace caller, and a workspace that could turn its own sandbox off
  //    would be granting itself the whole machine.
  const sandboxMatch = path.match(/^\/devices\/([^/]+)\/sandbox$/);

  if (sandboxMatch && method === 'PUT') {
    const body = await safeJson(request, v.object({ tier: v.optional(v.picklist(DEVICE_TIERS)) }));
    const tier = body?.tier;

    if (!tier) return err(400, `Body must be { tier: ${DEVICE_TIERS.map((t) => `'${t}'`).join(' | ')} }`);
    const result = await stub.setDeviceTier(await ownerCaller(env), decodeURIComponent(sandboxMatch[1]), tier);

    if (!result.ok) return err(404, 'device not found');

    return json({ body: { ok: true } });
  }

  if (consentMatch && method === 'DELETE') {
    const agentName = url.searchParams.get('agentName')?.trim();

    if (!agentName) return err(400, 'Query must carry ?agentName=');

    const result = await stub.revokeDeviceConsent(
      await ownerCaller(env), agentName, decodeURIComponent(consentMatch[1]),
    );

    if (!result.ok) return err(400, 'grant not revoked');

    return json({ body: { ok: true } });
  }

  return null;
}

/** /api/user/credentials* — the key list and the two writes. No secret is
 *  readable back. */
async function handleCredentialRoutes<Id>(route: UserRouteContext<Id>): Promise<Response | null> {
  const { request, env, ctx, path, method, stub } = route;

  if (path === '/credentials' && method === 'GET') {
    return json({ body: await stub.listCredentials(await ownerCaller(env)) });
  }

  const credMatch = path.match(/^\/credentials\/([^/]+)$/);

  if (credMatch) {
    const key = decodeURIComponent(credMatch[1]);

    if (method === 'POST') {
      const body = await safeJson(request, JsonValueSchema);

      if (body === null) return err(400, 'Body must be JSON');

      try { await stub.setCredential(await ownerCaller(env), key, body); }
      catch (e) { return err(400, renderThrownChain({ cause: e })); }

      notifyWorkspacesCredentialsChanged(env, stub, ctx);

      return json({ body: { ok: true } });
    }

    if (method === 'DELETE') {
      try { await stub.deleteCredential(await ownerCaller(env), key); }
      catch (e) { return err(400, renderThrownChain({ cause: e })); }

      notifyWorkspacesCredentialsChanged(env, stub, ctx);

      return json({ body: { ok: true } });
    }
  }

  return null;
}

/** /api/user/codex* — the device flow and its status. */
async function handleCodexRoutes<Id>(route: UserRouteContext<Id>): Promise<Response | null> {
  const { env, ctx, path, method, stub } = route;

  if (path === '/codex' && method === 'GET') {
    return json({ body: await stub.getCodexStatus(await ownerCaller(env)) });
  }

  if (path === '/codex' && method === 'DELETE') {
    await stub.disconnectCodex(await ownerCaller(env));
    notifyWorkspacesCredentialsChanged(env, stub, ctx);

    return json({ body: { ok: true } });
  }

  if (path === '/codex/start' && method === 'POST') {
    try { return json({ body: await stub.startCodexDeviceFlow(await ownerCaller(env)) }); }
    catch (e) { return err(502, renderThrownChain({ cause: e })); }
  }

  if (path === '/codex/poll' && method === 'POST') {
    try {
      const status = await stub.pollCodexDeviceFlow(await ownerCaller(env));

      if (status.connected) notifyWorkspacesCredentialsChanged(env, stub, ctx);

      return json({ body: status });
    } catch (e) { return err(502, renderThrownChain({ cause: e })); }
  }

  return null;
}

/** /api/user/config* — the account's defaults. The profile catalog has its own
 *  route and is refused here. */
async function handleConfigRoutes<Id>(route: UserRouteContext<Id>): Promise<Response | null> {
  const { request, env, path, method, stub } = route;

  if (path === '/config' && method === 'GET') {
    return json({ body: await stub.listConfig(await ownerCaller(env)) });
  }

  const cfgMatch = path.match(/^\/config\/([^/]+)$/);

  if (cfgMatch) {
    const key = decodeURIComponent(cfgMatch[1]);

    if (key === PROFILE_CATALOG_CONFIG_KEY) {
      return err(400, 'Profile catalogs use /api/user/profile-catalog.');
    }

    if (method === 'GET') {
      return json({ body: { key, value: await stub.getConfig(await ownerCaller(env), key) } });
    }

    if (method === 'PUT') {
      const body = await safeJson(request, v.object({ value: v.string() }));

      if (!body) return err(400, 'value (string) required');
      await stub.setConfig(await ownerCaller(env), key, body.value);

      return json({ body: { ok: true } });
    }
  }

  return null;
}

/** /api/user/providers*, /api/user/models — what this account can call. */
async function handleModelRoutes<Id>(route: UserRouteContext<Id>): Promise<Response | null> {
  const { env, identity, path, method, stub } = route;

  if (path === '/providers' && method === 'GET') {
    return json({ body: await stub.listConnectedProviders(await ownerCaller(env)) });
  }

  if (path === '/providers/catalog' && method === 'GET') {
    return json({ body: await listProviderCatalog(env, identity.userId, await ownerCaller(env)) });
  }

  if (path === '/models' && method === 'GET') {
    return json({ body: await listAvailableModels(env, identity.userId, await ownerCaller(env)) });
  }

  return null;
}

/** /api/user/cloudflare/* — which account serves Workers AI, and the user's
 *  own AI Gateway. */
async function handleCloudflareRoutes<Id>(route: UserRouteContext<Id>): Promise<Response | null> {
  const { request, env, ctx, path, method, stub } = route;

  if (path === '/cloudflare/accounts' && method === 'GET') {
    return json({ body: await stub.listCloudflareAccounts(await ownerCaller(env)) });
  }

  if (path === '/cloudflare/account' && method === 'PUT') {
    const body = await safeJson(request, v.object({ id: v.string() }));

    if (!body) return err(400, 'id (string) required');

    try { await stub.selectCloudflareAccount(await ownerCaller(env), body.id); }
    catch (e) { return err(400, renderThrownChain({ cause: e })); }

    notifyWorkspacesCredentialsChanged(env, stub, ctx);

    return json({ body: { ok: true } });
  }

  if (path === '/cloudflare/gateways' && method === 'GET') {
    return json({ body: await stub.listAIGateways(await ownerCaller(env)) });
  }

  if (path === '/cloudflare/gateway' && method === 'PUT') {
    const body = await safeJson(request, v.object({ id: v.nullable(v.string()) }));

    if (!body) {
      return err(400, 'id (string | null) required');
    }

    try { await stub.selectAIGateway(await ownerCaller(env), body.id); }
    catch (e) { return err(400, renderThrownChain({ cause: e })); }

    notifyWorkspacesCredentialsChanged(env, stub, ctx);

    return json({ body: { ok: true } });
  }

  return null;
}

/** Every `/api/user/*` family, in the order the dispatcher asks them. The
 *  families own disjoint address spaces, so the order is the reading order and
 *  nothing else; a family adds and removes its own routes together. */
const USER_ROUTE_FAMILIES: readonly UserRouteFamily[] = [
  handleProfileRoutes,
  handleCliRoutes,
  handleWorkspaceRoutes,
  handleDeviceRoutes,
  handleCredentialRoutes,
  handleCodexRoutes,
  handleConfigRoutes,
  handleModelRoutes,
  handleCloudflareRoutes,
  handleMcpRoutes,
];

export async function handleUserRequest<Id>(
  request: Request,
  env: UserRoutesEnv<Id>,
  identity: AuthIdentity,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (!url.pathname.startsWith('/api/user')) return null;
  const path = url.pathname.slice('/api/user'.length);
  const method = request.method;

  let owner: UserCaller;

  try { owner = await ownerCaller(env); }
  catch (e) {
    // Same answer the CLI plane gives: a deployment with no root secret cannot
    // authorize anything for the owner, and should say which secret.
    if (e instanceof OwnerCapabilityUnavailableError) return err(503, e.message);
    throw e;
  }

  const stub = getUserDOStub(env, identity.userId);
  // Bootstrap profile on every request — cheap UPDATE if exists, INSERT once.
  // It is also the gate every /api/user route passes through, so a dropped
  // connection here fails a request that had nothing wrong with it; the upsert
  // converges to the same row however many times it runs.
  await retryTransientDO('ensureProfile',
    () => stub.ensureProfile(owner, identity.email, identity.displayName ?? undefined));

  // First hit for this user in this isolate warms MCP connections. The warm is
  // one-shot per user per isolate.
  //
  // `ctx` here is the WORKER's ExecutionContext, so waitUntil is the right call:
  // it is a no-op only inside a Durable Object (`do.wait_until.no_op`). A warm
  // that throws must leave a trace and must not mark the user warmed: the
  // settlement below deletes the user from the set and reports the failure, so
  // the next request retries the warm instead of recording one that did not
  // happen.
  if (ctx && !warmedMcpUsers.has(identity.userId)) {
    warmedMcpUsers.add(identity.userId);
    const caller = await ownerCaller(env);

    const warmMcp = async (): Promise<void> => {
      try {
        await stub.userMcp_warmConnections(caller);
      } catch (cause) {
        warmedMcpUsers.delete(identity.userId);
        diagnostics.failure('user.bootstrap_failed', toKinuError({
          doing: 'bootstrapping the user on first hit in this isolate',
          cause,
          otherwise: 'unavailable',
        }), { step: 'mcp_warm', userId: identity.userId });
      }
    };

    ctx.waitUntil(warmMcp());
  }

  const route: UserRouteContext<Id> = { request, env, identity, ctx, url, path, method, owner, stub };

  for (const family of USER_ROUTE_FAMILIES) {
    const answer = await family(route);

    if (answer) return answer;
  }

  return err(404, `No such user route: ${method} ${path}`);
}

/** /api/user/mcp/* — the server roster, the preset availability report, and
 *  the OAuth callback. */
async function handleMcpRoutes<Id>(route: UserRouteContext<Id>): Promise<Response | null> {
  const { request, stub, owner, path, method } = route;

  if (path === '/mcp/servers' && method === 'GET') {
    try { return json({ body: await stub.userMcp_list(owner) }); }
    catch (e) { return err(500, renderThrownChain({ cause: e })); }
  }

  if (path === '/mcp/presets' && method === 'GET') {
    try { return json({ body: await stub.userMcp_presets(owner) }); }
    catch (e) { return err(500, renderThrownChain({ cause: e })); }
  }

  if (path === '/mcp/servers' && method === 'POST') {
    const body = await safeJson(request, JsonValueSchema);

    if (body === null) return err(400, 'Body must be JSON');
    const origin = publicOrigin(request);

    try { return json({ body: await stub.userMcp_add(owner, body, origin) }, { status: 201 }); }
    catch (e) { return err(400, renderThrownChain({ cause: e })); }
  }

  const mcpIdMatch = path.match(/^\/mcp\/servers\/([^/]+)$/);

  if (mcpIdMatch) {
    const id = decodeURIComponent(mcpIdMatch[1]);

    if (method === 'DELETE') {
      try {
        await stub.userMcp_remove(owner, id);

        return json({ body: { ok: true } });
      }
      catch (e) { return err(400, renderThrownChain({ cause: e })); }
    }

    if (method === 'PATCH') {
      const body = await safeJson(request, JsonValueSchema);

      if (body === null) return err(400, 'Body must be JSON');

      try {
        await stub.userMcp_update(owner, id, body);

        return json({ body: { ok: true } });
      }
      catch (e) { return err(400, renderThrownChain({ cause: e })); }
    }
  }

  if (path === '/mcp/callback' && method === 'GET') {
    // The OAuth provider stamps `<nonce>.<serverId>` in `state`; we don't
    // need to extract it here — `userMcp_handleOAuthCallback` does the validation
    // inside UserDO. The Worker's browser auth middleware (above) already
    // resolved the caller's identity, so we know which UserDO to dispatch to.
    const result = await stub.userMcp_handleOAuthCallback(owner, request.url);
    // Redirect the browser back to the settings page regardless of outcome.
    // The page polls userMcp_list and the per-server status surfaces the
    // result. We include `?mcp_auth=ok|failed&error=...` for UX clarity.
    const settingsUrl = new URL('/user/settings/mcp', publicOrigin(request));
    settingsUrl.searchParams.set('mcp_auth', result.ok ? 'ok' : 'failed');

    if (result.error) settingsUrl.searchParams.set('error', result.error.slice(0, 200));

    if (result.serverId) settingsUrl.searchParams.set('server_id', result.serverId);

    return new Response(null, { status: 302, headers: { Location: settingsUrl.toString() } });
  }

  return null;
}

/** Derive the public origin the client sees. CF puts the canonical host
 *  in the Host header for direct-zone routes; the Worker's own URL is
 *  also a fine fallback (it matches the publicly-exposed origin). */
function publicOrigin(request: Request): string {
  // CF-Connecting-IP and similar headers don't help; the safest source is
  // the request URL itself because Workers preserves the visitor's scheme
  // and host in `request.url` for proxied requests.
  return new URL(request.url).origin;
}
