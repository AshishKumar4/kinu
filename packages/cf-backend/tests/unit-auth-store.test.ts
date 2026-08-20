import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { describe, expect, setSystemTime, test } from 'bun:test';
import {
  consumeOAuthState, createOAuthState, createSession, deriveUserId, revokeSession, verifySession,
  type OAuthProfile,
} from '../src/auth/store';
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
  const userDO = {
    async ensureProfile(_caller: UserCaller, email: string, displayName?: string) {
      ensuredProfiles.push(`${email}:${displayName ?? ''}`);
      return { email, displayName: displayName ?? null, createdAt: 1, lastSeenAt: 1 };
    },
  };

  return {
    kv,
    ensuredProfiles,
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

describe('KV-backed browser auth store', () => {
  test('a verified login yields a session that verifies back to the same identity', async () => {
    const { kv, env, ensuredProfiles } = setupEnv();

    const created = await createSession(env, {
      provider: 'cloudflare',
      providerSub: 'cf-user-1',
      email: 'Ashish@Example.com',
      emailVerified: true,
      displayName: 'Ashish',
    });

    expect(created.token).toStartWith('ps_');
    expect(created.identity.email).toBe('ashish@example.com');
    expect(created.identity.userId).toBe(await deriveUserId('ashish@example.com'));
    // The durable half of the identity went to the user's own DO, not to KV.
    expect(ensuredProfiles).toEqual(['ashish@example.com:Ashish']);

    const verified = await verifySession(kv, created.token);
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
    const { kv, env } = setupEnv();
    const created = await createSession(env, profile('cloudflare', 'cf-1', 'person@example.com'));
    expect(await verifySession(kv, created.token)).not.toBeNull();

    try {
      setSystemTime(new Date(created.expiresAt + 1_000));
      expect(await verifySession(kv, created.token)).toBeNull();
    } finally {
      setSystemTime();
    }
  });

  test('a revoked session stops verifying, and a token that is not one is refused unread', async () => {
    const { kv, env } = setupEnv();
    const created = await createSession(env, profile('cloudflare', 'cf-1', 'person@example.com'));

    await revokeSession(kv, created.token);
    expect(await verifySession(kv, created.token)).toBeNull();
    expect(await verifySession(kv, 'not-a-proteus-token')).toBeNull();
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
      redirectUri: 'https://proteus.example.com/auth/cloudflare/callback',
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
      redirectUri: 'https://proteus.example.com/auth/cloudflare/callback',
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
      redirectUri: 'https://proteus.example.com/auth/cloudflare/callback',
    });

    expect((await consumeOAuthState(kv, state, 'cloudflare')).returnTo).toBe('/');
  });
});
