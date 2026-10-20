/**
 * The account's own routes, one set for both ways in: a browser's session under `/api/user`, the CLI's bearer under
 * `/api/cli`. The families differ only in who is asking; each family's gate names the account and its owner caller
 * (`account`, `owner`) before these run, and a CLI access token's scopes are checked before that.
 */
import { Effect } from 'effect';
import { Hono, type Context } from 'hono';
import * as v from 'valibot';
import { authoredRefusal, settle } from '@kinu.run/core/obs';
import { err, json, JsonValueSchema, safeJson, SecretPositionSchema, type ProviderEnv, type UserCaller } from '@kinu.run/core';
import type { UserDO } from './user-do';
import { listAvailableModels, testAvailableModel, type AvailableModelsEnv } from './available-models';
import { readUserAccountUsage } from './account-usage';
import { handleCreateWorkspaceRequest, notifyWorkspacesModelSettingsChanged, type CreateWorkspaceEnv } from './workspace-access';
import { handleInstallRequest, installedAssistant } from './blueprint-install';
import type { CloudWorkspaceRegistry } from './workspace-create';
import { rawParam, type FamilyEnv } from '../api/context';

/** Every UserDO call these routes make. */
type AccountApiAuthority = CloudWorkspaceRegistry & Pick<
  UserDO,
  'listCredentials' | 'setCredential' | 'deleteCredential' | 'removeWorkspace' | 'listDevices'
  | 'listSecrets' | 'putSecrets' | 'setSecretDestination' | 'deleteSecret' | 'grantSecret' | 'revokeSecretGrant'
  | 'listActiveWorkspaces' | 'getAuthHeaders' | 'relayDevice' | 'relayModelCall' | 'cancelModelRelay' | 'slateAiSpend'
  | 'getConfig' | 'setConfig' | 'getProfile'
>;

export interface AccountApiEnv<Id> extends CreateWorkspaceEnv<Id>, ProviderEnv {
  UserDO: AvailableModelsEnv<Id>['UserDO'];
}

/** The account a request reaches, as its family's gate named it. */
interface AccountRequest {
  readonly stub: AccountApiAuthority;
  readonly userId: string;
}

export interface AccountApiVariables {
  account: AccountRequest;
  owner: UserCaller;
}

type AccountContext = Context<FamilyEnv<AccountApiEnv<unknown>, AccountApiVariables>>;

/** Credential and model-profile writes reach the owner's live workspaces, or a new provider stays invisible there. */
function modelSettingsChanged(c: AccountContext): void {
  notifyWorkspacesModelSettingsChanged(c.env, c.get('account').stub, c.executionCtx);
}

export const accountApi = new Hono<FamilyEnv<AccountApiEnv<unknown>, AccountApiVariables>>();

/** Never a secret: the stored keys and what kind each is. */
accountApi.get('/credentials', async (c) => json({ body: await c.get('account').stub.listCredentials(c.get('owner')) }));

accountApi.post('/credentials/:key', (c) => settle(Effect.gen(function* () {
  const body = yield* Effect.promise(async () => safeJson(c.req.raw, JsonValueSchema));

  if (body === null) return err(400, 'Body must be JSON');

  yield* Effect.tryPromise({
    try: async () => { await c.get('account').stub.setCredential(c.get('owner'), decodeURIComponent(rawParam(c, 'key')), body); },
    catch: (cause) => authoredRefusal({ doing: 'storing this credential', cause }),
  });

  modelSettingsChanged(c);

  return json({ body: { ok: true } });
})));

/** `?revoke=1` also has the provider revoke the grant; its refusal answers in its own words. */
accountApi.delete('/credentials/:key', (c) => settle(Effect.gen(function* () {
  const outcome = yield* Effect.tryPromise({
    try: async () => c.get('account').stub.deleteCredential(c.get('owner'), decodeURIComponent(rawParam(c, 'key')), c.req.query('revoke') === '1'),
    catch: (cause) => authoredRefusal({ doing: 'deleting this credential', cause }),
  });

  modelSettingsChanged(c);

  return json({ body: { ok: true, ...outcome } });
})));

/** Never a value: names, hosts and where each is granted. */
accountApi.get('/secrets', async (c) => json({ body: await c.get('account').stub.listSecrets(c.get('owner')) }));

const PutSecretsSchema = v.object({
  entries: v.array(v.object({ name: v.string(), hosts: v.array(v.string()), position: SecretPositionSchema, value: v.string() })),
  grantTo: v.array(v.string()),
});

/** Every entry lands, or none does; each is granted to `grantTo`. */
accountApi.post('/secrets', (c) => settle(Effect.gen(function* () {
  const body = yield* Effect.promise(async () => safeJson(c.req.raw, PutSecretsSchema));

  if (body === null) return err(400, 'Body must be JSON: { entries: [{ name, hosts, position, value }], grantTo: [workspace] }');

  yield* Effect.tryPromise({
    try: async () => { await c.get('account').stub.putSecrets(c.get('owner'), body.entries, body.grantTo); },
    catch: (cause) => authoredRefusal({ doing: 'storing these secrets', cause }),
  });

  return json({ body: { ok: true } });
})));

