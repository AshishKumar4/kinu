// A session cookie is live while one row in the user's own DO says so, whichever colo asks; KV, read through two
// colos that disagree for a window, holds only the OAuth handoff.

import {
  TEST_CREDENTIAL_ENCRYPTION_KEY, createTestUserDO, type TestUserDO,
} from './helpers/user-do';
import { jsrpcStub } from './helpers/jsrpc-stub';
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import {
  SessionAuthorityUnavailableError, createSession, revokeSession, verifySession,
  type OAuthProfile,
} from '../src/auth/store';
import {
  AuthError, SESSION_COOKIE_NAME, authenticateRequest, type AuthEnv,
} from '../src/auth/session';
import { authPageRoutes, type AuthRoutesAuthority, type AuthRoutesEnv } from '../src/auth/routes';
import { unreachableNamespace, workerContext } from './helpers/bindings';
import { serveFamily } from './helpers/api';
import type { ObjectNamespace } from '@kinu.run/core';
import type { KvStore } from '@kinu.run/agent-utils';
import { OwnerCapabilityUnavailableError } from '@kinu.run/core';
import type { UserDO } from '../src/user/user-do';

const authPages = serveFamily(authPageRoutes, { ctx: workerContext() });

const KV_REPLICATION_LAG_MS = 60_000;

interface KvEntry { value: string; expiresAt: number; replicatedAt: number }

interface ReplicatedKv {
  near: KvStore;
  far: KvStore;
  /** A record written less than {@link KV_REPLICATION_LAG_MS} ago reads as absent here: the first request after sign-in can land on it. */
  cold: KvStore;
  keys(): string[];
}

/** Puts reach `cold`, deletes reach `far`, only after the replication window; a cookie must be answered correctly in both directions. */
function replicatedKv(): ReplicatedKv {
  const origin = new Map<string, KvEntry>();
  const lagging = new Map<string, { entry: KvEntry; until: number }>();

  const live = (entry: KvEntry | undefined): KvEntry | null =>
    entry !== undefined && entry.expiresAt > Date.now() ? entry : null;

  const view = (lag: { writes?: boolean; deletes?: boolean }): KvStore => ({
    async get(key) {
      const current = live(origin.get(key));

      if (current) return !lag.writes || Date.now() >= current.replicatedAt ? current.value : null;

      if (!lag.deletes) return null;
      const stale = lagging.get(key);

      if (stale && Date.now() < stale.until) return live(stale.entry)?.value ?? null;

      return null;
    },
    async put(key, value, options) {
      lagging.delete(key);
      origin.set(key, {
        value,
        expiresAt: Date.now() + options.expirationTtl * 1000,
        replicatedAt: Date.now() + KV_REPLICATION_LAG_MS,
      });
    },
    async delete(key) {
      const entry = origin.get(key);

      if (entry) lagging.set(key, { entry, until: Date.now() + KV_REPLICATION_LAG_MS });
      origin.delete(key);
    },
  });

  return {
    near: view({}),
    far: view({ deletes: true }),
    cold: view({ writes: true }),
    keys: () => [...origin.keys()].filter((key) => live(origin.get(key)) !== null),
  };
}

type SessionMethod = 'registerBrowserSession' | 'verifyBrowserSession' | 'revokeBrowserSession';

type TestNamespace = ObjectNamespace<string, AuthRoutesAuthority>;

interface Fleet {
  namespace: TestNamespace;
  /** Built on first address, as the runtime does. */
  objectFor(userId: string): TestUserDO;
  broken(method: SessionMethod): TestNamespace;
  close(): void;
}

