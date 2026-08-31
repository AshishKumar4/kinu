import {
  TEST_CREDENTIAL_ENCRYPTION_KEY, createTestUserDO, provisionTestWorkspace, testOwner,
} from './helpers/user-do';
import { describe, expect, setSystemTime, test } from 'bun:test';
import {
  approveCliAuth,
  inspectCliAuth,
  pollCliAuth,
  startCliAuth,
} from '../src/cli/auth-store';
import { makeKv } from './helpers/kv';
import { RateLimitError } from '../src/cli/auth-store';
import { handleCliRequest } from '../src/cli/routes';
import type { KvStore } from '../src/lib/kv';
import type { UserCaller } from '../src/user/workspace-capability';
import { sha256Hex } from '../src/lib/crypto';
import * as v from 'valibot';

const ErrorResponseSchema = v.object({ error: v.string() });

interface TestNamespace<Stub> {
  idFromName(name: string): string;
  get(): Stub;
}

interface CliAuthTestBindings<Stub> {
  AUTH_KV: KvStore;
  UserDO: TestNamespace<Stub>;
  CREDENTIAL_ENCRYPTION_KEY: string;
}

function testEnv<Stub>(bindings: CliAuthTestBindings<Stub>): Env {
  const env: Partial<Env> = {};
  Object.assign(env, bindings);
  // SAFETY: CLI auth reads exactly the constructed KV namespace, UserDO
  // namespace, and credential key; every reachable binding is present.
  return env as Env;
}

function handled(response: Response | null): Response {
  if (!response) throw new Error('CLI auth route did not handle the request');
  return response;
}

function setupEnv() {
  const kv = makeKv();
  const minted: string[] = [];
  const claimed: string[] = [];
  const userDO = {
    async ensureProfile() {},
    async mintCliToken(_caller: UserCaller, userId: string, authorizationHash: string, label?: string) {
      // The real UserDO makes a second mint against one approval impossible
      // with a unique index (unit-user-authority-races.test.ts drives that
      // against the real object). This double refuses the same way, in the same
      // words, so what is exercised HERE is the flow's half of the contract:
      // that the poll names the approval at all, and that it turns the DO's
      // refusal into the answer the CLI already understands.
      if (claimed.includes(authorizationHash)) {
        throw new Error('That CLI authorization has already been redeemed.');
      }
      claimed.push(authorizationHash);
      const token = `ptc_${userId}_testtoken`;
      minted.push(`${label ?? ''}:${token}`);
      return { token, tokenHash: 'hash', expiresAt: Date.now() + 60_000 };
    },
  };
  return {
    kv,
    minted,
    claimed,
    env: testEnv({
      AUTH_KV: kv,
      UserDO: {
        idFromName(name: string) { return name; },
        get() { return userDO; },
      }, CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY }),
  };
}

/** A namespace whose writes fail, so a store outage stays a store outage all
 *  the way to the response instead of being read as a code collision. */
function brokenKv(): KvStore {
  return {
    async get() { return null; },
    async put() { throw new Error('KV put failed: namespace unavailable'); },
    async delete() {},
  };
}

