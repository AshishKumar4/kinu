// Defends: account switching must drive the inference base URL, drop the old
// account's AI Gateway, refuse unseen accounts, and notify live workspaces.
import { describe, expect, test } from 'bun:test';
import { asFetchFunction, type OAuthCredential } from '@kinu.run/core';
import { TEST_CREDENTIAL_ENCRYPTION_KEY, createTestUserDO, testOwner } from './helpers/user-do';
import { CLOUDFLARE_OAUTH_CRED_KEY } from '@kinu.run/core';
import { handleUserRequest, type UserRoutesEnv } from '../src/user/routes';
import { bootstrappedProfile, userAccount, workspaceObject } from './helpers/bindings';
import type { AuthIdentity } from '../src/auth/session';
import type { UserCaller } from '@kinu.run/core';
import * as v from 'valibot';

const AccountStatusSchema = v.object({
  connected: v.boolean(),
  selectedId: v.nullable(v.string()),
  accounts: v.array(v.object({ id: v.string(), name: v.string() })),
});

const PERSONAL = { id: 'aaa111aaa111aaa111aaa111aaa111aa', name: 'Personal' };

const EMPLOYER = { id: 'bbb222bbb222bbb222bbb222bbb222bb', name: 'Employer' };

function multiAccountCredential(): OAuthCredential {
  return {
    kind: 'oauth',
    accessToken: 'cf-access',
    refreshToken: 'cf-refresh',
    metadata: {
      tokenType: 'bearer',
      accounts: [PERSONAL, EMPLOYER],
      accountId: PERSONAL.id,
      accountName: PERSONAL.name,
    },
  };
}

