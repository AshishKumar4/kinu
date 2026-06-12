// Regression test for the primary credential path: signing in with the
// Cloudflare IdP must attach the Workers AI credential (with its refresh
// token) to the user's UserDO in the same authorization — one login grants
// both app access and AI. Drives the real /auth/cloudflare/callback handler
// against the real D1 auth schema, faking only the network seams.
import { describe, expect, test } from 'bun:test';
import { handleAuthRequest } from '../src/auth/routes.js';
import { createOAuthState } from '../src/auth/d1-store.js';
import { CLOUDFLARE_WORKERS_AI_SCOPES } from '../src/lib/cloudflare-oauth.js';
import { DEFAULT_WORKERS_AI_MODEL_SPEC, type OAuthCredential } from '@proteus/core';
import { createAuthDatabase, makeD1 } from './helpers/d1.js';

const ORIGIN = 'https://proteus.example.com';

function setupEnv() {
  const credentials: Array<{ key: string; credential: OAuthCredential }> = [];
  const config = new Map<string, string>();
  const userDO = {
    async ensureProfile() {},
    async setCredential(key: string, credential: OAuthCredential) {
      credentials.push({ key, credential });
    },
    async getConfig(key: string) { return config.get(key) ?? null; },
    async setConfig(key: string, value: string) { config.set(key, value); },
    async listAgents() { return []; },
  };
  const env = {
    AUTH_DB: makeD1(createAuthDatabase()),
    UserDO: { idFromName: (name: string) => name, get: () => userDO },
    OrchestratorAgent: { idFromName: (name: string) => name, get: () => ({ async onCredentialsChanged() {} }) },
    CLOUDFLARE_OAUTH_CLIENT_ID: 'cf-client-id',
    CLOUDFLARE_OAUTH_CLIENT_SECRET: 'cf-client-secret',
  } as unknown as Env;
  return { env, credentials, config };
}

function fakeCloudflareNetwork(tokens: { access_token: string; refresh_token?: string }) {
  const tokenRequests: URLSearchParams[] = [];
  const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
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
  }) as typeof fetch;
  return { fetchFake, tokenRequests };
}

async function loginViaCloudflare(env: Env): Promise<Response> {
  const { state } = await createOAuthState((env as unknown as { AUTH_DB: D1Database }).AUTH_DB, {
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
    const { env, credentials, config } = setupEnv();
    const { fetchFake, tokenRequests } = fakeCloudflareNetwork({
      access_token: 'cf-access-1',
      refresh_token: 'cf-refresh-1',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchFake;
    try {
      const response = await loginViaCloudflare(env);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(`${ORIGIN}/`);
      expect(response.headers.get('set-cookie')).toContain('__Host-proteus_session=');

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
      expect(credentials[0].credential.expiresAt!).toBeGreaterThan(Date.now());
      expect(credentials[0].credential.metadata?.accountId).toBe('abc123abc123abc123abc123abc123ab');
      expect(config.get('default_model')).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('re-login re-attaches a fresh credential over the stored one', async () => {
    const { env, credentials } = setupEnv();
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = fakeCloudflareNetwork({ access_token: 'cf-access-1', refresh_token: 'cf-refresh-1' }).fetchFake;
      await loginViaCloudflare(env);
      globalThis.fetch = fakeCloudflareNetwork({ access_token: 'cf-access-2', refresh_token: 'cf-refresh-2' }).fetchFake;
      await loginViaCloudflare(env);
      expect(credentials.map((c) => c.credential.accessToken)).toEqual(['cf-access-1', 'cf-access-2']);
      expect(credentials[1].credential.refreshToken).toBe('cf-refresh-2');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