function fleet(): Fleet {
  const objects = new Map<string, TestUserDO>();

  const objectFor = (userId: string): TestUserDO => {
    let harness = objects.get(userId);

    if (!harness) {
      harness = createTestUserDO({ durableObjectId: userId });
      objects.set(userId, harness);
    }

    return harness;
  };

  const namespaceFor = (broken: SessionMethod | null): TestNamespace => ({
    idFromName: (name: string) => name,
    get: (id: string) => {
      const real = objectFor(id).userDO;

      const refuse = (method: SessionMethod) => (broken === method
        ? Promise.reject(new Error('Durable Object unreachable'))
        : null);

      // Methods on the prototype, so a copy cannot flatten the delegation away. No case signs in with Cloudflare,
      // so reaching the other two sign-in calls names itself rather than answering.
      return jsrpcStub({
        setCredential: (): never => { throw new Error('setCredential: not reachable in this test'); },
        listActiveWorkspaces: (): never => { throw new Error('listActiveWorkspaces: not reachable in this test'); },
        builtinHasOwner: (): never => { throw new Error('builtinHasOwner: not reachable in this test'); },
        builtinInvitedEmail: (): never => { throw new Error('builtinInvitedEmail: not reachable in this test'); },
        builtinResetAccount: (): never => { throw new Error('builtinResetAccount: not reachable in this test'); },
        ensureProfile: (...args: Parameters<UserDO['ensureProfile']>) => real.ensureProfile(...args),
        registerBrowserSession: (...args: Parameters<UserDO['registerBrowserSession']>) =>
          refuse('registerBrowserSession') ?? real.registerBrowserSession(...args),
        verifyBrowserSession: (...args: Parameters<UserDO['verifyBrowserSession']>) =>
          refuse('verifyBrowserSession') ?? real.verifyBrowserSession(...args),
        revokeBrowserSession: (...args: Parameters<UserDO['revokeBrowserSession']>) =>
          refuse('revokeBrowserSession') ?? real.revokeBrowserSession(...args),
      });
    },
  });

  return {
    namespace: namespaceFor(null),
    objectFor,
    broken: (method) => namespaceFor(method),
    close: () => { for (const harness of objects.values()) harness.close(); },
  };
}

function envWith(
  kv: KvStore,
  namespace: TestNamespace,
  credentialEncryptionKey = TEST_CREDENTIAL_ENCRYPTION_KEY,
): AuthRoutesEnv<string> {
  return {
    AUTH_KV: kv,
    UserDO: namespace,
    CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey,
    // Only the Cloudflare callback fans a credential change out, and no case here signs in.
    OrchestratorAgent: unreachableNamespace('OrchestratorAgent'),
  };
}

function profile(email: string, sub = 'cf-1'): OAuthProfile {
  return { provider: 'cloudflare', providerSub: sub, email, emailVerified: true, displayName: null };
}

function liveSessions(harness: TestUserDO): string[] {
  return harness.db
    .query<{ token_hash: string }, []>('SELECT token_hash FROM user_browser_sessions ORDER BY token_hash')
    .all()
    .map((row) => row.token_hash);
}

async function refusalFor(token: string, env: AuthEnv<string>): Promise<AuthError> {
  const request = new Request('https://kinu.example.com/api/workspaces', {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` },
  });

  try {
    await authenticateRequest(request, env);
  } catch (error) {
    if (error instanceof AuthError) return error;
    throw error;
  }

  throw new Error('the cookie was accepted');
}

/** As a value, so both its class and its cause chain can be read. */
function logoutRequest(token: string, returnTo?: string): Request {
  const url = new URL('https://kinu.example.com/logout');

  if (returnTo !== undefined) url.searchParams.set('return_to', returnTo);

  return new Request(url, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` },
  });
}

const open: Fleet[] = [];


function openFleet(): Fleet {
  const built = fleet();
  open.push(built);

  return built;
}

afterEach(() => {
  setSystemTime();

  while (open.length > 0) open.pop()?.close();
});

describe('logout ends one session everywhere at once', () => {
  test('a cookie copied off the browser is refused at every colo once the session is revoked', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const near = envWith(kv.near, authority.namespace);
    const far = envWith(kv.far, authority.namespace);

    const session = await createSession(near, profile('person@example.com'));
    expect(await verifySession(near, session.token)).not.toBeNull();
    expect(await verifySession(far, session.token)).not.toBeNull();

    await revokeSession(near, session.token);

    expect(await verifySession(far, session.token)).toBeNull();
    expect(await verifySession(near, session.token)).toBeNull();
  });

  test('the user\'s other sessions stay signed in', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const near = envWith(kv.near, authority.namespace);
    const far = envWith(kv.far, authority.namespace);

    const device = await createSession(near, profile('person@example.com'));
    const phone = await createSession(near, profile('person@example.com'));
    expect(phone.identity.userId).toBe(device.identity.userId);
    expect(liveSessions(authority.objectFor(device.identity.userId))).toHaveLength(2);

    await revokeSession(near, device.token);

    expect(await verifySession(near, phone.token)).not.toBeNull();
    expect(await verifySession(far, phone.token)).not.toBeNull();
    expect(liveSessions(authority.objectFor(device.identity.userId))).toHaveLength(1);
  });

  test('a token routes to its own user, so one account\'s logout cannot reach another\'s', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const env = envWith(kv.near, authority.namespace);

    const first = await createSession(env, profile('first@example.com', 'cf-first'));
    const second = await createSession(env, profile('second@example.com', 'cf-second'));
    expect(second.identity.userId).not.toBe(first.identity.userId);

    await revokeSession(env, first.token);

    expect(await verifySession(env, second.token)).not.toBeNull();
    expect(liveSessions(authority.objectFor(first.identity.userId))).toEqual([]);
    expect(liveSessions(authority.objectFor(second.identity.userId))).toHaveLength(1);
  });

  test('a revocation that did not land keeps the cookie, says so, and offers a retry that works', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const env = envWith(kv.near, authority.namespace);
    const far = envWith(kv.far, authority.namespace);
    const session = await createSession(env, profile('person@example.com'));

    const outage = envWith(kv.near, authority.broken('revokeBrowserSession'));
    const refused = await authPages(logoutRequest(session.token), outage);

    expect(refused?.status).toBe(503);
    expect(refused?.headers.get('location')).toBeNull();
    // Not cleared: the cookie is the only handle that can still revoke this session.
    expect(refused?.headers.get('set-cookie')).toBeNull();
    const page = await refused?.text() ?? '';
    expect(page).toContain('href="/logout?return_to=%2F"');
    expect(await verifySession(env, session.token)).not.toBeNull();

    const retried = await authPages(logoutRequest(session.token), env);

    expect(retried?.status).toBe(302);
    expect(retried?.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await verifySession(env, session.token)).toBeNull();
    expect(await verifySession(far, session.token)).toBeNull();
  });

  test('a successful logout redirects and leaves no session behind', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const env = envWith(kv.near, authority.namespace);
    const session = await createSession(env, profile('person@example.com'));

    const response = await authPages(logoutRequest(session.token, '/dashboard'), env);

    expect(response?.status).toBe(302);
    expect(response?.headers.get('location')).toBe('https://kinu.example.com/dashboard');
    expect(liveSessions(authority.objectFor(session.identity.userId))).toEqual([]);
  });
});