/** Two gateways, so gateway auto-select (fires only at exactly one) cannot mask switching. */
function stubGatewayNetwork(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = asFetchFunction(async () => new Response(JSON.stringify({
    success: true,
    result: [
      { id: 'gw-one', authentication: false, created_at: '2026-01-01T00:00:00Z' },
      { id: 'gw-two', authentication: false, created_at: '2026-01-02T00:00:00Z' },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } }));

  return () => { globalThis.fetch = original; };
}

describe('Cloudflare account selection', () => {
  test('no Cloudflare credential means nothing to pick', async () => {
    const harness = createTestUserDO();
    expect(await harness.userDO.listCloudflareAccounts(await testOwner()))
      .toEqual({ connected: false, selectedId: null, accounts: [] });
    harness.close();
  });

  test('the accounts a login can see are listed with the one in use', async () => {
    const restore = stubGatewayNetwork();
    const harness = createTestUserDO();

    try {
      await harness.userDO.setCredential(await testOwner(), CLOUDFLARE_OAUTH_CRED_KEY, multiAccountCredential());
      expect(await harness.userDO.listCloudflareAccounts(await testOwner())).toEqual({
        connected: true,
        selectedId: PERSONAL.id,
        accounts: [PERSONAL, EMPLOYER],
      });
      expect(await harness.userDO.getCredentialBaseURL(await testOwner(), CLOUDFLARE_OAUTH_CRED_KEY))
        .toBe(`https://api.cloudflare.com/client/v4/accounts/${PERSONAL.id}/ai/v1`);
    } finally {
      harness.close();
      restore();
    }
  });

  test('selecting the entitlement-bearing account moves inference to it', async () => {
    const restore = stubGatewayNetwork();
    const harness = createTestUserDO();

    try {
      const owner = await testOwner();
      await harness.userDO.setCredential(owner, CLOUDFLARE_OAUTH_CRED_KEY, multiAccountCredential());
      await harness.userDO.selectCloudflareAccount(owner, EMPLOYER.id);

      expect(await harness.userDO.listCloudflareAccounts(owner)).toMatchObject({ selectedId: EMPLOYER.id });
      expect(await harness.userDO.getCredentialBaseURL(owner, CLOUDFLARE_OAUTH_CRED_KEY))
        .toBe(`https://api.cloudflare.com/client/v4/accounts/${EMPLOYER.id}/ai/v1`);
      expect(await harness.userDO.getAuthHeaders(owner, CLOUDFLARE_OAUTH_CRED_KEY))
        .toMatchObject({ Authorization: 'Bearer cf-access' });
    } finally {
      harness.close();
      restore();
    }
  });

  test('the AI Gateway of the old account does not survive the switch', async () => {
    const restore = stubGatewayNetwork();
    const harness = createTestUserDO();

    try {
      const owner = await testOwner();
      await harness.userDO.setCredential(owner, CLOUDFLARE_OAUTH_CRED_KEY, multiAccountCredential());
      await harness.userDO.selectAIGateway(owner, 'gw-one');
      expect(await harness.userDO.listAIGateways(owner)).toMatchObject({ selectedId: 'gw-one' });

      await harness.userDO.selectCloudflareAccount(owner, EMPLOYER.id);
      expect(await harness.userDO.listAIGateways(owner)).toMatchObject({ selectedId: null });
    } finally {
      harness.close();
      restore();
    }
  });

  test('an account the login cannot see is refused and changes nothing', async () => {
    const restore = stubGatewayNetwork();
    const harness = createTestUserDO();

    try {
      const owner = await testOwner();
      await harness.userDO.setCredential(owner, CLOUDFLARE_OAUTH_CRED_KEY, multiAccountCredential());
      await expect(harness.userDO.selectCloudflareAccount(owner, 'ccc333ccc333ccc333ccc333ccc333cc'))
        .rejects.toThrow(/not one this login can see/);
      expect(await harness.userDO.listCloudflareAccounts(owner)).toMatchObject({ selectedId: PERSONAL.id });
    } finally {
      harness.close();
      restore();
    }
  });

  test('selecting an account with no Cloudflare credential is an error, not a silent write', async () => {
    const harness = createTestUserDO();
    await expect(harness.userDO.selectCloudflareAccount(await testOwner(), PERSONAL.id))
      .rejects.toThrow(/Cloudflare is not connected/);
    harness.close();
  });
});

const IDENTITY: AuthIdentity = {
  userId: '0123456789abcdef0123456789abcdef',
  email: 'ashish@example.com',
  sub: 'sub',
  provider: 'test',
  authTime: Date.now(),
};

function routeHarness(selectFails = false) {
  const notified: string[] = [];
  const selected: string[] = [];

  const stub = userAccount({
    async ensureProfile(_caller: UserCaller, email: string) { return bootstrappedProfile(email); },
    async userMcp_warmConnections() { return { servers: 0 }; },
    async listActiveWorkspaces() {
      return [{ name: 'jarvis', displayName: 'Jarvis', createdAt: 1, nameOrigin: 'user' as const }];
    },
    async listCloudflareAccounts() {
      return { connected: true, selectedId: PERSONAL.id, accounts: [PERSONAL, EMPLOYER] };
    },
    async selectCloudflareAccount(_caller: UserCaller, id: string) {
      if (selectFails) throw new Error('That Cloudflare account is not one this login can see.');
      selected.push(id);
    },
  });

    // These two handlers call `waitUntil` on the context and nothing else.
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil(promise: Promise<unknown>) { pending.push(promise); } };

  const env: UserRoutesEnv<string> = {
    UserDO: { idFromName: (name) => name, get: () => stub },
    OrchestratorAgent: {
      idFromName: (name) => name,
      get: (id) => workspaceObject({
        async onCredentialsChanged() {
          notified.push(id);

          return { ok: true as const };
        },
      }),
    },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  };

  const call = (path: string, method: string, body?: { id: string }) =>
    handleUserRequest(new Request(`https://kinu.example.com/api/user${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env, IDENTITY, ctx);

  return { call, notified, selected, pending };
}

describe('the account selector is reachable over HTTP', () => {
  test('GET /cloudflare/accounts lists what the login can see', async () => {
    const { call } = routeHarness();
    const res = await call('/cloudflare/accounts', 'GET');
    expect(res?.status).toBe(200);
    expect(v.parse(AccountStatusSchema, await res?.json())).toEqual({
      connected: true, selectedId: PERSONAL.id, accounts: [PERSONAL, EMPLOYER],
    });
  });

  test('PUT /cloudflare/account switches and tells live workspaces to re-resolve', async () => {
    const { call, notified, selected, pending } = routeHarness();
    const res = await call('/cloudflare/account', 'PUT', { id: EMPLOYER.id });
    expect(res?.status).toBe(200);
    expect(selected).toEqual([EMPLOYER.id]);
    await Promise.all(pending);
    expect(notified).toEqual(['jarvis']);
  });

  test('a rejected account is a 400, and nothing is told to re-resolve', async () => {
    const { call, notified, pending } = routeHarness(true);
    const res = await call('/cloudflare/account', 'PUT', { id: 'ccc333ccc333ccc333ccc333ccc333cc' });
    expect(res?.status).toBe(400);
    await Promise.all(pending);
    expect(notified).toEqual([]);
  });

  test('a body without an id is refused before any write', async () => {
    const { call, selected } = routeHarness();
    const res = await call('/cloudflare/account', 'PUT');
    expect(res?.status).toBe(400);
    expect(selected).toEqual([]);
  });
});
