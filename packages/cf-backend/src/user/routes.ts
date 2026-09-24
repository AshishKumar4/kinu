/** `/api/user/*`, behind the session gate. `GET /credentials` never returns a secret. */
import { Hono, type Context } from 'hono';
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
import type { UserCaller } from '@kinu.run/core';
import { isControlPlaneOperator, type AdminGateEnv } from '../control-plane/admin-caller';
import { ownerGate, rawParam, type ApiVariables, type FamilyEnv } from '../api/context';
import * as v from 'valibot';

const OptionalLabelSchema = v.object({ label: v.optional(v.string()) });

/** Every UserDO call `/api/user/*` makes: one gate holds one stub. */
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

interface UserVariables extends ApiVariables {
  owner: UserCaller;
  stub: UserRoutesAuthority;
  key: string;
}

type UserContext = Context<FamilyEnv<UserRoutesEnv<unknown>, UserVariables>>;

/** Users whose MCP warm-up already started in this isolate; warm once per process so a cold
 *  UserDO reconnects in parallel with the first orchestrator turn, not on its critical path. */
const warmedMcpUsers = new Set<string>();

/** GET /api/user/workspaces: one roster page; a garbage cursor maps to 400. */
async function listWorkspaceRoster(c: UserContext): Promise<Response> {
  const url = new URL(c.req.url);
  const cursor = url.searchParams.get('cursor');
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null || limitRaw.trim() === '' ? undefined : Number(limitRaw);

  // Roster bounds live in user-do's clampRosterLimit; this only keeps NaN from reaching the
  // registry as a throw instead of a 400.
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    return err(400, 'Workspace roster limit must be a positive integer.');
  }

  try {
    return json({ body: await c.get('stub').listWorkspaces(c.get('owner'), { cursor, limit }) });
  } catch (e) {
    const message = renderThrownChain({ cause: e });

    // Matched by message because the DO RPC boundary carries no error class.
    // User-do holds this string verbatim as wire contract.
    if (message.startsWith('Invalid workspace roster cursor')) return err(400, message);
    throw e;
  }
}

function cliOriginFor(c: UserContext): string {
  const configured = c.env.CLI_PUBLIC_ORIGIN ?? '';

  return normalizeCliOrigin(configured === '' ? new URL(c.req.url).origin : configured);
}

/** Workers preserves the visitor's scheme and host in `request.url` for proxied requests. */
function publicOrigin(c: UserContext): string {
  return new URL(c.req.url).origin;
}

/** Credential writes refresh live workspaces' provider caches via waitUntil. */
function credentialsChanged(c: UserContext): void {
  notifyWorkspacesCredentialsChanged(c.env, c.get('stub'), c.executionCtx);
}

type CatalogWrite = (
  catalog: Parameters<UserDO['putProfileCatalog']>[1], expectedVersion: number,
) => ReturnType<UserDO['putProfileCatalog']>;

