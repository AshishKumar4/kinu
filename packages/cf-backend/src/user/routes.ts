/** `/api/user/*`, behind the session gate. `GET /credentials` never returns a secret. */
import { Cause, Effect } from 'effect';
import { Hono, type Context } from 'hono';
import type { UserDO } from './user-do';
import { ROSTER_SOCKET_PATH } from './roster';
import { pictureKey, type PictureBucket } from '../slates/pictures';
import { SlateDirectoryName } from '@kinu.run/core/slates';
import { PROFILE_CATALOG_CONFIG_KEY } from '@kinu.run/core';
import { BOX_SIZE_ORDER } from '@kinu.run/devbox/sizes';
import { accountSandboxSize, SANDBOX_SIZE_CONFIG_KEY } from '../sandbox-size';
import { DEVICE_TIERS, JsonValueSchema } from '@kinu.run/core';
import { diagnostics, authoredRefusal, toKinuError, settle, type KinuError } from '@kinu.run/core/obs';
import { buildCliAuthCommand, buildCliInstallCommand, buildCliSetupCommand, normalizeCliOrigin } from '@kinu.run/core';
import { listAvailableModels, listProviderCatalog, testAvailableModel } from './available-models';
import { readUserAccountUsage } from './account-usage';
import {
  handleCreateWorkspaceRequest, notifyWorkspacesModelSettingsChanged, type CreateWorkspaceEnv,
} from './workspace-access';
import type { CloudWorkspaceRegistry } from './workspace-create';
import type { ObjectNamespace } from '@kinu.run/core';
import { err, isWorkspaceName, json, safeJson, safeJsonParse } from '@kinu.run/core';
import { retryTransientDO } from '@kinu.run/core';
import type { UserCaller } from '@kinu.run/core';
import { isControlPlaneOperator, type AdminGateEnv } from '../control-plane/admin-caller';
import { ownerGate, rawParam, type ApiVariables, type FamilyEnv } from '../api/context';
import * as v from 'valibot';

const OptionalLabelSchema = v.object({ label: v.optional(v.string()) });

const CheckpointSchema = v.array(v.object({ key: v.string(), sealed: v.string() }));

/** Every UserDO call `/api/user/*` makes: one gate holds one stub. */
export type UserRoutesAuthority = CloudWorkspaceRegistry & Pick<
  UserDO,
  'ensureProfile' | 'userMcp_warmConnections' | 'getProfile' | 'getProfileCatalog' | 'putProfileCatalog'
  | 'fetch' | 'listWorkspaces' | 'touchWorkspace' | 'removeWorkspace' | 'hasWorkspace'
  | 'listDevices' | 'acknowledgeUnstoppedDevice' | 'revokeDevice' | 'renameDevice' | 'listDeviceConsents'
  | 'setDeviceTier' | 'revokeDeviceConsent'
  | 'listCredentials' | 'setCredential' | 'deleteCredential' | 'checkpointCredentials' | 'restoreCredentials' | 'listUnrevokedGrants' | 'dismissUnrevokedGrant' | 'listActiveWorkspaces' | 'getAuthHeaders'
  | 'getCodexStatus' | 'disconnectCodex' | 'startCodexDeviceFlow' | 'pollCodexDeviceFlow' | 'startClaudeSignIn' | 'finishClaudeSignIn'
  | 'chatgptPlan' | 'startChatGptSignIn' | 'cancelChatGptSignIn' | 'startChatGptPasteSignIn' | 'finishChatGptPasteSignIn' | 'signOutChatGpt'
  | 'listConfig' | 'getConfig' | 'setConfig' | 'listConnectedProviders'
  | 'listCloudflareAccounts' | 'selectCloudflareAccount' | 'listAIGateways' | 'selectAIGateway'
  | 'userMcp_list' | 'userMcp_presets' | 'userMcp_add' | 'userMcp_remove' | 'userMcp_update'
  | 'userMcp_handleOAuthCallback'
>;