describe('a sign-in that cannot publish its session hands out no cookie', () => {
  test('the authority refusing the row fails the sign-in', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const env = envWith(kv.near, authority.broken('registerBrowserSession'));

    await expect(createSession(env, profile('person@example.com')))
      .rejects.toThrow('Durable Object unreachable');
  });
});

describe('a store that will not answer is refused, never waved through', () => {
  test('verification reports the outage instead of answering', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const env = envWith(kv.near, authority.namespace);
    const session = await createSession(env, profile('person@example.com'));

    const outage = envWith(kv.near, authority.broken('verifyBrowserSession'));
    await expect(verifySession(outage, session.token))
      .rejects.toBeInstanceOf(SessionAuthorityUnavailableError);
  });

  test('the request gets a 503, not the 401 that would send a signed-in user to sign in again', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const env = envWith(kv.near, authority.namespace);
    const session = await createSession(env, profile('person@example.com'));

    const outage = envWith(kv.near, authority.broken('verifyBrowserSession'));
    const refusal = await refusalFor(session.token, outage);
    expect(refusal.status).toBe(503);
  });

  test('a deployment holding no UserDO binding refuses the cookie', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const session = await createSession(envWith(kv.near, authority.namespace), profile('person@example.com'));

    const refusal = await refusalFor(session.token, { AUTH_KV: kv.near });
    expect(refusal.status).toBe(500);
  });

  test('a deployment holding no owner secret says that, rather than blaming an outage', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const session = await createSession(envWith(kv.near, authority.namespace), profile('person@example.com'));

    // Retrying does not fix an unset secret, so it must not read as "try again".
    await expect(verifySession(envWith(kv.near, authority.namespace, ''), session.token))
      .rejects.toBeInstanceOf(OwnerCapabilityUnavailableError);
  });
});

describe('expiry needs no sweeper', () => {
  test('the next verification drops the lapsed row and refuses the cookie', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const env = envWith(kv.near, authority.namespace);

    const session = await createSession(env, profile('person@example.com'));
    const object = authority.objectFor(session.identity.userId);
    expect(liveSessions(object)).toHaveLength(1);

    setSystemTime(new Date(session.expiresAt + 1_000));
    const fresh = await createSession(env, profile('person@example.com'));

    expect(await verifySession(env, fresh.token)).not.toBeNull();
    expect(liveSessions(object)).toHaveLength(1);
    expect(await verifySession(env, session.token)).toBeNull();
  });
});

/** The first request after sign-in can reach any colo; the account's row answers it, with the whole identity. */
describe('a sign-in is usable at once, wherever its first request lands', () => {
  test('the first request at another colo is signed in, not sent back to sign in', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const session = await createSession(envWith(kv.near, authority.namespace), profile('person@example.com'));
    const cold = envWith(kv.cold, authority.namespace);

    expect(await verifySession(cold, session.token)).toMatchObject(session.identity);

    const request = new Request('https://kinu.example.com/api/workspaces', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.token)}` },
    });

    expect(await authenticateRequest(request, cold)).toMatchObject(session.identity);
  });
});
