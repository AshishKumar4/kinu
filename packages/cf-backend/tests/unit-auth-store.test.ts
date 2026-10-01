import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { describe, expect, setSystemTime, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import {
  consumeOAuthState, createOAuthState, createSession, deriveUserId, revokeSession, verifySession,
  type AuthStoreEnv, type OAuthProfile, type OAuthStateInput, type SessionAuthority,
} from '../src/auth/store';
import { bootstrappedProfile } from './helpers/bindings';
import { AuthError, authenticateRequest, type AuthIdentity } from '../src/auth/session';
import { makeKv, type FakeKv } from './helpers/kv';
import { DEV_IDENTITY_ACCOUNT_HEADER, DEV_IDENTITY_HEADER, sha256Hex } from '@kinu.run/core';
import type { BrowserSessionIdentity } from '../src/user/user-do';
import type { UserCaller } from '@kinu.run/core';

function setupEnv() {
  const kv = makeKv();
  const ensuredProfiles: string[] = [];
  // The real table is exercised against the real UserDO in unit-auth-session-revocation.
  const rows = new Map<string, { expiresAt: number; identity: BrowserSessionIdentity }>();

  const userDO: SessionAuthority = {
    async ensureProfile(_caller: UserCaller, email: string, displayName?: string) {
      ensuredProfiles.push(`${email}:${displayName ?? ''}`);

      return bootstrappedProfile(email, displayName ?? null);
    },
    async registerBrowserSession(
      _caller: UserCaller, tokenHash: string, expiresAt: number, identity: BrowserSessionIdentity,
    ) {
      rows.set(tokenHash, { expiresAt, identity });
    },
    async verifyBrowserSession(_caller: UserCaller, tokenHash: string) {
      for (const [hash, row] of rows) if (row.expiresAt <= Date.now()) rows.delete(hash);
      const row = rows.get(tokenHash);

      return row ? { identity: row.identity } : null;
    },
    async revokeBrowserSession(_caller: UserCaller, tokenHash: string) {
      rows.delete(tokenHash);
    },
  };

  return {
    kv,
    ensuredProfiles,
    liveSessions: () => [...rows.keys()],
    env: {
      AUTH_KV: kv,
      UserDO: { idFromName: (name) => name, get: () => userDO },
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    } satisfies AuthStoreEnv<string>,
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

  test('the authority answers when no KV projection has arrived, and stops the moment it is revoked', async () => {
    const { env, kv } = setupEnv();
    const created = await createSession(env, profile('cloudflare', 'cf-1', 'person@example.com'));
    // What a colo the sign-in's KV write has not reached sees; the row is strongly consistent everywhere.
    await kv.delete(`session:${await sha256Hex(created.token)}`);

    // The socket revocation tag needs the session's own hash.
    expect(await verifySession(env, created.token)).toEqual({
      ...created.identity, sessionTokenHash: await sha256Hex(created.token),
    });

    await revokeSession(env, created.token);
    expect(await verifySession(env, created.token)).toBeNull();
  });
});

describe('OAuth handoff state', () => {
  const started = (kv: FakeKv, overrides: Partial<OAuthStateInput> = {}) => createOAuthState(kv, {
    provider: 'cloudflare',
    codeVerifier: 'verifier',
    nonce: null,
    returnTo: '/',
    redirectUri: 'https://kinu.example.com/auth/cloudflare/callback',
    ...overrides,
  });

  test('state round-trips once, and only for the browser it was issued to', async () => {
    const kv = makeKv();
    const { state, binding } = await started(kv, { returnTo: '/workspaces/jarvis' });

    const consumed = await consumeOAuthState(kv, state, 'cloudflare', binding);
    expect(consumed).toMatchObject({
      provider: 'cloudflare',
      codeVerifier: 'verifier',
      returnTo: '/workspaces/jarvis',
    });

    await expect(consumeOAuthState(kv, state, 'cloudflare', binding))
      .rejects.toThrow(/invalid or already used/);
  });

  test('a callback carrying no handoff cookie spends the state and signs nobody in', async () => {
    const kv = makeKv();
    const { state, binding } = await started(kv);

    // Login-CSRF: a working `state` handed to a browser holding no binding for it.
    await expect(consumeOAuthState(kv, state, 'cloudflare', null))
      .rejects.toThrow(/not issued to this browser/);
    // Burned before judged, so the refusal is not a free probe that leaves the link workable.
    await expect(consumeOAuthState(kv, state, 'cloudflare', binding))
      .rejects.toThrow(/invalid or already used/);
  });

  test('a browser holding its own live handoff still cannot spend another', async () => {
    const kv = makeKv();
    const victim = await started(kv);
    const attacker = await started(kv);

    await expect(consumeOAuthState(kv, victim.state, 'cloudflare', attacker.binding))
      .rejects.toThrow(/not issued to this browser/);
    await expect(consumeOAuthState(kv, attacker.state, 'cloudflare', victim.binding))
      .rejects.toThrow(/not issued to this browser/);
  });

  test('a callback from another provider cannot spend this state', async () => {
    const kv = makeKv();
    const { state, binding } = await started(kv);

    await expect(consumeOAuthState(kv, state, 'github', binding))
      .rejects.toThrow(/provider mismatch/);
  });

  test('a hostile return_to is neutralised on the way in, not just on the way out', async () => {
    const kv = makeKv();
    const { state, binding } = await started(kv, { returnTo: '//evil.example.com/steal' });

    expect((await consumeOAuthState(kv, state, 'cloudflare', binding)).returnTo).toBe('/');
  });

  test('neither half of the handoff is stored, so a KV dump replays nothing', async () => {
    const kv = makeKv();
    const { state, binding } = await started(kv);

    const keys = kv.keys();
    expect(keys).toEqual([`oauth-state:${await sha256Hex(state)}`]);
    const stored = await kv.get(keys[0]) ?? '';
    expect(stored).not.toContain(state);
    expect(stored).not.toContain(binding);
    expect(stored).toContain(await sha256Hex(binding));
  });
});

/** `DEV_USER_EMAIL` lets a caller act without signing in; the published deployment sets it, so who gets it is its
 *  whole security property. */
describe('the synthetic development identity', () => {
  const DEV_ENV = {
    AUTH_KV: makeKv(),
    DEV_USER_EMAIL: 'eval-service@kinu.run',
    DEV_IDENTITY_SECRET: 'deployment-shared-secret',
  };

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
    const held = await resolve('https://kinu.run/api/user/workspaces', {
      [DEV_IDENTITY_HEADER]: 'deployment-shared-secret',
    });

    if (!held.granted) throw new Error(`the secret was refused with ${String(held.status)}`);
    expect(held.identity.email).toBe('eval-service@kinu.run');
    expect(held.identity.provider).toBe('dev');
  });

  test.each([
    ['no secret at all', {}],
    ['a wrong secret', { [DEV_IDENTITY_HEADER]: 'guess' }],
    ['an empty secret', { [DEV_IDENTITY_HEADER]: '' }],
  ])('a published host refuses a caller with %s', async (_label, headers) => {
    expect(await resolve('https://kinu.run/api/user/workspaces', headers))
      .toEqual({ granted: false, status: 401 });
  });

  test('a deployment that configures no secret grants nothing', async () => {
    const request = new Request('https://kinu.run/api/user/workspaces', {
      headers: { [DEV_IDENTITY_HEADER]: 'deployment-shared-secret' },
    });

    expect(authenticateRequest(request, { AUTH_KV: makeKv(), DEV_USER_EMAIL: 'eval-service@kinu.run' }))
      .rejects.toThrow(/No Kinu session/);
  });

  test('a developer\'s own machine is already the trust boundary, so localhost needs no secret', async () => {
    const local = await resolve('http://localhost:8787/api/user/workspaces');

    if (!local.granted) throw new Error(`localhost was refused with ${String(local.status)}`);
    expect(local.identity.email).toBe('eval-service@kinu.run');
  });

  // 2026-09-24: the first-run tier's machines, attached as the dev identity, were in every workspace of the product
  // flows and trajectory tiers, which ran beside it as that same identity.
  test('a named eval account is another user, so the machines it attaches are no other account\'s', async () => {
    const own = await resolve('https://kinu.run/api/user/workspaces', { [DEV_IDENTITY_HEADER]: 'deployment-shared-secret' });

    const devices = await resolve('https://kinu.run/api/user/workspaces', {
      [DEV_IDENTITY_HEADER]: 'deployment-shared-secret',
      [DEV_IDENTITY_ACCOUNT_HEADER]: 'devices',
    });

    if (!own.granted || !devices.granted) throw new Error('the secret was refused');
    expect(devices.identity).toMatchObject({ email: 'eval-service+devices@kinu.run', provider: 'dev' });
    expect(devices.identity.userId).not.toBe(own.identity.userId);
  });

  // 2026-10-01: concurrent eval trials on eval-service listed each other as peers and messaged each other (F10).
  test('each eval trial\'s slot is a user of its own, and only slots 1 to 512, written one way, are accounts', async () => {
    const as = (account: string) => resolve('https://kinu.run/api/user/workspaces', {
      [DEV_IDENTITY_HEADER]: 'deployment-shared-secret',
      [DEV_IDENTITY_ACCOUNT_HEADER]: account,
    });

    const [own, seven, eight, last] = await Promise.all([
      resolve('https://kinu.run/api/user/workspaces', { [DEV_IDENTITY_HEADER]: 'deployment-shared-secret' }),
      as('trial-7'), as('trial-8'), as('trial-512'),
    ]);

    if (!own.granted || !seven.granted || !eight.granted || !last.granted) throw new Error('a trial account was refused');
    expect(seven.identity).toMatchObject({ email: 'eval-service+trial-7@kinu.run', provider: 'dev' });
    expect(new Set([own, seven, eight, last].map((granted) => granted.identity.userId)).size).toBe(4);

    // A header value arrives trimmed (the Fetch standard normalizes it), so `trial-7 ` is `trial-7` here.
    for (const refused of ['trial-0', 'trial-513', 'trial-07', 'trial-x', 'trial-', 'Trial-7', 'trial-7-1']) {
      expect(await as(refused)).toEqual({ granted: false, status: 400 });
    }
  });

  test('an account name is no authority: without the secret it grants nothing, and an unknown one is refused', async () => {
    expect(await resolve('https://kinu.run/api/user/workspaces', { [DEV_IDENTITY_ACCOUNT_HEADER]: 'devices' }))
      .toEqual({ granted: false, status: 401 });
    expect(await resolve('https://kinu.run/api/user/workspaces', {
      [DEV_IDENTITY_HEADER]: 'deployment-shared-secret',
      [DEV_IDENTITY_ACCOUNT_HEADER]: 'owner',
    })).toEqual({ granted: false, status: 400 });
  });
});