export interface UserRoutesEnv<Id> extends CreateWorkspaceEnv<Id>, AdminGateEnv {
  UserDO: ObjectNamespace<Id, UserRoutesAuthority>;
  SLATE_PICTURES?: PictureBucket;
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

const RosterBucketSchema = v.optional(v.picklist(['needs', 'working', 'idle']));

/** GET /api/user/workspaces: one roster page; a garbage cursor maps to 400. */
function listWorkspaceRoster(c: UserContext): Effect.Effect<Response, KinuError> {
  const url = new URL(c.req.url);
  const cursor = url.searchParams.get('cursor');
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null || limitRaw.trim() === '' ? undefined : Number(limitRaw);
  const bucket = v.safeParse(RosterBucketSchema, url.searchParams.get('bucket') ?? undefined);
  const query = url.searchParams.get('q') ?? undefined;

  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    return Effect.succeed(err(400, 'Workspace roster limit must be a positive integer.'));
  }

  if (!bucket.success) return Effect.succeed(err(400, 'Workspace roster bucket must be needs, working or idle.'));

  return Effect.catchCause(Effect.gen(function* () {
    return json({ body: yield* Effect.promise(() => c.get('stub').listWorkspaces(c.get('owner'), { cursor, limit, bucket: bucket.output, query })) });
  }), (failed) => Effect.fail(authoredRefusal({ doing: 'listing your workspaces', cause: Cause.squash(failed) })));
}

function cliOriginFor(c: UserContext): string {
  const configured = c.env.CLI_PUBLIC_ORIGIN ?? '';

  return normalizeCliOrigin(configured === '' ? new URL(c.req.url).origin : configured);
}

/** Workers preserves the visitor's scheme and host in `request.url` for proxied requests. */
function publicOrigin(c: UserContext): string {
  return new URL(c.req.url).origin;
}

/** Credential and profile writes reach live workspaces via waitUntil. */
function modelSettingsChanged(c: UserContext): void {
  notifyWorkspacesModelSettingsChanged(c.env, c.get('stub'), c.executionCtx);
}

type CatalogWrite = (
  catalog: Parameters<UserDO['putProfileCatalog']>[1], expectedVersion: number,
) => ReturnType<UserDO['putProfileCatalog']>;