/** Where a secret may go: its hosts, and its one position in a request to them. */
accountApi.put('/secrets/:name/destination', (c) => settle(Effect.gen(function* () {
  const body = yield* Effect.promise(async () => safeJson(c.req.raw, v.object({ hosts: v.array(v.string()), position: SecretPositionSchema })));

  if (body === null) return err(400, 'Body must be JSON: { hosts: [host], position }');

  yield* Effect.tryPromise({
    try: async () => { await c.get('account').stub.setSecretDestination(c.get('owner'), decodeURIComponent(rawParam(c, 'name')), body); },
    catch: (cause) => authoredRefusal({ doing: "changing where this secret may go", cause }),
  });

  return json({ body: { ok: true } });
})));

accountApi.delete('/secrets/:name', (c) => settle(Effect.tryPromise({
  try: async () => {
    await c.get('account').stub.deleteSecret(c.get('owner'), decodeURIComponent(rawParam(c, 'name')));

    return json({ body: { ok: true } });
  },
  catch: (cause) => authoredRefusal({ doing: 'deleting this secret', cause }),
})));

/** `reveal` lets that workspace's agents read the value itself. */
accountApi.put('/secrets/:name/grants/:workspace', (c) => settle(Effect.gen(function* () {
  const body = yield* Effect.promise(async () => safeJson(c.req.raw, v.object({ reveal: v.boolean() })));

  if (body === null) return err(400, 'Body must be JSON: { reveal: boolean }');

  yield* Effect.tryPromise({
    try: async () => {
      await c.get('account').stub.grantSecret(c.get('owner'), {
        name: decodeURIComponent(rawParam(c, 'name')), workspace: decodeURIComponent(rawParam(c, 'workspace')), reveal: body.reveal,
      });
    },
    catch: (cause) => authoredRefusal({ doing: 'allowing this secret in a workspace', cause }),
  });

  return json({ body: { ok: true } });
})));

accountApi.delete('/secrets/:name/grants/:workspace', (c) => settle(Effect.tryPromise({
  try: async () => {
    await c.get('account').stub.revokeSecretGrant(c.get('owner'), {
      name: decodeURIComponent(rawParam(c, 'name')), workspace: decodeURIComponent(rawParam(c, 'workspace')),
    });

    return json({ body: { ok: true } });
  },
  catch: (cause) => authoredRefusal({ doing: 'removing this secret from a workspace', cause }),
})));

accountApi.get('/models', async (c) => json({
  body: await listAvailableModels(c.env, c.get('account').userId, c.get('owner')),
}));

accountApi.post('/models/test', async (c) => {
  const body = await safeJson(c.req.raw, v.object({ spec: v.pipe(v.string(), v.minLength(3)) }));

  if (!body) return err(400, 'spec (string) required');

  return json({ body: await testAvailableModel({
    env: c.env, userId: c.get('account').userId, caller: c.get('owner'), spec: body.spec, signal: c.req.raw.signal,
  }) });
});

accountApi.get('/usage', async (c) => json({ body: await readUserAccountUsage({
  env: c.env, userDO: c.get('account').stub, owner: c.get('owner'), userId: c.get('account').userId, refresh: c.req.query('refresh') === '1',
}) }));

accountApi.post('/workspaces', async (c) => handleCreateWorkspaceRequest({
  request: c.req.raw, env: c.env, userId: c.get('account').userId, userDO: c.get('account').stub,
}));

accountApi.post('/blueprints/:id/install', async (c) => handleInstallRequest({
  request: c.req.raw, env: c.env, userId: c.get('account').userId, userDO: c.get('account').stub, owner: c.get('owner'),
  id: decodeURIComponent(rawParam(c, 'id')),
}));

/** The workspace Home opens on: the owner's Personal assistant, while it is theirs. */
accountApi.get('/assistant', async (c) => json({ body: { workspace: await installedAssistant(c.get('account').stub, c.get('owner')) } }));

/** Answers ok for a workspace already gone: a delete repeated, or raced by another, is done (staging df49f4cc5, nine
 *  DELETEs of one workspace in 2 ms, eight answered 500; kinu-logs/evals-fast/FINDINGS.md F11). */
accountApi.delete('/workspaces/:name', (c) => settle(Effect.tryPromise({
  try: async () => {
    const { stub, userId } = c.get('account');

    await stub.removeWorkspace(c.get('owner'), decodeURIComponent(rawParam(c, 'name')), userId);

    return json({ body: { ok: true } });
  },
  catch: (cause) => authoredRefusal({ doing: 'deleting this workspace', cause }),
})));

accountApi.get('/devices', async (c) => json({ body: await c.get('account').stub.listDevices(c.get('owner')) }));
