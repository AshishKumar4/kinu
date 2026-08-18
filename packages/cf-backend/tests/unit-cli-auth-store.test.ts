import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { describe, expect, test } from 'bun:test';
import {
  approveCliAuth,
  inspectCliAuth,
  pollCliAuth,
  startCliAuth,
} from '../src/cli/auth-store';
import { createAuthDatabase, makeD1 } from './helpers/d1';
import { Database } from 'bun:sqlite';
import { RateLimitError } from '../src/cli/auth-store';
import { handleCliRequest } from '../src/cli/routes';
import type { UserCaller } from '../src/user/workspace-capability';
import * as v from 'valibot';

const ErrorResponseSchema = v.object({ error: v.string() });

interface TestNamespace<Stub> {
  idFromName(name: string): string;
  get(): Stub;
}

interface CliAuthTestBindings<Stub> {
  AUTH_DB: D1Database;
  UserDO: TestNamespace<Stub>;
  CREDENTIAL_ENCRYPTION_KEY: string;
}

function testEnv<Stub>(bindings: CliAuthTestBindings<Stub>): Env {
  const env: Partial<Env> = {};
  Object.assign(env, bindings);
  // SAFETY: CLI auth reads exactly the constructed D1 database, UserDO
  // namespace, and credential key; every reachable binding is present.
  return env as Env;
}

function handled(response: Response | null): Response {
  if (!response) throw new Error('CLI auth route did not handle the request');
  return response;
}

function setupEnv() {
  const db = createAuthDatabase();
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
    db,
    minted,
    env: testEnv({
      AUTH_DB: makeD1(db),
      UserDO: {
        idFromName(name: string) { return name; },
        get() { return userDO; },
      }, CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY }),
  };
}

describe('D1-backed CLI auth store', () => {
  test('approves and consumes a CLI auth request exactly once', async () => {
    const { env, minted } = setupEnv();
    const userId = '0123456789abcdef0123456789abcdef';

    const started = await startCliAuth(env, 'https://proteus.example.com', 'https://proteus.example.com', 'Ashish terminal', '127.0.0.1');
    expect(started.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(started.verificationUrl).toContain(`/cli/auth?code=${encodeURIComponent(started.userCode)}`);

    const pending = await inspectCliAuth(env.AUTH_DB, started.userCode);
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
  test('startCliAuth surfaces real DB failures instead of retrying as collisions', async () => {
    const broken = new Database(':memory:'); // no tables at all
    const env = testEnv({
      AUTH_DB: makeD1(broken),
      UserDO: { idFromName: (n: string) => n, get: () => ({}) },
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    });
    expect(startCliAuth(env, 'https://o.example', 'https://o.example', 't', '127.0.0.1'))
      .rejects.toThrow(/no such table/i);
  });

  test('rate limiting throws the typed RateLimitError', async () => {
    const { env, db } = setupEnv();
    db.exec(`INSERT INTO cli_auth_rate (key, count, reset_at) VALUES ('start:127.0.0.1', 20, ${Date.now() + 600_000})`);
    expect(startCliAuth(env, 'https://o.example', 'https://o.example', 't', '127.0.0.1'))
      .rejects.toBeInstanceOf(RateLimitError);
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
    const { env, db } = setupEnv();
    db.exec(`INSERT INTO cli_auth_rate (key, count, reset_at) VALUES ('start:127.0.0.1', 20, ${Date.now() + 600_000})`);
    const res = await handleCliRequest(startRequest(), env);
    expect(res?.status).toBe(429);
  });

  test('infra failure during start → 500, not 429', async () => {
    const env = testEnv({
      AUTH_DB: makeD1(new Database(':memory:')),
      UserDO: { idFromName: (n: string) => n, get: () => ({}) },
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    });
    const res = handled(await handleCliRequest(startRequest(), env));
    expect(res.status).toBe(500);
    expect(v.parse(ErrorResponseSchema, await res.json()).error).toMatch(/no such table/i);
  });
});
