// Regression test for the primary credential path: signing in with the
// Cloudflare IdP must attach the Workers AI credential (with its refresh
// token) to the user's UserDO in the same authorization — one login grants
// both app access and AI. Drives the real /auth/cloudflare/callback handler
// against the real KV auth store, faking only the network seams.
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { describe, expect, test } from 'bun:test';
import { handleAuthRequest } from '../src/auth/routes';
import { createOAuthState } from '../src/auth/store';
import { CLOUDFLARE_WORKERS_AI_SCOPES } from '../src/lib/cloudflare-oauth';
import { asFetchFunction, DEFAULT_WORKERS_AI_MODEL_SPEC, type OAuthCredential } from '@kinu.run/core';
import { makeKv, type FakeKv } from './helpers/kv';
import type { UserCaller } from '../src/user/workspace-capability';

const ORIGIN = 'https://kinu.example.com';

interface TestNamespace<Stub> {
  idFromName(name: string): string;
  get(): Stub;
}

interface CloudflareLoginTestBindings<UserStub, AgentStub> {
  AUTH_KV: FakeKv;
  UserDO: TestNamespace<UserStub>;
  OrchestratorAgent: TestNamespace<AgentStub>;
  CLOUDFLARE_OAUTH_CLIENT_ID: string;
  CLOUDFLARE_OAUTH_CLIENT_SECRET: string;
  CREDENTIAL_ENCRYPTION_KEY: string;
}

function testEnv<UserStub, AgentStub>(bindings: CloudflareLoginTestBindings<UserStub, AgentStub>): Env {
  const env: Partial<Env> = {};
  Object.assign(env, bindings);
  // SAFETY: The callback reads exactly the constructed KV namespace, namespaces,
  // OAuth client values, and credential key; every reachable binding is present above.
  return env as Env;
}

function setupEnv() {
  const kv = makeKv();
  const credentials: Array<{ key: string; credential: OAuthCredential }> = [];
  const config = new Map<string, string>();
  const userDO = {
    async ensureProfile(_caller: UserCaller) {},
    async setCredential(_caller: UserCaller, key: string, credential: OAuthCredential) {
      credentials.push({ key, credential });
    },
    async getConfig(_caller: UserCaller, key: string) { return config.get(key) ?? null; },
    async setConfig(_caller: UserCaller, key: string, value: string) { config.set(key, value); },
    async listActiveWorkspaces(_caller: UserCaller) { return []; },
  };
  const env = testEnv({
    AUTH_KV: kv,
    UserDO: { idFromName: (name: string) => name, get: () => userDO },
    OrchestratorAgent: { idFromName: (name: string) => name, get: () => ({ async onCredentialsChanged() {} }) },
    CLOUDFLARE_OAUTH_CLIENT_ID: 'cf-client-id',
    CLOUDFLARE_OAUTH_CLIENT_SECRET: 'cf-client-secret',
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  });
  return { env, kv, credentials, config };
}

function fakeCloudflareNetwork(tokens: { access_token: string; refresh_token?: string }) {
  const tokenRequests: URLSearchParams[] = [];
  const fetchFake = asFetchFunction(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    if (url === 'https://dash.cloudflare.com/.well-known/openid-configuration') {
      return Response.json({
        issuer: 'https://dash.cloudflare.com',
        authorization_endpoint: 'https://dash.cloudflare.com/oauth2/auth',
        token_endpoint: 'https://dash.cloudflare.com/oauth2/token',
      });
    }
    if (url === 'https://dash.cloudflare.com/oauth2/token') {
      tokenRequests.push(new URLSearchParams(String(init?.body)));
      return Response.json({
        ...tokens,
        token_type: 'bearer',
        expires_in: 3600,
        scope: CLOUDFLARE_WORKERS_AI_SCOPES,
      });
    }
    if (url === 'https://api.cloudflare.com/client/v4/user') {
      return Response.json({
        success: true,
        result: { id: 'cf-user-1', email: 'ashish@example.com', username: 'ashish' },
      });
    }
    if (url === 'https://api.cloudflare.com/client/v4/accounts') {
      return Response.json({
        success: true,
        result: [{ id: 'abc123abc123abc123abc123abc123ab', name: 'User Account' }],
      });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  return { fetchFake, tokenRequests };
}

async function loginViaCloudflare(env: Env, kv: FakeKv): Promise<Response> {
  const { state } = await createOAuthState(kv, {
    provider: 'cloudflare',
    codeVerifier: 'test-code-verifier-test-code-verifier-test-1',
    nonce: null,
    returnTo: '/',
    redirectUri: `${ORIGIN}/auth/cloudflare/callback`,
  });
  const callback = new URL(`${ORIGIN}/auth/cloudflare/callback`);
  callback.searchParams.set('state', state);
  callback.searchParams.set('code', 'auth-code-1');
  const response = await handleAuthRequest(new Request(callback.toString()), env);
  if (!response) throw new Error('auth route did not handle the callback');
  return response;
}

describe('Cloudflare IdP login attaches the Workers AI credential', () => {
  test('one login grants both the app session and a refreshable AI credential', async () => {
    const { env, kv, credentials, config } = setupEnv();
    const { fetchFake, tokenRequests } = fakeCloudflareNetwork({
      access_token: 'cf-access-1',
      refresh_token: 'cf-refresh-1',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchFake;
    try {
      const response = await loginViaCloudflare(env, kv);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(`${ORIGIN}/`);
      expect(response.headers.get('set-cookie')).toContain('__Host-kinu_session=');

      // The token exchange carried PKCE + the authorization code.
      expect(tokenRequests).toHaveLength(1);
      expect(tokenRequests[0].get('grant_type')).toBe('authorization_code');
      expect(tokenRequests[0].get('code')).toBe('auth-code-1');
      expect(tokenRequests[0].get('code_verifier')).toBe('test-code-verifier-test-code-verifier-test-1');

      // The same authorization attached the Workers AI credential.
      expect(credentials).toHaveLength(1);
      expect(credentials[0].key).toBe('cloudflare.oauth');
      expect(credentials[0].credential.kind).toBe('oauth');
      expect(credentials[0].credential.accessToken).toBe('cf-access-1');
      expect(credentials[0].credential.refreshToken).toBe('cf-refresh-1');
      const expiresAt = credentials[0].credential.expiresAt;
      if (expiresAt === undefined) throw new Error('Cloudflare credential did not include an expiry');
      expect(expiresAt).toBeGreaterThan(Date.now());
      expect(credentials[0].credential.metadata?.accountId).toBe('abc123abc123abc123abc123abc123ab');
      expect(config.get('default_model')).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('re-login re-attaches a fresh credential over the stored one', async () => {
    const { env, kv, credentials } = setupEnv();
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = fakeCloudflareNetwork({ access_token: 'cf-access-1', refresh_token: 'cf-refresh-1' }).fetchFake;
      await loginViaCloudflare(env, kv);
      globalThis.fetch = fakeCloudflareNetwork({ access_token: 'cf-access-2', refresh_token: 'cf-refresh-2' }).fetchFake;
      await loginViaCloudflare(env, kv);
      expect(credentials.map((c) => c.credential.accessToken)).toEqual(['cf-access-1', 'cf-access-2']);
      expect(credentials[1].credential.refreshToken).toBe('cf-refresh-2');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
