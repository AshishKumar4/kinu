// A session cookie is live while ONE row in the signing-in user's own Durable
// Object says so. These tests read that row through the real UserDO, and read
// KV through two colos that disagree about a delete for a minute, because the
// disagreement is what a stolen cookie used to survive on.

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
import { handleAuthRequest } from '../src/auth/routes';
import type { KvStore } from '../src/lib/kv';
import { OwnerCapabilityUnavailableError } from '../src/user/workspace-capability';
import { sha256Hex } from '../src/lib/crypto';
import type { UserDO } from '../src/user/user-do';
import {
  createRecordingLogger, renderThrownChain, setDiagnosticsSink, type RecordingLogger,
} from '@kinu.run/core/obs';

/** What Cloudflare gives a KV write, or a KV delete, to reach every colo. */
const KV_REPLICATION_LAG_MS = 60_000;

interface KvEntry { value: string; expiresAt: number; replicatedAt: number }

interface ReplicatedKv {
  /** The colo that served the write or the delete. */
  near: KvStore;
  /** A colo a delete has not reached yet. */
  far: KvStore;
  /** A colo a WRITE has not reached yet: a record written less than
   *  {@link KV_REPLICATION_LAG_MS} ago reads as absent here, which is what the
   *  first request after a sign-in redirect can land on. */
  cold: KvStore;
  keys(): string[];
}

/** One KV namespace as three colos see it. A put is visible at `near` at once
 *  and at `cold` only after the replication window; a delete is visible at
 *  `near` at once and at `far` only after it. Both directions are the same
 *  window, and a session cookie has to be answered correctly in both. */
