// What the public surface cannot drive: a name whose teardown is pending, a workspace's own authority when it hires a
// workspace, and an account with no model it can serve. Role, model, effort and names are the workerd public-surface
// journey's (tests/workerd/wide/public-surface.test.ts).
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  asFetchFunction, BUILTIN_PROFILE_CATALOG, DEFAULT_WORKERS_AI_MODEL_SPEC, profileCatalogDigest, sandboxIdForWorkspace,
  type ProfileCatalog, type ProfileCatalogEnvelope,
} from '@kinu.run/core';
import { handleCreateWorkspaceRequest, type CreateWorkspaceEnv } from '../src/user/workspace-access';
import { createTestUserDO, provisionTestWorkspace, TEST_CREDENTIAL_ENCRYPTION_KEY, testOwner } from './helpers/user-do';
import { acrossRpc } from './helpers/jsrpc-stub';
import { createCloudWorkspaceForUser, type CloudWorkspaceRegistry } from '../src/user/workspace-create';
import { placementFor } from '../src/user/workspace-placement';
import { Hono } from 'hono';
import type { FamilyEnv } from '../src/api/context';
import { serveFamily } from './helpers/api';
import { present } from '@kinu.run/test-utils';
import { userAccount, workspaceObject } from './helpers/bindings';
import type { NameOrigin, ReasoningEffort, UserCaller } from '@kinu.run/core';

const USER_ID = '0123456789abcdef0123456789abcdef';

const AGENT = 'jarvis';

function envelopeWithDefault(model: string): ProfileCatalogEnvelope {
  const catalog: ProfileCatalog = { ...BUILTIN_PROFILE_CATALOG, tiers: { default: { model } } };

  return { authority: { kind: 'account', accountId: USER_ID }, version: 1, digest: profileCatalogDigest(catalog), catalog };
}

interface CreateBody {
  name: string;
  purpose: string;
  role?: string;
  model?: string;
  reasoningEffort?: string;
}

/** An account with Cloudflare connected, whose menu offers the native Workers AI default. */
const CONNECTED = { authorization: 'Bearer token' };

/** The whole route is driven because the request-body-to-input mapping is under test. */
async function postCreate(
  body: CreateBody,
  envelope: ProfileCatalogEnvelope = envelopeWithDefault(DEFAULT_WORKERS_AI_MODEL_SPEC),
  authHeaders: Record<string, string> | null = CONNECTED,
  register?: CloudWorkspaceRegistry['registerWorkspace'],
): Promise<{ status: number; calls: string[]; registered: string[]; error: string | null }> {
  const calls: string[] = [];
  const registered: string[] = [];

  const userDO = userAccount({
    async getWorkspaceProfileCatalog(_caller: UserCaller) { return envelope; },
    async getAuth(_caller: UserCaller) {
      return authHeaders === null ? null : { headers: authHeaders, baseURL: 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1' };
    },
    async listCredentials(_caller: UserCaller) { return []; },
    async ensureWorkspaceCapability() {},
    async registerWorkspace(caller: UserCaller, name: string, displayName?: string, options?: Parameters<CloudWorkspaceRegistry['registerWorkspace']>[3]) {
      registered.push(name);
      calls.push('registered');

      if (register !== undefined) return await register(caller, name, displayName, options);

      return {
        entry: { name, displayName: displayName ?? name, createdAt: 7, lastVisited: 7 },
        status: 'created' as const,
      };
    },
    async releaseWorkspaceReservation() { return true; },
    async removeWorkspace() {},
  });

  const orchestrator = workspaceObject({
    async storedWorkspace() {
      calls.push('read');

      return 0;
    },
    async claimOwner(userId: string, placement?: string) {
      calls.push(`claimed:${String(placement)}`);

      return { owner: userId, capabilityHash: null };
    },
    async setInitialDisplayName(displayName: string, nameOrigin: NameOrigin) { return { displayName, nameOrigin }; },
    async setSoul(soul: string) { return { soul, purpose: '' }; },
    async resetWorkspaceBaseline() { return { ok: true as const, capturedAt: 0, cleanupFailures: [] }; },
    async setModel(spec: string) {
      calls.push(`model:${spec}`);

      return { ok: true, spec };
    },
    async setReasoningEffort(effort: ReasoningEffort | null) {
      calls.push(`effort:${String(effort)}`);

      if (effort === null) throw new Error('setReasoningEffort(null): a create never clears the effort');

      return { ok: true as const, effort };
    },
    async setRole(roleId: string) {
      calls.push(`role:${roleId}`);

      return { role: roleId };
    },
    async beginGenesisTurn() {
      calls.push('genesis');

      return { started: true };
    },
  });

  const env: CreateWorkspaceEnv<string> = {
    UserDO: { idFromName: (name) => name, get: () => userDO },
    OrchestratorAgent: {
      idFromName: (name) => name,
      get: (_id, options) => {
        calls.push(`reached:${String(options?.locationHint)}`);

        return orchestrator;
      },
    },
    KinuDevbox: {
      getByName: (name, options) => ({
        boxSize: async () => {
          calls.push(`computer:${name}:${String(options?.locationHint)}`);

          return { size: 'small' as const, chosen: undefined, running: undefined, startRefused: undefined, stalled: undefined };
        },
      }),
    },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  };

  const originalFetch = globalThis.fetch;
  // No reachable provider: the menu falls back to the native Workers AI default, as production creates do.
  globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));

  try {
    // Served as the app serves it, so a refusal thrown past the handler is answered by the router.
    const family = new Hono<FamilyEnv<CreateWorkspaceEnv<string>, object>>()
      .post('/api/user/workspaces', async (c) => handleCreateWorkspaceRequest({ request: c.req.raw, env: c.env, userId: USER_ID, userDO }));

    const request = new Request('https://kinu.run/api/user/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    // Where Cloudflare read the owner's create from (kinu.run, 2026-10-24: Delhi).
    Object.defineProperty(request, 'cf', { value: { continent: 'AS', longitude: '77.21' } });
    const response = present(await serveFamily(family)(request, env), 'an answer');

    const error = response.ok ? null : v.parse(v.object({ error: v.string() }), await response.json()).error;

    return { status: response.status, calls, registered, error };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('a name whose teardown is still pending', () => {
  test('a create is refused with the object\'s class and reason, across RPC', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID, destroyWorkspaceError: 'the container refused to go' });
    const owner = await testOwner();
    await harness.userDO.registerWorkspace(owner, AGENT);

    await expect(harness.userDO.removeWorkspace(owner, AGENT, USER_ID)).rejects.toThrow();

    const register = acrossRpc((name: string) => harness.userDO.registerWorkspace(owner, name));

    const created = await postCreate({ name: AGENT, purpose: 'Review the checkout flow.' }, undefined, CONNECTED,
      async (_caller, name) => await register(name));

    // `unavailable`: the name frees once its teardown finishes.
    expect(created.status).toBe(503);
    harness.close();
  });
});