/** A profile-catalog `PUT`, from the browser or the CLI; `changed` tells the owner's workspaces once it landed. */
export async function answerCatalogPut(request: Request, write: CatalogWrite, changed: () => void): Promise<Response> {
  const body = await safeJson(request, v.object({ catalog: JsonValueSchema, expectedVersion: v.number() }));

  if (!body) return err(400, 'Body must be { catalog, expectedVersion }.');
  const result = await write(body.catalog, body.expectedVersion);

  if (result.ok) {
    changed();

    return json({ body: result.envelope });
  }

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

function mcpRead<Body>(read: (stub: UserRoutesAuthority, owner: UserCaller) => Promise<Body>) {
  return async (c: UserContext): Promise<Response> => json({ body: await read(c.get('stub'), c.get('owner')) });
}

export const userRoutes = new Hono<FamilyEnv<UserRoutesEnv<unknown>, UserVariables>>();

userRoutes.use('/api/user/*', ownerGate(), async (c, next) => {
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

    c.executionCtx.waitUntil(settle(Effect.catchCause(Effect.promise(() => stub.userMcp_warmConnections(owner)), (failed) => Effect.sync(() => {
      warmedMcpUsers.delete(identity.userId);
      diagnostics.failure('user.bootstrap_failed', toKinuError({
        doing: 'bootstrapping the user on first hit in this isolate',
        cause: Cause.squash(failed),
        otherwise: 'unavailable',
      }), { step: 'mcp_warm', userId: identity.userId });
    }))));
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
  (catalog, expectedVersion) => c.get('stub').putProfileCatalog(c.get('owner'), catalog, expectedVersion),
  () => { modelSettingsChanged(c); }));

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

userRoutes.get('/api/user/workspaces', (c) => settle(listWorkspaceRoster(c)));

// A socket cannot cross RPC; its upgrade request can.
userRoutes.get('/api/user/workspaces/live', async (c) => c.get('stub').fetch(new Request(new URL(ROSTER_SOCKET_PATH, c.req.url), c.req.raw)));

const PictureSchema = v.object({
  workspace: v.pipe(v.string(), v.check(isWorkspaceName)),
  slate: SlateDirectoryName,
  digest: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
});

userRoutes.get('/api/user/pictures/:workspace/:slate/:digest', async (c) => {
  const picture = v.safeParse(PictureSchema, c.req.param());
  const bucket = c.env.SLATE_PICTURES;

  if (!picture.success || bucket === undefined) return err(404, 'No such picture.');
  const { workspace, slate, digest } = picture.output;

  if (!await c.get('stub').hasWorkspace(c.get('owner'), workspace)) return err(404, 'No such picture.');
  const object = await bucket.get(pictureKey(workspace, slate, digest));

  if (object === null) return err(404, 'No such picture.');

  return new Response(object.body, {
    headers: { 'content-type': 'image/webp', 'cache-control': 'private, max-age=31536000, immutable', etag: object.httpEtag },
  });
});

userRoutes.post('/api/user/workspaces', async (c) => handleCreateWorkspaceRequest({
  request: c.req.raw, env: c.env, userId: c.get('identity').userId, userDO: c.get('stub'),
}));

// A visit the roster did not take is a 404: the workspace is gone, or not visitable while it is created or torn down,
// and a client that keeps a workspace alive by its visits must hear that rather than an `ok`.
userRoutes.post('/api/user/workspaces/:name/touch', (c) => settle(Effect.tryPromise({
  try: async () => {
    const touched = await c.get('stub').touchWorkspace(c.get('owner'), decodeURIComponent(rawParam(c, 'name')));

    return touched ? json({ body: { ok: true } }) : err(404, 'No such workspace.');
  },
  catch: (cause) => authoredRefusal({ doing: 'recording this workspace visit', cause }),
})));

userRoutes.delete('/api/user/workspaces/:name', (c) => settle(Effect.tryPromise({
  try: async () => {
    await c.get('stub').removeWorkspace(c.get('owner'), decodeURIComponent(rawParam(c, 'name')), c.get('identity').userId);

    return json({ body: { ok: true } });
  },
  catch: (cause) => authoredRefusal({ doing: 'deleting this workspace', cause }),
})));

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

userRoutes.delete('/api/user/devices/:id/unstopped', (c) => settle(Effect.tryPromise({
  try: async () => {
    const result = await c.get('stub').acknowledgeUnstoppedDevice(c.get('owner'), decodeURIComponent(rawParam(c, 'id')));

    if (!result.ok) return err(404, 'No incident matched this revoked device');

    return json({ body: { ok: true } });
  },
  catch: (cause) => authoredRefusal({ doing: 'acknowledging this device', cause }),
})));

// `/devices/:id` also matches `/devices/consents`.
userRoutes.delete('/api/user/devices/:id', (c) => settle(Effect.tryPromise({
  try: async () => {
    const result = await c.get('stub').revokeDevice(c.get('owner'), decodeURIComponent(rawParam(c, 'id')));

    return json({ body: result });
  },
  catch: (cause) => authoredRefusal({ doing: 'revoking this device', cause }),
})));

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

userRoutes.post('/api/user/credentials/:key', (c) => {
  return settle(Effect.gen(function* () {
    const body = yield* Effect.promise(async () => safeJson(c.req.raw, JsonValueSchema));

    if (body === null) return err(400, 'Body must be JSON');

    yield* Effect.tryPromise({
      try: async () => {
        await c.get('stub').setCredential(c.get('owner'), c.get('key'), body);
      },
      catch: (cause) => authoredRefusal({ doing: 'storing this credential', cause }),
    });

    modelSettingsChanged(c);

    return json({ body: { ok: true } });
  }));
});

userRoutes.delete('/api/user/credentials/:key', (c) => {
  return settle(Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: async () => {
        await c.get('stub').deleteCredential(c.get('owner'), c.get('key'));
      },
      catch: (cause) => authoredRefusal({ doing: 'deleting this credential', cause }),
    });

    modelSettingsChanged(c);

    return json({ body: { ok: true } });
  }));
});

/** The eval identity's own credentials, carried across a reset by scripts/credential-checkpoint.ts; no other identity's. */
userRoutes.on(['GET', 'POST'], '/api/user/credential-checkpoint', async (c) => {
  const { provider, userId } = c.get('identity');

  if (provider !== 'dev') return err(404, 'No such user route');

  if (c.req.method === 'GET') return json({ body: await c.get('stub').checkpointCredentials(c.get('owner'), userId) });
  const checkpoint = await safeJson(c.req.raw, CheckpointSchema);

  if (checkpoint === null) return err(400, 'Body must be a credential checkpoint');

  return json({ body: { restored: await c.get('stub').restoreCredentials(c.get('owner'), userId, checkpoint) } });
});

userRoutes.get('/api/user/unrevoked-grants', async (c) => json({ body: await c.get('stub').listUnrevokedGrants(c.get('owner')) }));

