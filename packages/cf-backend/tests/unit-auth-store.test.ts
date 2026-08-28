import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { describe, expect, setSystemTime, test } from 'bun:test';
import {
  consumeOAuthState, createOAuthState, createSession, deriveUserId, revokeSession, verifySession,
  type OAuthProfile,
} from '../src/auth/store';
import { AuthError, authenticateRequest, type AuthIdentity } from '../src/auth/session';
import { makeKv, type FakeKv } from './helpers/kv';
import type { UserCaller } from '../src/user/workspace-capability';

interface TestNamespace<Stub> {
  idFromName(name: string): string;
  get(): Stub;
}

interface AuthStoreTestBindings<Stub> {
  AUTH_KV: FakeKv;
  UserDO: TestNamespace<Stub>;
  CREDENTIAL_ENCRYPTION_KEY: string;
}

function testEnv<Stub>(bindings: AuthStoreTestBindings<Stub>): Env {
  const env: Partial<Env> = {};
  Object.assign(env, bindings);
  // SAFETY: createSession and verifySession read exactly the constructed KV
  // namespace, UserDO namespace, and credential key; every reachable binding is present.
  return env as Env;
}

function setupEnv() {
  const kv = makeKv();
  const ensuredProfiles: string[] = [];
  // The authority behind a cookie, at the RPC seam. The real table is
  // exercised against the real UserDO in unit-auth-session-revocation.
  const rows = new Map<string, number>();
  const userDO = {
    async ensureProfile(_caller: UserCaller, email: string, displayName?: string) {
      ensuredProfiles.push(`${email}:${displayName ?? ''}`);
      return { email, displayName: displayName ?? null, createdAt: 1, lastSeenAt: 1 };
    },
    async registerBrowserSession(_caller: UserCaller, tokenHash: string, expiresAt: number) {
      rows.set(tokenHash, expiresAt);
    },
    async verifyBrowserSession(_caller: UserCaller, tokenHash: string) {
      for (const [hash, expiresAt] of rows) if (expiresAt <= Date.now()) rows.delete(hash);
      return rows.has(tokenHash);
    },
    async revokeBrowserSession(_caller: UserCaller, tokenHash: string) {
      rows.delete(tokenHash);
    },
  };

  return {
    kv,
    ensuredProfiles,
    liveSessions: () => [...rows.keys()],
    env: testEnv({
      AUTH_KV: kv,
      UserDO: {
        idFromName(name: string) { return name; },
        get() { return userDO; },
      }, CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY }),
  };
}

function profile(provider: OAuthProfile['provider'], providerSub: string, email: string): OAuthProfile {
  return { provider, providerSub, email, emailVerified: true, displayName: null };
}

describe('the browser auth store', () => {
  test('a verified login yields a session that verifies back to the same identity', async () => {
    const { env, ensuredProfiles } = setupEnv();

    const created = await createSession(env, {
      provider: 'cloudflare',
      providerSub: 'cf-user-1',
      email: 'Ashish@Example.com',
      emailVerified: true,
      displayName: 'Ashish',
    });

    expect(created.token).toStartWith(`ps_${created.identity.userId}_`);
    expect(created.identity.email).toBe('ashish@example.com');
    expect(created.identity.userId).toBe(await deriveUserId('ashish@example.com'));
    // The durable half of the identity went to the user's own DO, not to KV.
    expect(ensuredProfiles).toEqual(['ashish@example.com:Ashish']);

    const verified = await verifySession(env, created.token);
    expect(verified).toMatchObject({
      userId: created.identity.userId,
      email: 'ashish@example.com',
      provider: 'cloudflare',
      sub: 'cf-user-1',
      displayName: 'Ashish',
    });
    expect(verified?.authTime).toBe(created.identity.authTime);
  });

  test('the same verified email is the same Kinu user across providers', async () => {
    const { kv, env } = setupEnv();
    const first = await createSession(env, profile('cloudflare', 'cf-user-1', 'person@example.com'));
    const second = await createSession(env, profile('google', 'google-user-1', 'PERSON@example.com'));

    expect(second.identity.userId).toBe(first.identity.userId);
    // Two sessions, one identity — and no third record standing for the user.
    expect(kv.keys().filter((key) => key.startsWith('session:'))).toHaveLength(2);
    expect(kv.keys().filter((key) => !key.startsWith('session:'))).toEqual([]);
  });

  test('an unverified email is refused rather than given an identity of its own', async () => {
    const { env } = setupEnv();
    expect(createSession(env, {
      provider: 'github',
      providerSub: 'gh-1',
      email: 'person@example.com',
      emailVerified: false,
      displayName: null,
    })).rejects.toThrow(/did not report this email address as verified/);
  });

  test('a session stops verifying once its lifetime is up', async () => {
    const { env } = setupEnv();
    const created = await createSession(env, profile('cloudflare', 'cf-1', 'person@example.com'));
    expect(await verifySession(env, created.token)).not.toBeNull();

    try {
      setSystemTime(new Date(created.expiresAt + 1_000));
      expect(await verifySession(env, created.token)).toBeNull();
    } finally {
      setSystemTime();
    }
  });

  test('revoking one session stops it verifying, and a token that is not one is refused unread', async () => {
    const { env, liveSessions } = setupEnv();
    const created = await createSession(env, profile('cloudflare', 'cf-1', 'person@example.com'));
    const kept = await createSession(env, profile('cloudflare', 'cf-1', 'person@example.com'));

    await revokeSession(env, created.token);
    expect(await verifySession(env, created.token)).toBeNull();
    expect(await verifySession(env, kept.token)).not.toBeNull();
    expect(liveSessions()).toHaveLength(1);
    expect(await verifySession(env, 'not-a-kinu-token')).toBeNull();
  });
});

