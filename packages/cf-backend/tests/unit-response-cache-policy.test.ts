// One cache policy for authenticated JSON at the `json()` boundary, so a shared or disk cache cannot replay a
// signed-in body after the session ends. A route opts out by naming a policy.
import { describe, expect, test } from 'bun:test';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { handleUserRequest, type UserRoutesEnv } from '../src/user/routes';
import { bootstrappedProfile, unreachableNamespace, userAccount } from './helpers/bindings';
import type { UserCaller } from '@kinu.run/core';
import { handleHealthRequest } from '@kinu.run/core';
import { PRIVATE_NO_STORE } from '@kinu.run/core';
import { err, json } from '@kinu.run/core';
import type { AuthIdentity } from '../src/auth/session';

const IDENTITY: AuthIdentity = {
  userId: '0123456789abcdef0123456789abcdef',
  email: 'ashish@example.com',
  sub: 'sub',
  provider: 'test',
  authTime: Date.now(),
};

function userEnv(): UserRoutesEnv<string> {
  const stub = userAccount({
    async ensureProfile(_caller: UserCaller, email: string) { return bootstrappedProfile(email); },
    async userMcp_warmConnections() { return { servers: 0 }; },
    async listCredentials() { return []; },
  });

  return {
    UserDO: { idFromName: (name) => name, get: () => stub },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    OrchestratorAgent: unreachableNamespace('OrchestratorAgent'),
  };
}

describe('authenticated JSON is private and never stored', () => {
  test('an account surface carries the policy without naming it', async () => {
    const response = await handleUserRequest(
      new Request('https://kinu.example.com/api/user/credentials'),
      userEnv(), IDENTITY,
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get('cache-control')).toBe(PRIVATE_NO_STORE);
  });

  test('an error answer carries it too — a 403 body names the caller', () => {
    expect(err(403, 'nope').headers.get('cache-control')).toBe(PRIVATE_NO_STORE);
  });

  test('the policy is one string, not a per-route spelling', () => {
    expect(PRIVATE_NO_STORE).toBe('private, no-store');
  });
});

describe('a route that names its own policy keeps it', () => {
  test('the public health stamp stays revalidatable', async () => {
    const response = await handleHealthRequest(
      new Request('https://kinu.example.com/api/health'),
      { ASSETS: { fetch: async () => new Response('', { status: 404 }) } },
    );

    expect(response?.headers.get('cache-control')).toBe('no-cache');
  });

  test('an explicit policy on any json() answer wins', () => {
    const response = json({ body: { ok: true } }, { headers: { 'cache-control': 'public, max-age=60' } });
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
  });
});