describe('KV-backed CLI auth store', () => {
  test('approves and consumes a CLI auth request exactly once', async () => {
    const { env, kv, minted, claimed } = setupEnv();
    const userId = '0123456789abcdef0123456789abcdef';

    const started = await startCliAuth(env, 'https://kinu.example.com', 'https://kinu.example.com', 'Ashish terminal', '127.0.0.1');
    expect(started.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(started.verificationUrl).toContain(`/cli/auth?code=${encodeURIComponent(started.userCode)}`);

    const pending = await inspectCliAuth(kv, started.userCode);
    expect(pending).toMatchObject({ status: 'pending', deviceName: 'Ashish terminal' });

    await approveCliAuth(env, started.userCode, {
      userId,
      email: 'ashish@example.com',
      sub: 'sub',
      provider: 'test',
      authTime: Date.now(),
    }, '127.0.0.1');

    const approved = await pollCliAuth(env, started.deviceToken, '127.0.0.1');
    expect(approved.status).toBe('approved');
    expect(approved.token).toBe(`ptc_${userId}_testtoken`);
    expect(minted).toHaveLength(1);

    const second = await pollCliAuth(env, started.deviceToken, '127.0.0.1');
    expect(second.status).toBe('expired');
    expect(second.message).toContain('already delivered');
    expect(minted).toHaveLength(1);

    // ONE APPROVAL, ONE TOKEN, and the claim that holds it to that is the
    // mint's own: the KV record it was read from cannot enforce this — no
    // compare-and-swap, and colo-cached reads — so the poll names the approval
    // and the Durable Object refuses the second redemption. Here the KV record
    // is deliberately rewound to `approved` first, which is exactly what a
    // stale colo read looks like.
    await kv.put(
      `cli-auth:device:${await sha256Hex(started.deviceToken)}`,
      JSON.stringify({
        userCode: started.userCode,
        deviceName: 'Ashish terminal',
        status: 'approved',
        origin: 'https://kinu.example.com',
        userId,
        userEmail: 'ashish@example.com',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        approvedAt: Date.now(),
      }),
      { expirationTtl: 600 },
    );
    const replayed = await pollCliAuth(env, started.deviceToken, '127.0.0.1');
    expect(replayed.status).toBe('expired');
    expect(replayed.message).toContain('already delivered');
    expect(replayed.token).toBeUndefined();
    expect(minted).toHaveLength(1);
    expect(claimed).toEqual([await sha256Hex(started.deviceToken)]);
  });

  test('the advertised polling cadence remains permitted for the full auth lifetime', async () => {
    const { env } = setupEnv();
    const started = await startCliAuth(env, 'https://kinu.example.com', 'https://kinu.example.com', 'Ashish terminal', '127.0.0.1');
    const remainingMs = Date.parse(started.expiresAt) - Date.now();
    const requiredPolls = Math.ceil(remainingMs / (started.intervalSeconds * 1_000));

    for (let attempt = 0; attempt < requiredPolls; attempt += 1) {
      const pending = await pollCliAuth(env, started.deviceToken, '127.0.0.1');
      expect(pending.status).toBe('pending');
    }
  });

  test('an unapproved request goes away on its own deadline, with nothing left behind', async () => {
    const { env, kv } = setupEnv();
    const started = await startCliAuth(env, 'https://o.example', 'https://o.example', 't', '127.0.0.1');
    expect(await inspectCliAuth(kv, started.userCode)).toMatchObject({ status: 'pending' });
    const deadline = Date.parse(started.expiresAt);

    try {
      // Past the deadline, still inside the retention window: readable, expired.
      setSystemTime(new Date(deadline + 1_000));
      expect(await inspectCliAuth(kv, started.userCode)).toMatchObject({ status: 'expired' });
      expect(await pollCliAuth(env, started.deviceToken, '127.0.0.1'))
        .toMatchObject({ status: 'expired', message: 'CLI auth request expired.' });

      // Past retention: the keys are gone, and no sweep ran to remove them.
      setSystemTime(new Date(deadline + 10 * 60 * 1000 + 1_000));
      expect(await inspectCliAuth(kv, started.userCode)).toBeNull();
      expect(kv.keys().filter((key) => key.startsWith('cli-auth:'))).toEqual([]);
    } finally {
      setSystemTime();
    }
  });
});

describe('CLI auth approval replay', () => {
  const approver = {
    userId: '0123456789abcdef0123456789abcdef',
    email: 'ashish@example.com',
    sub: 'sub',
    provider: 'test',
    authTime: Date.now(),
  };

  test('replay by the original approver stays idempotent', async () => {
    const { env } = setupEnv();
    const started = await startCliAuth(env, 'https://o.example', 'https://o.example', 't', '127.0.0.1');
    await approveCliAuth(env, started.userCode, approver, '127.0.0.1');

    const replay = await approveCliAuth(env, started.userCode, approver, '127.0.0.1');
    expect(replay).toMatchObject({ ok: true, status: 'approved', user: { id: approver.userId } });
  });

  test('an already-approved code is rejected for any other user (no identity disclosure)', async () => {
    const { env } = setupEnv();
    const started = await startCliAuth(env, 'https://o.example', 'https://o.example', 't', '127.0.0.1');
    await approveCliAuth(env, started.userCode, approver, '127.0.0.1');

    const stranger = { ...approver, userId: 'feedfacefeedfacefeedfacefeedface', email: 'mallory@example.com' };
    expect(approveCliAuth(env, started.userCode, stranger, '10.0.0.9'))
      .rejects.toThrow('CLI auth code already used.');
  });
});

describe('CLI auth error propagation', () => {
  test('startCliAuth surfaces real store failures instead of retrying as collisions', async () => {
    const env = testEnv({
      AUTH_KV: brokenKv(),
      UserDO: { idFromName: (n: string) => n, get: () => ({}) },
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    });
    expect(startCliAuth(env, 'https://o.example', 'https://o.example', 't', '127.0.0.1'))
      .rejects.toThrow(/namespace unavailable/i);
  });

  test('rate limiting throws the typed RateLimitError', async () => {
    const { env } = setupEnv();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await startCliAuth(env, 'https://o.example', 'https://o.example', 't', '127.0.0.1');
    }
    expect(startCliAuth(env, 'https://o.example', 'https://o.example', 't', '127.0.0.1'))
      .rejects.toBeInstanceOf(RateLimitError);
  });

  test('the ceiling is per client key, so one flooding terminal does not lock out another', async () => {
    const { env } = setupEnv();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await startCliAuth(env, 'https://o.example', 'https://o.example', 't', '127.0.0.1');
    }
    const other = await startCliAuth(env, 'https://o.example', 'https://o.example', 't', '10.0.0.9');
    expect(other.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });
});

