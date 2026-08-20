import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
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
  const userDO = {
    async ensureProfile() {},
    async mintCliToken(_caller: UserCaller, userId: string, label?: string) {
      const token = `ptc_${userId}_testtoken`;
      minted.push(`${label ?? ''}:${token}`);
      return { token, tokenHash: 'hash', expiresAt: Date.now() + 60_000 };
    },
  };
  return {
    kv,
    minted,
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
    const { env, kv, minted } = setupEnv();
    const userId = '0123456789abcdef0123456789abcdef';

    const started = await startCliAuth(env, 'https://proteus.example.com', 'https://proteus.example.com', 'Ashish terminal', '127.0.0.1');
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
  });

  test('the advertised polling cadence remains permitted for the full auth lifetime', async () => {
    const { env } = setupEnv();
    const started = await startCliAuth(env, 'https://proteus.example.com', 'https://proteus.example.com', 'Ashish terminal', '127.0.0.1');
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
    return new Request('https://proteus.example.com/api/cli/auth/start', {
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
