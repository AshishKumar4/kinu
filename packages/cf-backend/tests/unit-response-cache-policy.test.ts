// One cache policy for authenticated JSON, applied at the `json()` boundary.
//
// The defect this locks down: `json()` set `content-type` and nothing else, so
// every account surface — the workspace roster, the credential summary, the MCP
// server list — was answered with no `cache-control` at all. Two CLI endpoints
// remembered to pass `no-store`; the whole of `/api/user/*` did not. A shared
// cache or a browser's disk cache is then free to keep a signed-in body and
// replay it after the session ends.
//
// Public, cacheable answers must keep working: naming a policy is how a route
// opts out, so the default is the safe direction.
import { describe, expect, test } from 'bun:test';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { handleUserRequest } from '../src/user/routes';
import { handleHealthRequest } from '../src/health-route';
import { PRIVATE_NO_STORE } from '../src/lib/security-headers';
import { err, json } from '../src/lib/http';
import type { AuthIdentity } from '../src/auth/session';

const IDENTITY: AuthIdentity = {
  userId: '0123456789abcdef0123456789abcdef',
  email: 'ashish@example.com',
  sub: 'sub',
  provider: 'test',
  authTime: Date.now(),
};

function userEnv(): Env {
  const stub = {
    async ensureProfile() {},
    async userMcp_warmConnections() { return { servers: 0 }; },
    async listCredentials() { return []; },
  };
  const partialEnv: Partial<Env> = {};
  Object.assign(partialEnv, {
    UserDO: { idFromName: (name: string) => name, get: () => stub },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  });
  // SAFETY: the constructed environment provides the one namespace and the
  // encryption key the credential-summary read reaches; no other binding is on
  // that path.
  return partialEnv as Env;
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
    const partialEnv: Partial<Env> = {};
    Object.assign(partialEnv, { ASSETS: { fetch: async () => new Response('', { status: 404 }) } });
    // SAFETY: the health route reads only the assets binding constructed here.
    const response = await handleHealthRequest(
      new Request('https://kinu.example.com/api/health'), partialEnv as Env,
    );
    expect(response?.headers.get('cache-control')).toBe('no-cache');
  });

  test('an explicit policy on any json() answer wins', () => {
    const response = json({ ok: true }, { headers: { 'cache-control': 'public, max-age=60' } });
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
  });
});