describe('CLI auth route status mapping', () => {
  function startRequest() {
    return new Request('https://kinu.example.com/api/cli/auth/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '127.0.0.1' },
      body: JSON.stringify({ deviceName: 't' }),
    });
  }

  test('rate-limited start → 429', async () => {
    const { env } = setupEnv();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await startCliAuth(env, 'https://o.example', 'https://o.example', 't', '127.0.0.1');
    }
    const res = await handleCliRequest(startRequest(), env);
    expect(res?.status).toBe(429);
  });

  test('infra failure during start → 500, not 429', async () => {
    const env = testEnv({
      AUTH_KV: brokenKv(),
      UserDO: { idFromName: (n: string) => n, get: () => ({}) },
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    });
    const res = handled(await handleCliRequest(startRequest(), env));
    expect(res.status).toBe(500);
    expect(v.parse(ErrorResponseSchema, await res.json()).error).toMatch(/namespace unavailable/i);
  });
});

// ── The orphaned bearer ─────────────────────────────────────────────────────
//
// A CLI session token lives 180 days and the server keeps only its hash. So a
// logout whose remote revocation never landed — or a token copied off a machine
// that is gone — left a live bearer that NOTHING could name: the owner had no
// handle for it, and the only copy of the raw token was on the machine that
// could not reach the server. These routes are the recovery surface, driven
// against the real UserDO so the revocation, the generation rise and the socket
// push are the production ones.
describe('the CLI session inventory', () => {
  const USER_ID = '0123456789abcdef0123456789abcdef';

  async function account() {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    await harness.userDO.ensureProfile(owner, 'ashish@example.com', 'Ashish');
    await provisionTestWorkspace(harness, 'workspace-a');
    const laptop = await harness.userDO.mintCliToken(owner, USER_ID, 'a'.repeat(64), 'laptop');
    const lost = await harness.userDO.mintCliToken(owner, USER_ID, 'b'.repeat(64), 'the machine that is gone');
    const env = testEnv({
      AUTH_KV: makeKv(),
      UserDO: { idFromName: () => USER_ID, get: () => harness.userDO },
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    });
    return { harness, owner, env, laptop, lost };
  }

  function sessionsRequest(token: string, opts: { method?: string; hash?: string } = {}): Request {
    const path = opts.hash === undefined ? '/api/cli/sessions' : `/api/cli/sessions/${opts.hash}`;
    return new Request(`https://kinu.example.com${path}`, {
      method: opts.method ?? 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
  }

  test('another interactive session can name and end a bearer whose raw copy is gone', async () => {
    const { harness, owner, env, laptop, lost } = await account();
    // The raw token of the lost machine's session is deliberately not used
    // again below: the recovery has to work from the INVENTORY, because the
    // raw copy is exactly what no longer exists.
    const inventory = v.parse(
      v.object({ sessions: v.array(v.object({ tokenHash: v.string(), label: v.string() })) }),
      await handled(await handleCliRequest(sessionsRequest(laptop.token), env)).json(),
    );
    expect(inventory.sessions.map((row) => row.label).sort())
      .toEqual(['laptop', 'the machine that is gone']);
    const orphan = inventory.sessions.find((row) => row.label === 'the machine that is gone');
    expect(orphan?.tokenHash).toBe(lost.tokenHash);

    const revoked = await handleCliRequest(
      sessionsRequest(laptop.token, { method: 'DELETE', hash: orphan?.tokenHash ?? '' }), env,
    );

    expect(revoked?.status).toBe(200);
    // Dead by the store's own answer, on the hash alone.
    expect(await harness.userDO.verifyCliToken(owner, lost.token))
      .toMatchObject({ ok: false, error: 'invalid token' });
    // The revoking session is untouched — this is a revocation, not a reset.
    expect(await harness.userDO.verifyCliToken(owner, laptop.token)).toMatchObject({ ok: true });
    expect((await harness.userDO.listCliTokens(owner)).map((row) => row.label)).toEqual(['laptop']);
    // And the generation rose, so the sockets that bearer holds are closed
    // rather than left listening until it chooses to speak.
    expect(harness.revokedSocketPushes).toContain('workspace-a:1');
    harness.close();
  });

  test('revoke-all is the answer when no hash can name the orphan', async () => {
    const { harness, owner, env, laptop, lost } = await account();

    const response = await handleCliRequest(sessionsRequest(laptop.token, { method: 'DELETE' }), env);

    expect(v.parse(v.object({ ok: v.boolean(), revoked: v.number() }), await handled(response).json()))
      .toEqual({ ok: true, revoked: 2 });
    // Every bearer, including the caller's own: an account whose orphan cannot
    // be named is an account whose every remaining bearer needed to die. One
    // generation rise covers all of their sockets at once.
    expect(await harness.userDO.verifyCliToken(owner, laptop.token)).toMatchObject({ ok: false });
    expect(await harness.userDO.verifyCliToken(owner, lost.token)).toMatchObject({ ok: false });
    expect(await harness.userDO.listCliTokens(owner)).toEqual([]);
    expect(harness.revokedSocketPushes).toContain('workspace-a:1');
    harness.close();
  });

  test('a scoped CI token cannot enumerate or end the account\'s sessions', async () => {
    const { harness, owner, env, laptop } = await account();
    const ci = await harness.userDO.mintAccessToken(owner, USER_ID, 'ci', ['workspace.read', 'workspace.exec']);
    if (!ci.ok || !ci.token) throw new Error('the access token was not minted');

    for (const request of [
      sessionsRequest(ci.token),
      sessionsRequest(ci.token, { method: 'DELETE' }),
      sessionsRequest(ci.token, { method: 'DELETE', hash: laptop.tokenHash }),
    ]) {
      const refused = await handleCliRequest(request, env);
      expect(refused?.status).toBe(403);
      expect(v.parse(ErrorResponseSchema, await handled(refused).json()).error)
        .toContain('interactive CLI session token');
    }
    // Nothing was revoked by the refusals.
    expect(await harness.userDO.verifyCliToken(owner, laptop.token)).toMatchObject({ ok: true });
    harness.close();
  });

  test('a hash that is not 64 hex is not a route at all', async () => {
    const { harness, env, laptop } = await account();
    const refused = await handleCliRequest(
      sessionsRequest(laptop.token, { method: 'DELETE', hash: 'not-a-hash' }), env,
    );
    expect(refused?.status).toBe(404);
    harness.close();
  });
});
