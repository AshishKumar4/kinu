// A session cookie is live while one row in the user's own DO says so. KV is read through two colos that
// disagree about a delete for a window, because that disagreement is what a stolen cookie would survive on.

import {
  TEST_CREDENTIAL_ENCRYPTION_KEY, createTestUserDO, type TestUserDO,
} from './helpers/user-do';
import { jsrpcStub } from './helpers/jsrpc-stub';
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import {
  SessionAuthorityUnavailableError, createSession, deriveUserId, revokeSession, verifySession,
  type OAuthProfile,
} from '../src/auth/store';
import {
  AuthError, SESSION_COOKIE_NAME, authenticateRequest, type AuthEnv,
} from '../src/auth/session';
import { handleAuthRequest, type AuthRoutesAuthority, type AuthRoutesEnv } from '../src/auth/routes';
import { unreachableNamespace } from './helpers/bindings';
import type { ObjectNamespace } from '@kinu.run/core';
import type { KvStore } from '@kinu.run/agent-utils';
import { OwnerCapabilityUnavailableError } from '@kinu.run/core';
import { sha256Hex } from '@kinu.run/core';
import type { UserDO } from '../src/user/user-do';
import {
  createRecordingLogger, renderThrownChain, setDiagnosticsSink, type RecordingLogger,
} from '@kinu.run/core/obs';

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