userRoutes.delete('/api/user/unrevoked-grants/:key', async (c) => {
  await c.get('stub').dismissUnrevokedGrant(c.get('owner'), decodeURIComponent(rawParam(c, 'key')));

  return json({ body: { ok: true } });
});

userRoutes.get('/api/user/codex', async (c) => json({ body: await c.get('stub').getCodexStatus(c.get('owner')) }));

userRoutes.delete('/api/user/codex', async (c) => {
  await c.get('stub').disconnectCodex(c.get('owner'));
  modelSettingsChanged(c);

  return json({ body: { ok: true } });
});

/** An empty body signs in the main account; `{ account }` signs in `codex.oauth@<account>`. */
userRoutes.post('/api/user/codex/start', (c) => settle(Effect.tryPromise({
  try: async () => {
    const body = await c.req.text();
    const named = body === '' ? undefined : v.safeParse(v.object({ account: v.string() }), safeJsonParse(body));

    if (named !== undefined && !named.success) return err(400, 'Body must be empty or { account }');

    return json({ body: await c.get('stub').startCodexDeviceFlow(c.get('owner'), named?.output.account) });
  },
  catch: (cause) => toKinuError({ doing: 'starting the Codex sign-in', cause, otherwise: 'unavailable' }),
})));

async function answerSettingsRead<T>(c: UserContext, read: Promise<T>, moved: (value: T) => boolean): Promise<Response> {
  const value = await read;

  if (moved(value)) modelSettingsChanged(c);

  return json({ body: value });
}

userRoutes.post('/api/user/codex/poll', (c) => settle(Effect.tryPromise({
  try: () => answerSettingsRead(c, c.get('stub').pollCodexDeviceFlow(c.get('owner')), (status) => status.connected),
  catch: (cause) => toKinuError({ doing: 'checking the Codex sign-in', cause, otherwise: 'unavailable' }),
})));

userRoutes.get('/api/user/chatgpt', async (c) => answerSettingsRead(c, c.get('stub').chatgptPlan(c.get('owner')), (plan) => plan.changed));

userRoutes.post('/api/user/chatgpt/sign-in', async (c) => json({ body: await c.get('stub').startChatGptSignIn(c.get('owner')) }));

userRoutes.delete('/api/user/chatgpt/sign-in', async (c) => {
  await c.get('stub').cancelChatGptSignIn(c.get('owner'));

  return json({ body: { cancelled: true } });
});

userRoutes.post('/api/user/chatgpt/paste/start', (c) => settle(Effect.tryPromise({
  try: async () => {
    const body = await c.req.text();
    const named = v.safeParse(v.object({ account: v.optional(v.string()) }), body === '' ? {} : safeJsonParse(body));

    if (!named.success) return err(400, 'Body must be empty or { account }');

    return json({ body: await c.get('stub').startChatGptPasteSignIn(c.get('owner'), named.output.account) });
  },
  catch: (cause) => toKinuError({ doing: 'starting the ChatGPT sign-in', cause, otherwise: 'unavailable' }),
})));

userRoutes.post('/api/user/chatgpt/paste/finish', async (c) => {
  const body = await safeJson(c.req.raw, v.object({ url: v.string() }));

  if (body === null) return err(400, 'Body must be { url }');
  const finished = await c.get('stub').finishChatGptPasteSignIn(c.get('owner'), body.url);

  if (finished.outcome === 'signed_in') modelSettingsChanged(c);

  return json({ body: finished });
});

userRoutes.delete('/api/user/chatgpt', async (c) => {
  const signedOut = await c.get('stub').signOutChatGpt(c.get('owner'));
  modelSettingsChanged(c);

  return json({ body: signedOut });
});

userRoutes.post('/api/user/claude/start', async (c) => json({ body: await c.get('stub').startClaudeSignIn(c.get('owner')) }));

