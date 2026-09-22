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
import { handleCliRequest, type CliRoutesAuthority, type CliRoutesEnv } from '../src/cli/routes';
import {
  bootstrappedProfile, cliAccount, unreachableAssets, unreachableNamespace,
} from './helpers/bindings';
import type { ObjectNamespace } from '@kinu.run/core';
import type { KvStore } from '@kinu.run/agent-utils';
import type { UserCaller } from '@kinu.run/core';
import { sha256Hex } from '@kinu.run/core';
import * as v from 'valibot';

const ErrorResponseSchema = v.object({ error: v.string() });

/** Device-code sign-in reaches neither the published assets nor a workspace object. */
function testEnv(AUTH_KV: KvStore, UserDO: ObjectNamespace<string, CliRoutesAuthority>): CliRoutesEnv<string> {
  return {
    AUTH_KV,
    UserDO,
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    ASSETS: unreachableAssets(),
    OrchestratorAgent: unreachableNamespace('OrchestratorAgent'),
  };
}

function handled(response: Response | null): Response {
  if (!response) throw new Error('CLI auth route did not handle the request');

  return response;
}

function setupEnv() {
  const kv = makeKv();
  const minted: string[] = [];
  const claimed: string[] = [];

  const userDO = cliAccount({
    async ensureProfile(_caller: UserCaller, email: string) { return bootstrappedProfile(email); },
    async mintCliToken(_caller: UserCaller, userId: string, authorizationHash: string, label?: string) {
      // Refuses like the real UserDO's unique index (unit-user-authority-races.test.ts), so this
      // exercises the flow's half: the poll names the approval and maps the DO's refusal.
      if (claimed.includes(authorizationHash)) {
        throw new Error('That CLI authorization has already been redeemed.');
      }

      claimed.push(authorizationHash);
      const token = `ptc_${userId}_testtoken`;
      minted.push(`${label ?? ''}:${token}`);

      return { token, tokenHash: 'hash', expiresAt: Date.now() + 60_000 };
    },
  });

  return {
    kv,
    minted,
    claimed,
    env: testEnv(kv, { idFromName: (name) => name, get: () => userDO }),
  };
}

function startAuth(env: CliRoutesEnv<string>, origin: string, deviceName: string, clientKey = '127.0.0.1') {
  return startCliAuth(env, { origin, approvalOrigin: origin, deviceName, clientKey });
}

/** A store outage must reach the response as an outage, not be read as a code collision. */
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

    const started = await startAuth(env, 'https://kinu.example.com', 'Ashish terminal');
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

    // KV cannot hold one approval to one token (no compare-and-swap, colo-cached reads): the Durable
    // Object refuses the second redemption. The record is rewound to `approved`, as a stale colo read looks.
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
    const started = await startAuth(env, 'https://kinu.example.com', 'Ashish terminal');
    const remainingMs = Date.parse(started.expiresAt) - Date.now();
    const requiredPolls = Math.ceil(remainingMs / (started.intervalSeconds * 1_000));

    for (let attempt = 0; attempt < requiredPolls; attempt += 1) {
      const pending = await pollCliAuth(env, started.deviceToken, '127.0.0.1');
      expect(pending.status).toBe('pending');
    }
  });

  test('an unapproved request goes away on its own deadline, with nothing left behind', async () => {
    const { env, kv } = setupEnv();
    const started = await startAuth(env, 'https://o.example', 't');
    expect(await inspectCliAuth(kv, started.userCode)).toMatchObject({ status: 'pending' });
    const deadline = Date.parse(started.expiresAt);

    try {
      setSystemTime(new Date(deadline + 1_000));
      expect(await inspectCliAuth(kv, started.userCode)).toMatchObject({ status: 'expired' });
      expect(await pollCliAuth(env, started.deviceToken, '127.0.0.1'))
        .toMatchObject({ status: 'expired', message: 'CLI auth request expired.' });

      // Past retention the keys are gone with no sweep.
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
    const started = await startAuth(env, 'https://o.example', 't');
    await approveCliAuth(env, started.userCode, approver, '127.0.0.1');

    const replay = await approveCliAuth(env, started.userCode, approver, '127.0.0.1');
    expect(replay).toMatchObject({ ok: true, status: 'approved', user: { id: approver.userId } });
  });

  test('an already-approved code is rejected for any other user (no identity disclosure)', async () => {
    const { env } = setupEnv();
    const started = await startAuth(env, 'https://o.example', 't');
    await approveCliAuth(env, started.userCode, approver, '127.0.0.1');

    const stranger = { ...approver, userId: 'feedfacefeedfacefeedfacefeedface', email: 'mallory@example.com' };
    await expect(approveCliAuth(env, started.userCode, stranger, '10.0.0.9'))
      .rejects.toThrow('CLI auth code already used.');
  });
});