function kvFailing(kv: KvStore, operation: 'get' | 'put' | 'delete'): KvStore {
  return {
    get: (key) => (operation === 'get'
      ? Promise.reject(new Error('KV read refused'))
      : kv.get(key)),
    put: (key, value, options) => (operation === 'put'
      ? Promise.reject(new Error('KV write refused'))
      : kv.put(key, value, options)),
    delete: (key) => (operation === 'delete'
      ? Promise.reject(new Error('KV delete refused'))
      : kv.delete(key)),
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
async function rejection(call: Promise<unknown>): Promise<Error> {
  try {
    await call;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }

  throw new Error('the call did not fail');
}

function logoutRequest(token: string, returnTo?: string): Request {
  const url = new URL('https://kinu.example.com/logout');

  if (returnTo !== undefined) url.searchParams.set('return_to', returnTo);

  return new Request(url, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` },
  });
}

const open: Fleet[] = [];

const restoreSinks: Array<() => void> = [];

function openFleet(): Fleet {
  const built = fleet();
  open.push(built);

  return built;
}

/** An instrument nobody asserts on is one nobody notices has stopped. */
function recordDiagnostics(): RecordingLogger {
  const logger = createRecordingLogger();
  restoreSinks.push(setDiagnosticsSink(logger));

  return logger;
}

afterEach(() => {
  setSystemTime();

  while (restoreSinks.length > 0) restoreSinks.pop()?.();

  while (open.length > 0) open.pop()?.close();
});

describe('logout ends one session everywhere at once', () => {
  test('a cookie copied off the browser is refused at a colo the KV delete has not reached', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const near = envWith(kv.near, authority.namespace);
    const far = envWith(kv.far, authority.namespace);

    const session = await createSession(near, profile('person@example.com'));
    expect(await verifySession(near, session.token)).not.toBeNull();
    expect(await verifySession(far, session.token)).not.toBeNull();

    await revokeSession(near, session.token);

    // The far colo still has the KV record, the window a stolen cookie would live in, and refuses anyway.
    expect(await kv.far.get(`session:${await sha256Hex(session.token)}`)).not.toBeNull();
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
    const refused = await handleAuthRequest(logoutRequest(session.token), outage);

    expect(refused?.status).toBe(503);
    expect(refused?.headers.get('location')).toBeNull();
    // Not cleared: the cookie is the only handle that can still revoke this session.
    expect(refused?.headers.get('set-cookie')).toBeNull();
    const page = await refused?.text() ?? '';
    expect(page).toContain('NOT signed out');
    expect(page).toContain('href="/logout?return_to=%2F"');
    expect(await verifySession(env, session.token)).not.toBeNull();

    const retried = await handleAuthRequest(logoutRequest(session.token), env);

    expect(retried?.status).toBe(302);
    expect(retried?.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await verifySession(env, session.token)).toBeNull();
    expect(await verifySession(far, session.token)).toBeNull();
  });

  test('a successful logout redirects and leaves no KV record behind', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const env = envWith(kv.near, authority.namespace);
    const session = await createSession(env, profile('person@example.com'));

    const response = await handleAuthRequest(logoutRequest(session.token, '/dashboard'), env);

    expect(response?.status).toBe(302);
    expect(response?.headers.get('location')).toBe('https://kinu.example.com/dashboard');
    expect(kv.keys()).toEqual([]);
    expect(liveSessions(authority.objectFor(session.identity.userId))).toEqual([]);
  });

  test('a KV cleanup that fails does not report a revocation that landed as failed', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const env = envWith(kv.near, authority.namespace);
    const session = await createSession(env, profile('person@example.com'));

    const cleanupFails = envWith(kvFailing(kv.near, 'delete'), authority.namespace);
    await revokeSession(cleanupFails, session.token);

    // The authority row went first, so the session is already dead at every colo.
    expect(await verifySession(env, session.token)).toBeNull();
    expect(await verifySession(envWith(kv.far, authority.namespace), session.token)).toBeNull();
    expect(kv.keys().filter((key) => key.startsWith('session:'))).toHaveLength(1);
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
    expect(kv.keys().filter((key) => key.startsWith('session:'))).toEqual([]);
  });

  test('a failed KV write withdraws the row it already published', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const env = envWith(kvFailing(kv.near, 'put'), authority.namespace);

    const failure = await rejection(createSession(env, profile('person@example.com')));
    expect(failure).toBeInstanceOf(SessionAuthorityUnavailableError);
    expect(renderThrownChain({ cause: failure })).toContain('KV write refused');

    const userId = await deriveUserId('person@example.com');
    expect(liveSessions(authority.objectFor(userId))).toEqual([]);
    expect(kv.keys().filter((key) => key.startsWith('session:'))).toEqual([]);
  });

  test('a withdrawal that fails too still reports the write that failed, and still no cookie', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const env = envWith(kvFailing(kv.near, 'put'), authority.broken('revokeBrowserSession'));

    // Report the failure that stopped the sign-in, not the tidy-up that also failed.
    const failure = await rejection(createSession(env, profile('person@example.com')));
    expect(renderThrownChain({ cause: failure })).toContain('KV write refused');

    // Stranded until expiry, harmlessly: the token was never returned and no KV record written.
    const userId = await deriveUserId('person@example.com');
    expect(liveSessions(authority.objectFor(userId))).toHaveLength(1);
    expect(kv.keys().filter((key) => key.startsWith('session:'))).toEqual([]);
  });
});

describe('a store that will not answer is refused, never waved through', () => {
  test('verification reports the outage instead of trusting the KV record', async () => {
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
    expect(refusal.message).toContain('cannot reach the store');
  });

  test('a deployment holding no UserDO binding refuses the cookie rather than reading KV alone', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const session = await createSession(envWith(kv.near, authority.namespace), profile('person@example.com'));

    const refusal = await refusalFor(session.token, { AUTH_KV: kv.near });
    expect(refusal.status).toBe(500);
    expect(refusal.message).toContain('UserDO binding');
  });

  test('a deployment holding no owner secret says that, rather than blaming an outage', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const session = await createSession(envWith(kv.near, authority.namespace), profile('person@example.com'));

    // Retrying does not fix an unset secret, so it must not read as "try again".
    await expect(verifySession(envWith(kv.near, authority.namespace, ''), session.token))
      .rejects.toBeInstanceOf(OwnerCapabilityUnavailableError);
  });

  test('a KV read outage is the same 503, not an opaque 500', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const env = envWith(kv.near, authority.namespace);
    const session = await createSession(env, profile('person@example.com'));

    const outage = envWith(kvFailing(kv.near, 'get'), authority.namespace);
    const refusal = await refusalFor(session.token, outage);
    expect(refusal.status).toBe(503);
    expect(renderThrownChain({ cause: refusal })).toContain('KV read refused');
  });

  test('a record KV does not hold is not an outage, not a fault, and not a sign-out', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const env = envWith(kv.near, authority.namespace);
    const session = await createSession(env, profile('person@example.com'));
    await kv.near.delete(`session:${await sha256Hex(session.token)}`);

    const logs = recordDiagnostics();
    // An absent projection is an unreached colo or an evicted record; the row keeps the session live, and every
    // path that ends a session deletes the row first, so this cannot be a revoked one coming back.
    expect(await verifySession(env, session.token)).toMatchObject(session.identity);

    const stranger = `ps_${session.identity.userId}_${'x'.repeat(64)}`;
    expect((await refusalFor(stranger, env)).status).toBe(401);
    expect(logs.emitted).toEqual([]);
  });

  test('a record that no longer decodes is reported, cleared from both stores, and signed out', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const env = envWith(kv.near, authority.namespace);
    const session = await createSession(env, profile('person@example.com'));
    const key = `session:${await sha256Hex(session.token)}`;
    await kv.near.put(key, JSON.stringify({ userId: session.identity.userId }), { expirationTtl: 600 });

    const logs = recordDiagnostics();
    const refusal = await refusalFor(session.token, env);

    expect(refusal.status).toBe(401);
    const malformed = logs.emitted.filter((line) => line.event === 'auth.browser_session_record_malformed');
    expect(malformed).toHaveLength(1);
    expect(malformed[0]?.code).toBe('bad_input');
    // The fault is named without quoting the bytes, the token or its hash.
    expect(malformed[0]?.cause ?? '').not.toContain(session.token);
    expect(malformed[0]?.cause ?? '').not.toContain(await sha256Hex(session.token));
    expect(malformed[0]?.fields).toEqual({});
    // Both stores are cleared rather than waiting on expiry, and no cleanup is reported failed.
    expect(await kv.near.get(key)).toBeNull();
    expect(liveSessions(authority.objectFor(session.identity.userId))).toEqual([]);
    expect(logs.emitted.map((line) => line.event)).toEqual(['auth.browser_session_record_malformed']);
  });

  test('a cleanup outage after a corrupt record still signs out, and still says what failed', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const env = envWith(kv.near, authority.namespace);
    const session = await createSession(env, profile('person@example.com'));
    const key = `session:${await sha256Hex(session.token)}`;
    await kv.near.put(key, JSON.stringify({ userId: session.identity.userId }), { expirationTtl: 600 });

    const outage = envWith(kvFailing(kv.near, 'delete'), authority.broken('revokeBrowserSession'));
    const logs = recordDiagnostics();
    const refusal = await refusalFor(session.token, outage);

    expect(refusal.status).toBe(401);
    expect(logs.emitted.map((line) => line.event)).toEqual([
      'auth.browser_session_record_malformed',
      'auth.browser_session_row_left',
      'auth.browser_session_record_left',
    ]);
    expect(liveSessions(authority.objectFor(session.identity.userId))).toHaveLength(1);
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

/**
 * The write side of the window: the first request after sign-in can reach a colo with no record, so the
 * authority row (already asked about liveness) carries the identity in the same round trip.
 */
describe('a sign-in is usable before its KV projection has replicated', () => {
  test('the first request at a colo the write has not reached is signed in, not sent back to sign in', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const session = await createSession(envWith(kv.near, authority.namespace), profile('person@example.com'));
    const cold = envWith(kv.cold, authority.namespace);

    expect(await kv.cold.get(`session:${await sha256Hex(session.token)}`)).toBeNull();

    // The row's own copy, carrying the full identity the projection would have.
    expect(await verifySession(cold, session.token)).toMatchObject(session.identity);

    const request = new Request('https://kinu.example.com/api/workspaces', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.token)}` },
    });

    expect(await authenticateRequest(request, cold)).toMatchObject(session.identity);
  });

  test('a revoked cookie is refused at a colo with no projection to check', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const near = envWith(kv.near, authority.namespace);
    const session = await createSession(near, profile('person@example.com'));

    await revokeSession(near, session.token);

    // The fallback reads a row that is gone, so an absent projection cannot become a reason to trust the cookie.
    const cold = envWith(kv.cold, authority.namespace);
    expect(await kv.cold.get(`session:${await sha256Hex(session.token)}`)).toBeNull();
    expect(await verifySession(cold, session.token)).toBeNull();
    expect((await refusalFor(session.token, cold)).status).toBe(401);
  });

  test('a lapsed cookie is refused there too, and the row is what says so', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const session = await createSession(envWith(kv.near, authority.namespace), profile('person@example.com'));
    const object = authority.objectFor(session.identity.userId);

    setSystemTime(new Date(session.expiresAt + 1_000));

    expect(await verifySession(envWith(kv.cold, authority.namespace), session.token)).toBeNull();
    expect(liveSessions(object)).toEqual([]);
  });

  test('a row registered before it carried an identity refuses rather than answer with half of one', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const near = envWith(kv.near, authority.namespace);
    const session = await createSession(near, profile('person@example.com'));
    // Pre-identity-columns row: live, but cannot say what its cookie stands for.
    authority.objectFor(session.identity.userId).db.run(
      `UPDATE user_browser_sessions
          SET email = NULL, display_name = NULL, provider = NULL, provider_sub = NULL, auth_time = NULL`,
    );

    // Where the projection replicated it still answers, so a deploy does not sign everybody out.
    expect(await verifySession(near, session.token)).toMatchObject(session.identity);
    expect(await verifySession(envWith(kv.cold, authority.namespace), session.token)).toBeNull();
  });
});