/**
 * KINU-001, the owner's hardening audit (P0): an unauthenticated request to a public staging route once got the
 * synthetic identity, with every ordinary authority, because `DEV_USER_EMAIL` alone granted it. Every route that
 * authenticates a request (the user API, MCP, the CLI routes, the landing) goes through `authenticateRequest`, so it
 * is asked here of each deployment as `wrangler.jsonc` configures it, on each public host its routes claim, each
 * deployment holding its own secret.
 */
describe('each deployment\'s synthetic identity, as wrangler.jsonc configures it', () => {
  const DeploymentSchema = v.object({
    vars: v.object({ DEV_USER_EMAIL: v.string(), CLI_PUBLIC_ORIGIN: v.string() }),
    routes: v.array(v.object({ pattern: v.string() })),
  });

  const config = v.parse(
    v.object({ ...DeploymentSchema.entries, env: v.object({ staging: DeploymentSchema }) }),
    Bun.JSONC.parse(readFileSync(join(import.meta.dirname, '..', 'wrangler.jsonc'), 'utf8')),
  );

  /** Every host a deployment's routes answer on, a preview label standing in for the wildcard. */
  const hosts = (deployment: v.InferOutput<typeof DeploymentSchema>): string[] =>
    [...new Set(deployment.routes.map((route) => route.pattern.replace(/\/\*$/u, '').replace(/^\*\./u, 'p-1234.')))];

  const SECRETS = { production: 'production-own-secret', staging: 'staging-own-secret' } as const;

  const deployments = {
    production: { hosts: hosts(config), env: { AUTH_KV: makeKv(), DEV_USER_EMAIL: config.vars.DEV_USER_EMAIL, DEV_IDENTITY_SECRET: SECRETS.production } },
    staging: { hosts: hosts(config.env.staging), env: { AUTH_KV: makeKv(), DEV_USER_EMAIL: config.env.staging.vars.DEV_USER_EMAIL, DEV_IDENTITY_SECRET: SECRETS.staging } },
  };

  async function identityOn(host: string, env: Parameters<typeof authenticateRequest>[1], headers: HeadersInit): Promise<string | number> {
    try {
      return (await authenticateRequest(new Request(`https://${host}/api/user/workspaces`, { headers }), env)).email;
    } catch (error) {
      if (error instanceof AuthError) return error.status;
      throw error;
    }
  }

  test('no public staging host grants it without staging\'s own secret, installed or not', async () => {
    const { DEV_IDENTITY_SECRET: _installed, ...uninstalled } = deployments.staging.env;

    const requests: HeadersInit[] = [
      {},
      { [DEV_IDENTITY_HEADER]: 'guess' },
      { [DEV_IDENTITY_HEADER]: '' },
      { [DEV_IDENTITY_ACCOUNT_HEADER]: 'devices' },
      { [DEV_IDENTITY_HEADER]: SECRETS.production },
    ];

    // Staging's app host and a preview host are both asked: the routes claim both.
    const app = new URL(config.env.staging.vars.CLI_PUBLIC_ORIGIN).host;

    expect(deployments.staging.hosts).toContain(app);
    expect(deployments.staging.hosts).toContain(`p-1234.${app}`);

    for (const host of deployments.staging.hosts) {
      for (const headers of requests) expect(await identityOn(host, deployments.staging.env, headers)).toBe(401);

      expect(await identityOn(host, uninstalled, { [DEV_IDENTITY_HEADER]: SECRETS.staging })).toBe(401);
    }
  });

  test('staging\'s secret acts on staging and on no production host', async () => {
    const staging = { [DEV_IDENTITY_HEADER]: SECRETS.staging };

    expect(await identityOn(new URL(config.env.staging.vars.CLI_PUBLIC_ORIGIN).host, deployments.staging.env, staging))
      .toBe(config.env.staging.vars.DEV_USER_EMAIL);

    for (const host of deployments.production.hosts) expect(await identityOn(host, deployments.production.env, staging)).toBe(401);
  });
});