describe('CLI auth error propagation', () => {
  test('startCliAuth surfaces real store failures instead of retrying as collisions', async () => {
    const env = testEnv(brokenKv(), unreachableNamespace('UserDO'));

    await expect(startAuth(env, 'https://o.example', 't'))
      .rejects.toThrow(/namespace unavailable/i);
  });

  test('rate limiting throws the typed RateLimitError', async () => {
    const { env } = setupEnv();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await startAuth(env, 'https://o.example', 't');
    }

    await expect(startAuth(env, 'https://o.example', 't'))
      .rejects.toBeInstanceOf(RateLimitError);
  });

  test('the ceiling is per client key, so one flooding terminal does not lock out another', async () => {
    const { env } = setupEnv();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await startAuth(env, 'https://o.example', 't');
    }

    const other = await startAuth(env, 'https://o.example', 't', '10.0.0.9');
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
      await startAuth(env, 'https://o.example', 't');
    }

    const res = await handleCliRequest(startRequest(), env);
    expect(res?.status).toBe(429);
  });

  test('infra failure during start → 500, not 429', async () => {
    const env = testEnv(brokenKv(), unreachableNamespace('UserDO'));

    const res = handled(await handleCliRequest(startRequest(), env));
    expect(res.status).toBe(500);
    expect(v.parse(ErrorResponseSchema, await res.json()).error).toMatch(/namespace unavailable/i);
  });
});

// Recovery for a bearer nothing could name (server keeps only its hash), against the real UserDO.
describe('the CLI session inventory', () => {
  const USER_ID = '0123456789abcdef0123456789abcdef';

  async function account() {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    await harness.userDO.ensureProfile(owner, 'ashish@example.com', 'Ashish');
    await provisionTestWorkspace(harness, 'workspace-a');
    const device = await harness.userDO.mintCliToken(owner, USER_ID, 'a'.repeat(64), 'device');
    const lost = await harness.userDO.mintCliToken(owner, USER_ID, 'b'.repeat(64), 'the machine that is gone');

    const env = testEnv(makeKv(), { idFromName: () => USER_ID, get: () => harness.userDO });

    return { harness, owner, env, device, lost };
  }

  function sessionsRequest(token: string, opts: { method?: string; hash?: string } = {}): Request {
    const path = opts.hash === undefined ? '/api/cli/sessions' : `/api/cli/sessions/${opts.hash}`;

    return new Request(`https://kinu.example.com${path}`, {
      method: opts.method ?? 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
  }

  test('another interactive session can name and end a bearer whose raw copy is gone', async () => {
    const { harness, owner, env, device, lost } = await account();

    // Recovery works from the inventory: the lost machine's raw token is what no longer exists.
    const inventory = v.parse(
      v.object({ sessions: v.array(v.object({ tokenHash: v.string(), label: v.string() })) }),
      await handled(await handleCliRequest(sessionsRequest(device.token), env)).json(),
    );

    expect(inventory.sessions.map((row) => row.label).sort())
      .toEqual(['device', 'the machine that is gone']);
    const orphan = inventory.sessions.find((row) => row.label === 'the machine that is gone');
    expect(orphan?.tokenHash).toBe(lost.tokenHash);

    const revoked = await handleCliRequest(
      sessionsRequest(device.token, { method: 'DELETE', hash: orphan?.tokenHash ?? '' }), env,
    );

    expect(revoked?.status).toBe(200);
    expect(await harness.userDO.verifyCliToken(owner, lost.token))
      .toMatchObject({ ok: false, error: 'invalid token' });
    expect(await harness.userDO.verifyCliToken(owner, device.token)).toMatchObject({ ok: true });
    expect((await harness.userDO.listCliTokens(owner)).map((row) => row.label)).toEqual(['device']);
    // The generation rose, so that bearer's sockets are closed.
    expect(harness.revokedSocketPushes).toContain('workspace-a:1');
    harness.close();
  });

  test('revoke-all is the answer when no hash can name the orphan', async () => {
    const { harness, owner, env, device, lost } = await account();

    const response = await handleCliRequest(sessionsRequest(device.token, { method: 'DELETE' }), env);

    expect(v.parse(v.object({ ok: v.boolean(), revoked: v.number() }), await handled(response).json()))
      .toEqual({ ok: true, revoked: 2 });
    // Every bearer including the caller's; one generation rise covers all their sockets.
    expect(await harness.userDO.verifyCliToken(owner, device.token)).toMatchObject({ ok: false });
    expect(await harness.userDO.verifyCliToken(owner, lost.token)).toMatchObject({ ok: false });
    expect(await harness.userDO.listCliTokens(owner)).toEqual([]);
    expect(harness.revokedSocketPushes).toContain('workspace-a:1');
    harness.close();
  });

  test('a scoped CI token cannot enumerate or end the account\'s sessions', async () => {
    const { harness, owner, env, device } = await account();
    const ci = await harness.userDO.mintAccessToken(owner, USER_ID, 'ci', ['workspace.read', 'workspace.exec']);

    if (!ci.ok || !ci.token) throw new Error('the access token was not minted');

    for (const request of [
      sessionsRequest(ci.token),
      sessionsRequest(ci.token, { method: 'DELETE' }),
      sessionsRequest(ci.token, { method: 'DELETE', hash: device.tokenHash }),
    ]) {
      const refused = await handleCliRequest(request, env);
      expect(refused?.status).toBe(403);
      expect(v.parse(ErrorResponseSchema, await handled(refused).json()).error)
        .toContain('interactive CLI session token');
    }

    expect(await harness.userDO.verifyCliToken(owner, device.token)).toMatchObject({ ok: true });
    harness.close();
  });

  test('a hash that is not 64 hex is not a route at all', async () => {
    const { harness, env, device } = await account();

    const refused = await handleCliRequest(
      sessionsRequest(device.token, { method: 'DELETE', hash: 'not-a-hash' }), env,
    );

    expect(refused?.status).toBe(404);
    harness.close();
  });
});