userRoutes.post('/api/user/claude/finish', async (c) => {
  const body = await safeJson(c.req.raw, v.object({ code: v.string() }));

  if (body === null) return err(400, 'Body must be { code }');
  const status = await c.get('stub').finishClaudeSignIn(c.get('owner'), body.code);

  if (status.connected) modelSettingsChanged(c);

  return json({ body: status });
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

  if (c.get('key') === SANDBOX_SIZE_CONFIG_KEY && accountSandboxSize(body.value) === null) {
    return err(400, `${SANDBOX_SIZE_CONFIG_KEY} must be one of ${BOX_SIZE_ORDER.join(', ')}.`);
  }

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

userRoutes.post('/api/user/models/test', async (c) => {
  const body = await safeJson(c.req.raw, v.object({ spec: v.pipe(v.string(), v.minLength(3)) }));

  if (!body) return err(400, 'spec (string) required');

  return json({ body: await testAvailableModel({
    env: c.env, userId: c.get('identity').userId, caller: c.get('owner'), spec: body.spec, signal: c.req.raw.signal,
  }) });
});

userRoutes.get('/api/user/usage', async (c) => json({ body: await readUserAccountUsage({
  env: c.env, userDO: c.get('stub'), owner: c.get('owner'), userId: c.get('identity').userId, refresh: c.req.query('refresh') === '1',
}) }));

userRoutes.get('/api/user/cloudflare/accounts', async (c) => json({ body: await c.get('stub').listCloudflareAccounts(c.get('owner')) }));

userRoutes.put('/api/user/cloudflare/account', (c) => {
  return settle(Effect.gen(function* () {
    const body = yield* Effect.promise(async () => safeJson(c.req.raw, v.object({ id: v.string() })));

    if (!body) return err(400, 'id (string) required');

    yield* Effect.tryPromise({
      try: async () => {
        await c.get('stub').selectCloudflareAccount(c.get('owner'), body.id);
      },
      catch: (cause) => authoredRefusal({ doing: 'selecting this Cloudflare account', cause }),
    });

    modelSettingsChanged(c);

    return json({ body: { ok: true } });
  }));
});

userRoutes.get('/api/user/cloudflare/gateways', async (c) => json({ body: await c.get('stub').listAIGateways(c.get('owner')) }));

userRoutes.put('/api/user/cloudflare/gateway', (c) => {
  return settle(Effect.gen(function* () {
    const body = yield* Effect.promise(async () => safeJson(c.req.raw, v.object({ id: v.nullable(v.string()) })));

    if (!body) {
      return err(400, 'id (string | null) required');
    }

    yield* Effect.tryPromise({
      try: async () => {
        await c.get('stub').selectAIGateway(c.get('owner'), body.id);
      },
      catch: (cause) => authoredRefusal({ doing: 'selecting this AI Gateway', cause }),
    });

    modelSettingsChanged(c);

    return json({ body: { ok: true } });
  }));
});

userRoutes.get('/api/user/mcp/servers', mcpRead((stub, owner) => stub.userMcp_list(owner)));

userRoutes.get('/api/user/mcp/presets', mcpRead((stub, owner) => stub.userMcp_presets(owner)));

userRoutes.post('/api/user/mcp/servers', (c) => {
  return settle(Effect.gen(function* () {
    const body = yield* Effect.promise(async () => safeJson(c.req.raw, JsonValueSchema));

    if (body === null) return err(400, 'Body must be JSON');

    return yield* Effect.tryPromise({
      try: async () => {
        return json({ body: await c.get('stub').userMcp_add(c.get('owner'), body, publicOrigin(c)) }, { status: 201 });
      },
      catch: (cause) => authoredRefusal({ doing: 'adding this MCP server', cause }),
    });
  }));
});

userRoutes.all('/api/user/mcp/servers/:id', async (c, next) => {
  c.set('key', decodeURIComponent(rawParam(c, 'id')));
  await next();
});

userRoutes.delete('/api/user/mcp/servers/:id', (c) => settle(Effect.tryPromise({
  try: async () => {
    await c.get('stub').userMcp_remove(c.get('owner'), c.get('key'));

    return json({ body: { ok: true } });
  },
  catch: (cause) => authoredRefusal({ doing: 'removing this MCP server', cause }),
})));

userRoutes.patch('/api/user/mcp/servers/:id', (c) => {
  return settle(Effect.gen(function* () {
    const body = yield* Effect.promise(async () => safeJson(c.req.raw, JsonValueSchema));

    if (body === null) return err(400, 'Body must be JSON');

    return yield* Effect.tryPromise({
      try: async () => {
        await c.get('stub').userMcp_update(c.get('owner'), c.get('key'), body);

        return json({ body: { ok: true } });
      },
      catch: (cause) => authoredRefusal({ doing: 'updating this MCP server', cause }),
    });
  }));
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

userRoutes.all('/api/user/*', async (c) =>
  err(404, `No such user route: ${c.req.method} ${c.req.path.slice('/api/user'.length)}`));