/** A profile-catalog `PUT`, from the browser or the CLI. */
export async function answerCatalogPut(request: Request, write: CatalogWrite): Promise<Response> {
  const body = await safeJson(request, v.object({ catalog: JsonValueSchema, expectedVersion: v.number() }));

  if (!body) return err(400, 'Body must be { catalog, expectedVersion }.');
  const result = await write(body.catalog, body.expectedVersion);

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

/** A failed MCP read is a 500 naming it. */
function mcpRead<Body>(read: (stub: UserRoutesAuthority, owner: UserCaller) => Promise<Body>) {
  return async (c: UserContext): Promise<Response> => {
    try { return json({ body: await read(c.get('stub'), c.get('owner')) }); }
    catch (e) { return err(500, renderThrownChain({ cause: e })); }
  };
}

export const userRoutes = new Hono<FamilyEnv<UserRoutesEnv<unknown>, UserVariables>>();

// `/api/user*`: every path starting with the text.
userRoutes.use('/api/user*', ownerGate(), async (c, next) => {
  const identity = c.get('identity');
  const owner = c.get('owner');
  const stub = c.env.UserDO.get(c.env.UserDO.idFromName(identity.userId));
  // Every /api/user route passes through this upsert; it is idempotent, so transient
  // DO failures are retried rather than failing the request.
  await retryTransientDO('ensureProfile',
    () => stub.ensureProfile(owner, identity.email, identity.displayName ?? undefined));

  // waitUntil is a no-op only in a DO (`do.wait_until.no_op`). A failed warm removes the user from
  // the set so the next request retries.
  if (!warmedMcpUsers.has(identity.userId)) {
    warmedMcpUsers.add(identity.userId);

    const warmMcp = async (): Promise<void> => {
      try {
        await stub.userMcp_warmConnections(owner);
      } catch (cause) {
        warmedMcpUsers.delete(identity.userId);
        diagnostics.failure('user.bootstrap_failed', toKinuError({
          doing: 'bootstrapping the user on first hit in this isolate',
          cause,
          otherwise: 'unavailable',
        }), { step: 'mcp_warm', userId: identity.userId });
      }
    };

    c.executionCtx.waitUntil(warmMcp());
  }

  c.set('stub', stub);
  await next();
});

userRoutes.get('/api/user/profile', async (c) => {
  const profile = await c.get('stub').getProfile(c.get('owner'));
  // Uses the same allowlist as `authorizeAdmin` so the nav link and gate agree. Not authorization:
  // Access covers only `/control*` and `/api/control*`, so the gate still checks both halves.
  const controlPlane = isControlPlaneOperator(c.env, c.get('identity'));

  return json({ body: profile === null ? null : { ...profile, controlPlane } });
});

userRoutes.get('/api/user/profile-catalog', async (c) => json({ body: await c.get('stub').getProfileCatalog(c.get('owner')) }));

userRoutes.put('/api/user/profile-catalog', async (c) => answerCatalogPut(c.req.raw,
  (catalog, expectedVersion) => c.get('stub').putProfileCatalog(c.get('owner'), catalog, expectedVersion)));

userRoutes.get('/api/user/cli', async (c) => {
  const cliOrigin = cliOriginFor(c);

  return json({
    body: {
      publicOrigin: cliOrigin,
      installCommand: buildCliInstallCommand({ origin: cliOrigin }),
      setupCommand: buildCliSetupCommand(cliOrigin),
      authCommand: buildCliAuthCommand(cliOrigin),
    },
  });
});

userRoutes.get('/api/user/workspaces', listWorkspaceRoster);

userRoutes.post('/api/user/workspaces', async (c) => handleCreateWorkspaceRequest({
  request: c.req.raw, env: c.env, userId: c.get('identity').userId, userDO: c.get('stub'),
}));

userRoutes.post('/api/user/workspaces/:name/touch', async (c) => {
  try {
    await c.get('stub').touchWorkspace(c.get('owner'), decodeURIComponent(rawParam(c, 'name')));

    return json({ body: { ok: true } });
  }
  catch (e) { return err(400, renderThrownChain({ cause: e })); }
});

userRoutes.delete('/api/user/workspaces/:name', async (c) => {
  try {
    await c.get('stub').removeWorkspace(c.get('owner'), decodeURIComponent(rawParam(c, 'name')), c.get('identity').userId);

    return json({ body: { ok: true } });
  }
  catch (e) { return err(400, renderThrownChain({ cause: e })); }
});

userRoutes.get('/api/user/devices', async (c) => json({ body: await c.get('stub').listDevices(c.get('owner')) }));

userRoutes.post('/api/user/devices', async (c) => {
  const body = await safeJson(c.req.raw, OptionalLabelSchema);
  const cliOrigin = cliOriginFor(c);

  const installCommand = buildCliInstallCommand({
    origin: cliOrigin,
    setup: false,
    connect: true,
    label: body?.label,
  });

  return json({ body: { origin: cliOrigin, installCommand } }, { status: 201 });
});

userRoutes.delete('/api/user/devices/:id/unstopped', async (c) => {
  try {
    const result = await c.get('stub').acknowledgeUnstoppedDevice(c.get('owner'), decodeURIComponent(rawParam(c, 'id')));

    if (!result.ok) return err(404, 'No incident matched this revoked device');

    return json({ body: { ok: true } });
  } catch (e) {
    return err(400, renderThrownChain({ cause: e }));
  }
});

// `/devices/:id` also matches `/devices/consents`.
userRoutes.delete('/api/user/devices/:id', async (c) => {
  try {
    const result = await c.get('stub').revokeDevice(c.get('owner'), decodeURIComponent(rawParam(c, 'id')));

    return json({ body: result });
  } catch (e) {
    return err(400, renderThrownChain({ cause: e }));
  }
});

userRoutes.patch('/api/user/devices/:id', async (c) => {
  const body = await safeJson(c.req.raw, v.object({ name: v.optional(v.string()) }));
  const name = body?.name?.trim();

  if (!name) return err(400, 'Body must be { name }');
  const result = await c.get('stub').renameDevice(c.get('owner'), decodeURIComponent(rawParam(c, 'id')), name);

  if (!result.ok) return err(404, 'device not found');

  return json({ body: { ok: true } });
});

userRoutes.get('/api/user/devices/consents', async (c) => json({ body: await c.get('stub').listDeviceConsents(c.get('owner')) }));

// Owner session only: the UserDO refuses a workspace caller, which could otherwise disable its own sandbox.
userRoutes.put('/api/user/devices/:id/sandbox', async (c) => {
  const body = await safeJson(c.req.raw, v.object({ tier: v.optional(v.picklist(DEVICE_TIERS)) }));
  const tier = body?.tier;

  if (!tier) return err(400, `Body must be { tier: ${DEVICE_TIERS.map((t) => `'${t}'`).join(' | ')} }`);
  const result = await c.get('stub').setDeviceTier(c.get('owner'), decodeURIComponent(rawParam(c, 'id')), tier);

  if (!result.ok) return err(404, 'device not found');

  return json({ body: { ok: true } });
});

userRoutes.delete('/api/user/devices/:id/consent', async (c) => {
  const agentName = new URL(c.req.url).searchParams.get('agentName')?.trim();

  if (!agentName) return err(400, 'Query must carry ?agentName=');

  const result = await c.get('stub').revokeDeviceConsent(
    c.get('owner'), agentName, decodeURIComponent(rawParam(c, 'id')),
  );

  if (!result.ok) return err(400, 'grant not revoked');

  return json({ body: { ok: true } });
});

userRoutes.get('/api/user/credentials', async (c) => json({ body: await c.get('stub').listCredentials(c.get('owner')) }));

userRoutes.all('/api/user/credentials/:key', async (c, next) => {
  c.set('key', decodeURIComponent(rawParam(c, 'key')));
  await next();
});

userRoutes.post('/api/user/credentials/:key', async (c) => {
  const body = await safeJson(c.req.raw, JsonValueSchema);

  if (body === null) return err(400, 'Body must be JSON');

  try { await c.get('stub').setCredential(c.get('owner'), c.get('key'), body); }
  catch (e) { return err(400, renderThrownChain({ cause: e })); }

  credentialsChanged(c);

  return json({ body: { ok: true } });
});

userRoutes.delete('/api/user/credentials/:key', async (c) => {
  try { await c.get('stub').deleteCredential(c.get('owner'), c.get('key')); }
  catch (e) { return err(400, renderThrownChain({ cause: e })); }

  credentialsChanged(c);

  return json({ body: { ok: true } });
});

userRoutes.get('/api/user/codex', async (c) => json({ body: await c.get('stub').getCodexStatus(c.get('owner')) }));

userRoutes.delete('/api/user/codex', async (c) => {
  await c.get('stub').disconnectCodex(c.get('owner'));
  credentialsChanged(c);

  return json({ body: { ok: true } });
});

userRoutes.post('/api/user/codex/start', async (c) => {
  try { return json({ body: await c.get('stub').startCodexDeviceFlow(c.get('owner')) }); }
  catch (e) { return err(502, renderThrownChain({ cause: e })); }
});

userRoutes.post('/api/user/codex/poll', async (c) => {
  try {
    const status = await c.get('stub').pollCodexDeviceFlow(c.get('owner'));

    if (status.connected) credentialsChanged(c);

    return json({ body: status });
  } catch (e) { return err(502, renderThrownChain({ cause: e })); }
});

userRoutes.get('/api/user/config', async (c) => json({ body: await c.get('stub').listConfig(c.get('owner')) }));

// Refused whatever the method.
userRoutes.all('/api/user/config/:key', async (c, next) => {
  const key = decodeURIComponent(rawParam(c, 'key'));

  if (key === PROFILE_CATALOG_CONFIG_KEY) return err(400, 'Profile catalogs use /api/user/profile-catalog.');
  c.set('key', key);
  await next();
});

userRoutes.get('/api/user/config/:key', async (c) => {
  const key = c.get('key');

  return json({ body: { key, value: await c.get('stub').getConfig(c.get('owner'), key) } });
});

userRoutes.put('/api/user/config/:key', async (c) => {
  const body = await safeJson(c.req.raw, v.object({ value: v.string() }));

  if (!body) return err(400, 'value (string) required');
  await c.get('stub').setConfig(c.get('owner'), c.get('key'), body.value);

  return json({ body: { ok: true } });
});

userRoutes.get('/api/user/providers', async (c) => json({ body: await c.get('stub').listConnectedProviders(c.get('owner')) }));

userRoutes.get('/api/user/providers/catalog', async (c) => json({
  body: await listProviderCatalog(c.env, c.get('identity').userId, c.get('owner')),
}));

userRoutes.get('/api/user/models', async (c) => json({
  body: await listAvailableModels(c.env, c.get('identity').userId, c.get('owner')),
}));

userRoutes.get('/api/user/usage', async (c) => json({ body: await readUserAccountUsage(c.env, c.get('stub'), c.get('owner')) }));

userRoutes.get('/api/user/cloudflare/accounts', async (c) => json({ body: await c.get('stub').listCloudflareAccounts(c.get('owner')) }));

userRoutes.put('/api/user/cloudflare/account', async (c) => {
  const body = await safeJson(c.req.raw, v.object({ id: v.string() }));

  if (!body) return err(400, 'id (string) required');

  try { await c.get('stub').selectCloudflareAccount(c.get('owner'), body.id); }
  catch (e) { return err(400, renderThrownChain({ cause: e })); }

  credentialsChanged(c);

  return json({ body: { ok: true } });
});

userRoutes.get('/api/user/cloudflare/gateways', async (c) => json({ body: await c.get('stub').listAIGateways(c.get('owner')) }));

userRoutes.put('/api/user/cloudflare/gateway', async (c) => {
  const body = await safeJson(c.req.raw, v.object({ id: v.nullable(v.string()) }));

  if (!body) {
    return err(400, 'id (string | null) required');
  }

  try { await c.get('stub').selectAIGateway(c.get('owner'), body.id); }
  catch (e) { return err(400, renderThrownChain({ cause: e })); }

  credentialsChanged(c);

  return json({ body: { ok: true } });
});

userRoutes.get('/api/user/mcp/servers', mcpRead((stub, owner) => stub.userMcp_list(owner)));

userRoutes.get('/api/user/mcp/presets', mcpRead((stub, owner) => stub.userMcp_presets(owner)));

userRoutes.post('/api/user/mcp/servers', async (c) => {
  const body = await safeJson(c.req.raw, JsonValueSchema);

  if (body === null) return err(400, 'Body must be JSON');

  try { return json({ body: await c.get('stub').userMcp_add(c.get('owner'), body, publicOrigin(c)) }, { status: 201 }); }
  catch (e) { return err(400, renderThrownChain({ cause: e })); }
});

userRoutes.all('/api/user/mcp/servers/:id', async (c, next) => {
  c.set('key', decodeURIComponent(rawParam(c, 'id')));
  await next();
});

userRoutes.delete('/api/user/mcp/servers/:id', async (c) => {
  try {
    await c.get('stub').userMcp_remove(c.get('owner'), c.get('key'));

    return json({ body: { ok: true } });
  }
  catch (e) { return err(400, renderThrownChain({ cause: e })); }
});

userRoutes.patch('/api/user/mcp/servers/:id', async (c) => {
  const body = await safeJson(c.req.raw, JsonValueSchema);

  if (body === null) return err(400, 'Body must be JSON');

  try {
    await c.get('stub').userMcp_update(c.get('owner'), c.get('key'), body);

    return json({ body: { ok: true } });
  }
  catch (e) { return err(400, renderThrownChain({ cause: e })); }
});

userRoutes.get('/api/user/mcp/callback', async (c) => {
  // `userMcp_handleOAuthCallback` validates the `<nonce>.<serverId>` state inside UserDO.
  const result = await c.get('stub').userMcp_handleOAuthCallback(c.get('owner'), c.req.url);
  // Redirect to settings regardless of outcome; the page polls userMcp_list for status.
  const settingsUrl = new URL('/user/settings/mcp', publicOrigin(c));
  settingsUrl.searchParams.set('mcp_auth', result.ok ? 'ok' : 'failed');

  if (result.error) settingsUrl.searchParams.set('error', result.error.slice(0, 200));

  if (result.serverId) settingsUrl.searchParams.set('server_id', result.serverId);

  return new Response(null, { status: 302, headers: { Location: settingsUrl.toString() } });
});

userRoutes.all('/api/user*', async (c) =>
  err(404, `No such user route: ${c.req.method} ${c.req.path.slice('/api/user'.length)}`));
