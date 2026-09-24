/**
 * `/api/user/*` HTTP routes. All are user-scoped: auth middleware resolves the caller's `userId` first.
 * `GET /credentials` returns key/kind/timestamps only; no secret is readable back.
 */
import type { AuthIdentity } from '../auth/session';
import type { UserDO } from './user-do';
import { PROFILE_CATALOG_CONFIG_KEY } from '@kinu.run/core';
import { DEVICE_TIERS, JsonValueSchema } from '@kinu.run/core';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';
import { buildCliAuthCommand, buildCliInstallCommand, buildCliSetupCommand, normalizeCliOrigin } from '@kinu.run/core';
import { listAvailableModels, listProviderCatalog } from './available-models';
import { readUserAccountUsage } from './account-usage';
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

/** Every UserDO call `/api/user/*` makes, joined because one dispatcher holds one stub for all. */
export type UserRoutesAuthority = CloudWorkspaceRegistry & Pick<
  UserDO,
  'ensureProfile' | 'userMcp_warmConnections' | 'getProfile' | 'getProfileCatalog' | 'putProfileCatalog'
  | 'listWorkspaces' | 'touchWorkspace' | 'removeWorkspace'
  | 'listDevices' | 'acknowledgeUnstoppedDevice' | 'revokeDevice' | 'renameDevice' | 'listDeviceConsents'
  | 'setDeviceTier' | 'revokeDeviceConsent'
  | 'listCredentials' | 'setCredential' | 'deleteCredential' | 'listActiveWorkspaces' | 'getAuthHeaders'
  | 'getCodexStatus' | 'disconnectCodex' | 'startCodexDeviceFlow' | 'pollCodexDeviceFlow'
  | 'listConfig' | 'getConfig' | 'setConfig' | 'listConnectedProviders'
  | 'listCloudflareAccounts' | 'selectCloudflareAccount' | 'listAIGateways' | 'selectAIGateway'
  | 'userMcp_list' | 'userMcp_presets' | 'userMcp_add' | 'userMcp_remove' | 'userMcp_update'
  | 'userMcp_handleOAuthCallback'
>;

export interface UserRoutesEnv<Id> extends CreateWorkspaceEnv<Id>, AdminGateEnv {
  UserDO: ObjectNamespace<Id, UserRoutesAuthority>;
  CLI_PUBLIC_ORIGIN?: string;
}

function getUserDOStub<Id>(env: UserRoutesEnv<Id>, userId: string): UserRoutesAuthority {
  return env.UserDO.get(env.UserDO.idFromName(userId));
}

/** Users whose MCP warm-up already started in this isolate; warm once per process so a cold
 *  UserDO reconnects in parallel with the first orchestrator turn, not on its critical path. */
const warmedMcpUsers = new Set<string>();

interface WorkspaceRosterContext {
  readonly stub: Pick<UserDO, 'listWorkspaces'>;
  readonly owner: UserCaller;
  readonly url: URL;
}

/** GET /api/user/workspaces: one roster page; a garbage cursor maps to 400. */
async function listWorkspaceRoster(ctx: WorkspaceRosterContext): Promise<Response> {
  const cursor = ctx.url.searchParams.get('cursor');
  const limitRaw = ctx.url.searchParams.get('limit');
  const limit = limitRaw === null || limitRaw.trim() === '' ? undefined : Number(limitRaw);

  // Roster bounds live in user-do's clampRosterLimit; this only keeps NaN from reaching the
  // registry as a throw instead of a 400.
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

/** A route family: its response, or null when the address is not one of its own. */
type UserRouteFamily = <Id>(route: UserRouteContext<Id>) => Promise<Response | null>;

function cliOriginFor<Id>(env: UserRoutesEnv<Id>, url: URL): string {
  const configured = env.CLI_PUBLIC_ORIGIN ?? '';

  return normalizeCliOrigin(configured === '' ? url.origin : configured);
}

async function handleProfileRoutes<Id>(route: UserRouteContext<Id>): Promise<Response | null> {
  const { request, env, identity, path, method, owner, stub } = route;

  if (path === '/profile' && method === 'GET') {
    const profile = await stub.getProfile(await ownerCaller(env));
    // Uses the same allowlist as `authorizeAdmin` so the nav link and gate agree. Not authorization:
    // Access covers only `/control*` and `/api/control*`, so the gate still checks both halves.
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

/** Bare `/devices/:id` arms are matched before `/devices/consents`, so DELETE `/devices/consents`
 *  revokes a device named `consents`; keep these routes in this order. */
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
  // Owner session only: the UserDO refuses a workspace caller, which could otherwise disable
  // its own sandbox.
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

/** /api/user/credentials*: no secret is readable back. */
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

/** /api/user/config*: the profile catalog has its own route and is refused here. */
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

  if (path === '/usage' && method === 'GET') {
    return json({ body: await readUserAccountUsage(env, stub, await ownerCaller(env)) });
  }

  return null;
}

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

/** Families own disjoint address spaces, so dispatch order carries no meaning. */
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
    // A deployment with no root secret cannot authorize the owner; the error names the secret.
    if (e instanceof OwnerCapabilityUnavailableError) return err(503, e.message);
    throw e;
  }

  const stub = getUserDOStub(env, identity.userId);
  // Every /api/user route passes through this upsert; it is idempotent, so transient
  // DO failures are retried rather than failing the request.
  await retryTransientDO('ensureProfile',
    () => stub.ensureProfile(owner, identity.email, identity.displayName ?? undefined));

  // `ctx` is the Worker's ExecutionContext; waitUntil is a no-op only in a DO
  // (`do.wait_until.no_op`). A failed warm removes the user from the set so the next request retries.
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
    // `userMcp_handleOAuthCallback` validates the `<nonce>.<serverId>` state inside UserDO.
    const result = await stub.userMcp_handleOAuthCallback(owner, request.url);
    // Redirect to settings regardless of outcome; the page polls userMcp_list for status.
    const settingsUrl = new URL('/user/settings/mcp', publicOrigin(request));
    settingsUrl.searchParams.set('mcp_auth', result.ok ? 'ok' : 'failed');

    if (result.error) settingsUrl.searchParams.set('error', result.error.slice(0, 200));

    if (result.serverId) settingsUrl.searchParams.set('server_id', result.serverId);

    return new Response(null, { status: 302, headers: { Location: settingsUrl.toString() } });
  }

  return null;
}

function publicOrigin(request: Request): string {
  // Workers preserves the visitor's scheme and host in `request.url` for proxied requests.
  return new URL(request.url).origin;
}