describe('a workspace that hires a new workspace', () => {
  test('reads the account default with its own authority, never the owner\'s', async () => {
    // Staging 85a438698, launch-prep: a workspace-scope hire was refused as owner-only.
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const hirer: UserCaller = { workspaceToken: await provisionTestWorkspace(harness, 'launch-prep') };

    // Real authority checks; the menu and the new object are faked as in `postCreate`.
    const userDO = userAccount({
      getProfileCatalog: (caller: UserCaller) => harness.userDO.getProfileCatalog(caller),
      getWorkspaceProfileCatalog: (caller: UserCaller) => harness.userDO.getWorkspaceProfileCatalog(caller),
      registerWorkspace: (caller: UserCaller, name: string, displayName?: string, options?: Parameters<CloudWorkspaceRegistry['registerWorkspace']>[3]) =>
        harness.userDO.registerWorkspace(caller, name, displayName, options),
      async getAuth() { return { headers: CONNECTED, baseURL: 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1' }; },
      async listCredentials() { return []; },
      async ensureWorkspaceCapability() {},
      async releaseWorkspaceReservation() { return true; },
      async removeWorkspace() {},
    });

    const born = workspaceObject({
      async claimOwner(userId: string) { return { owner: userId, capabilityHash: null }; },
      async setInitialDisplayName(displayName: string, nameOrigin: NameOrigin) { return { displayName, nameOrigin }; },
      async setSoul(soul: string) { return { soul, purpose: '' }; },
      async resetWorkspaceBaseline() { return { ok: true as const, capturedAt: 0, cleanupFailures: [] }; },
      async beginGenesisTurn() { return { started: true }; },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));

    try {
      const entry = await createCloudWorkspaceForUser({
        env: {
          UserDO: { idFromName: (name) => name, get: () => userDO },
          OrchestratorAgent: { idFromName: (name) => name, get: () => born },
          CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
        },
        userId: USER_ID, userDO, caller: hirer, input: { purpose: 'Draft the launch notes.' }, placement: 'weur',
      });

      expect((await harness.userDO.listActiveWorkspaces(await testOwner())).map((workspace) => workspace.name)).toContain(entry.name);
    } finally {
      globalThis.fetch = originalFetch;
      harness.close();
    }
  });
});

describe('where a new workspace runs', () => {
  test('one made from Asia, and its computer, are first reached in western Europe before anything else can reach them', async () => {
    // From Delhi, with no hint, the owner's workspace ran in Hong Kong, where Anthropic refuses every call.
    const created = await postCreate({ name: AGENT, purpose: 'Review the checkout flow.' });

    expect(created.status).toBe(201);
    // Placed by a read, and its computer beside it, before its row is published; then claimed with where it was placed.
    expect(created.calls.slice(0, 6)).toEqual(['reached:weur', 'read', `computer:${sandboxIdForWorkspace(AGENT)}:weur`, 'registered', 'reached:weur', 'claimed:weur']);
    expect(created.calls.at(-1)).toBe('genesis');
  });

  test('a maker\'s continent picks a region the model providers serve', () => {
    expect([
      placementFor({ continent: 'NA', longitude: '-122.42' }), placementFor({ continent: 'NA', longitude: '-74.01' }),
      placementFor({ continent: 'SA', longitude: '-46.63' }), placementFor({ continent: 'EU', longitude: '2.35' }),
      placementFor({ continent: 'AF', longitude: '3.38' }), placementFor({ continent: 'AS', longitude: '114.17' }),
      placementFor({ continent: 'OC', longitude: '151.21' }), placementFor(undefined),
    ]).toEqual(['wnam', 'enam', 'enam', 'weur', 'weur', 'weur', 'oc', 'weur']);
  });
});

describe('an account with no model it can serve', () => {
  test('is refused before a workspace exists', async () => {
    // The catalog default names a model no connected provider serves, and nothing is connected to offer another.
    const created = await postCreate(
      { name: AGENT, purpose: 'Review the checkout flow.' },
      envelopeWithDefault('openai-compat:gone/some-model'),
      null,
    );

    // A conflict with the account's setup, not a malformed request: the page offers the settings to fix it.
    expect(created.status).toBe(409);
    expect([created.registered, created.calls]).toEqual([[], []]);
  });
});