function replicatedKv(): ReplicatedKv {
  const origin = new Map<string, KvEntry>();
  const lagging = new Map<string, { entry: KvEntry; until: number }>();

  const live = (entry: KvEntry | undefined): KvEntry | null =>
    entry !== undefined && entry.expiresAt > Date.now() ? entry : null;

  const view = (lag: { writes?: boolean; deletes?: boolean }): KvStore => ({
    async get(key) {
      const current = live(origin.get(key));
      // A write is not readable at a colo it has not reached yet.
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

/** A KV view with one operation refused, for the awaits a session lifecycle
 *  spends inside KV. */
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

/** A namespace binding as this suite supplies it: the two members the auth
 *  store calls on one, handing back a stub-shaped double of a real UserDO. */
interface TestNamespace {
  idFromName(name: string): string;
  get(id: string): Pick<UserDO,
    'ensureProfile' | 'registerBrowserSession' | 'verifyBrowserSession' | 'revokeBrowserSession'>;
}

interface Fleet {
  namespace: TestNamespace;
  /** The user's real Durable Object, built on first address, as the runtime does. */
  objectFor(userId: string): TestUserDO;
  /** The same fleet with one session method refusing every call. */
  broken(method: SessionMethod): TestNamespace;
  close(): void;
}

/** Real UserDO instances behind a namespace binding, one per user id. */
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
      // A double with a stub's shape: methods on the prototype, so the
      // delegation cannot be flattened away by a copy.
      return jsrpcStub({
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
): Env {
  const partial: Partial<Env> = {};
  Object.assign(partial, {
    AUTH_KV: kv,
    UserDO: namespace,
    CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey,
  });
  // SAFETY: sign-in, verification and logout read exactly the constructed KV
  // namespace, UserDO namespace and credential key; every reachable binding is
  // present above.
  return partial as Env;
}

function profile(email: string, sub = 'cf-1'): OAuthProfile {
  return { provider: 'cloudflare', providerSub: sub, email, emailVerified: true, displayName: null };
}

/** The session hashes this user's Durable Object still calls live. */
function liveSessions(harness: TestUserDO): string[] {
  return harness.db
    .query<{ token_hash: string }, []>('SELECT token_hash FROM user_browser_sessions ORDER BY token_hash')
    .all()
    .map((row) => row.token_hash);
}

/** The `AuthError` a cookie was refused with, as a value to assert against. */
async function refusalFor(token: string, env: AuthEnv): Promise<AuthError> {
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

/** The error a call rejected with, as a value, so its class and its cause
 *  chain can both be read. */
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

/** The diagnostics the step after this call emits. An instrument nobody asserts
 *  on is an instrument nobody notices has stopped. */
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

    // The far colo still HAS the KV record — that is the propagation window the
    // stolen cookie used to live in — and refuses the cookie anyway.
    expect(await kv.far.get(`session:${await sha256Hex(session.token)}`)).not.toBeNull();
    expect(await verifySession(far, session.token)).toBeNull();
    expect(await verifySession(near, session.token)).toBeNull();
  });

  test('the user\'s other sessions stay signed in', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const near = envWith(kv.near, authority.namespace);
    const far = envWith(kv.far, authority.namespace);

    const laptop = await createSession(near, profile('person@example.com'));
    const phone = await createSession(near, profile('person@example.com'));
    expect(phone.identity.userId).toBe(laptop.identity.userId);
    expect(liveSessions(authority.objectFor(laptop.identity.userId))).toHaveLength(2);

    await revokeSession(near, laptop.token);

    expect(await verifySession(near, phone.token)).not.toBeNull();
    expect(await verifySession(far, phone.token)).not.toBeNull();
    expect(liveSessions(authority.objectFor(laptop.identity.userId))).toHaveLength(1);
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
    // The cookie is NOT cleared: it is the only handle that can still revoke
    // this session, and the page says the session is still signed in.
    expect(refused?.headers.get('set-cookie')).toBeNull();
    const page = await refused?.text() ?? '';
    expect(page).toContain('NOT signed out');
    expect(page).toContain('href="/logout?return_to=%2F"');
    expect(await verifySession(env, session.token)).not.toBeNull();

    // The retry the page offers, once the authority answers again.
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

    // The authority row went first, so the session is already dead at every
    // colo. What KV kept is a snapshot standing for nothing.
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

    // The failure the operator needs is the one that stopped the sign-in, not
    // the tidy-up that also failed.
    const failure = await rejection(createSession(env, profile('person@example.com')));
    expect(renderThrownChain({ cause: failure })).toContain('KV write refused');

    // The row is stranded until it expires, and it stands for nothing: the
    // token was never returned and no KV record was ever written for it.
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
    // An absent projection is what a colo the write has not reached sees, and
    // what an evicted record leaves. The row is still there, so the session is
    // still live — and every path that ENDS a session deletes the row first, so
    // this can never be a revoked one coming back.
    expect(await verifySession(env, session.token)).toEqual(session.identity);

    // A cookie for a session this deployment has never held is still simply not
    // signed in: refused, with nothing to report about it.
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
    // What a deployment that changed the record's shape leaves behind.
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
    // Both stores are cleared, so the dead credential is gone rather than
    // waiting on a 30-day expiry, and no cleanup was reported as failed.
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

    // Both cleanups refused: the row through an unreachable object, the record
    // through a KV delete that will not run.
    const outage = envWith(kvFailing(kv.near, 'delete'), authority.broken('revokeBrowserSession'));
    const logs = recordDiagnostics();
    const refusal = await refusalFor(session.token, outage);

    // Refused, never authenticated, and neither failure was swallowed.
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
    // The lapsed row is gone, and no alarm or sweep removed it.
    expect(liveSessions(object)).toHaveLength(1);
    expect(await verifySession(env, session.token)).toBeNull();
  });
});

/**
 * The other half of the same propagation window. A KV write is no faster than
 * a KV delete, so the first request after a sign-in redirect can land at a colo
 * that has no record of the session: that used to read as "not signed in", and
 * the browser was sent back to a sign-in whose own write would lose the same
 * race. The row the authority already has to be asked about liveness carries
 * the identity too, so the answer is there in the same round trip.
 */
describe('a sign-in is usable before its KV projection has replicated', () => {
  test('the first request at a colo the write has not reached is signed in, not sent back to sign in', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const session = await createSession(envWith(kv.near, authority.namespace), profile('person@example.com'));
    const cold = envWith(kv.cold, authority.namespace);

    // The projection genuinely is not readable there — this is the negative
    // read the browser used to be bounced on.
    expect(await kv.cold.get(`session:${await sha256Hex(session.token)}`)).toBeNull();

    // What comes back is the row's own copy, and it is the identity the
    // projection would have carried, not a thinner stand-in for it.
    expect(await verifySession(cold, session.token)).toEqual(session.identity);
    const request = new Request('https://kinu.example.com/api/workspaces', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.token)}` },
    });
    expect(await authenticateRequest(request, cold)).toEqual(session.identity);
  });

  test('a revoked cookie is refused at a colo with no projection to check', async () => {
    const kv = replicatedKv();
    const authority = openFleet();
    const near = envWith(kv.near, authority.namespace);
    const session = await createSession(near, profile('person@example.com'));

    await revokeSession(near, session.token);

    // The fallback reads a row that is GONE, so an absent projection cannot
    // become a reason to trust the cookie.
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
    // What a deployment from before the identity columns leaves in the table:
    // a live row that cannot say what its cookie stands for.
    authority.objectFor(session.identity.userId).db.run(
      `UPDATE user_browser_sessions
          SET email = NULL, display_name = NULL, provider = NULL, provider_sub = NULL, auth_time = NULL`,
    );

    // Where the projection replicated, it still answers, so a deploy does not
    // sign everybody out.
    expect(await verifySession(near, session.token)).toEqual(session.identity);
    // Where it has not, the cookie is refused. The row is the only other copy,
    // and it has nothing to say.
    expect(await verifySession(envWith(kv.cold, authority.namespace), session.token)).toBeNull();
  });
});