describe('OAuth handoff state', () => {
  test('state round-trips once and only once', async () => {
    const kv = makeKv();
    const { state } = await createOAuthState(kv, {
      provider: 'cloudflare',
      codeVerifier: 'verifier',
      nonce: null,
      returnTo: '/workspaces/jarvis',
      redirectUri: 'https://kinu.example.com/auth/cloudflare/callback',
    });

    const consumed = await consumeOAuthState(kv, state, 'cloudflare');
    expect(consumed).toMatchObject({
      provider: 'cloudflare',
      codeVerifier: 'verifier',
      returnTo: '/workspaces/jarvis',
    });

    expect(consumeOAuthState(kv, state, 'cloudflare')).rejects.toThrow(/invalid or already used/);
  });

  test('a callback from another provider cannot spend this state', async () => {
    const kv = makeKv();
    const { state } = await createOAuthState(kv, {
      provider: 'cloudflare',
      codeVerifier: 'verifier',
      nonce: null,
      returnTo: '/',
      redirectUri: 'https://kinu.example.com/auth/cloudflare/callback',
    });

    expect(consumeOAuthState(kv, state, 'github')).rejects.toThrow(/provider mismatch/);
  });

  test('a hostile return_to is neutralised on the way in, not just on the way out', async () => {
    const kv = makeKv();
    const { state } = await createOAuthState(kv, {
      provider: 'cloudflare',
      codeVerifier: 'verifier',
      nonce: null,
      returnTo: '//evil.example.com/steal',
      redirectUri: 'https://kinu.example.com/auth/cloudflare/callback',
    });

    expect((await consumeOAuthState(kv, state, 'cloudflare')).returnTo).toBe('/');
  });
});

/**
 * `DEV_USER_EMAIL` names ONE identity a caller may act as without signing in.
 * The published staging deployment sets it, so what decides whether a caller
 * HAS it is the whole security property of that deployment: gated on the
 * absence of a session cookie, every unauthenticated request reaching
 * staging.kinu.run arrived as the eval service account.
 */
describe('the synthetic development identity', () => {
  const DEV_ENV = {
    AUTH_KV: makeKv(),
    DEV_USER_EMAIL: 'eval-service@kinu.run',
    DEV_IDENTITY_SECRET: 'staging-shared-secret',
  };

  /** Who the request resolved as, or the status it was refused with — a tag
   *  rather than a union of an identity and a number, so a case reads the
   *  outcome it means. */
  type Resolution =
    | { readonly granted: true; readonly identity: AuthIdentity }
    | { readonly granted: false; readonly status: number };

  async function resolve(url: string, headers: HeadersInit = {}): Promise<Resolution> {
    try {
      return { granted: true, identity: await authenticateRequest(new Request(url, { headers }), DEV_ENV) };
    } catch (error) {
      if (error instanceof AuthError) return { granted: false, status: error.status };
      throw error;
    }
  }

  test('a published host grants it only to a caller holding the secret', async () => {
    const held = await resolve('https://staging.kinu.run/api/user/workspaces', {
      'x-kinu-dev-identity': 'staging-shared-secret',
    });
    if (!held.granted) throw new Error(`the secret was refused with ${String(held.status)}`);
    expect(held.identity.email).toBe('eval-service@kinu.run');
    expect(held.identity.provider).toBe('dev');
  });

  test.each([
    ['no secret at all', {}],
    ['a wrong secret', { 'x-kinu-dev-identity': 'guess' }],
    ['an empty secret', { 'x-kinu-dev-identity': '' }],
  ])('a published host refuses a caller with %s', async (_label, headers) => {
    expect(await resolve('https://staging.kinu.run/api/user/workspaces', headers))
      .toEqual({ granted: false, status: 401 });
  });

  test('a deployment that configures no secret grants nothing', async () => {
    const request = new Request('https://staging.kinu.run/api/user/workspaces', {
      headers: { 'x-kinu-dev-identity': 'staging-shared-secret' },
    });
    expect(authenticateRequest(request, { AUTH_KV: makeKv(), DEV_USER_EMAIL: 'eval-service@kinu.run' }))
      .rejects.toThrow(/No Kinu session/);
  });

  test('a developer\'s own machine is already the trust boundary, so localhost needs no secret', async () => {
    const local = await resolve('http://localhost:8787/api/user/workspaces');
    if (!local.granted) throw new Error(`localhost was refused with ${String(local.status)}`);
    expect(local.identity.email).toBe('eval-service@kinu.run');
  });
});
