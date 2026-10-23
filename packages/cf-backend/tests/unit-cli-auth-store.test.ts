import {
  TEST_CREDENTIAL_ENCRYPTION_KEY, createTestUserDO, provisionTestWorkspace, testOwner,
} from './helpers/user-do';
import { serveFamily } from './helpers/api';
import { describe, expect, setSystemTime, test } from 'bun:test';
import {
  approveCliAuth,
  inspectCliAuth,
  pollCliAuth,
  startCliAuth,
} from '../src/cli/auth-store';
import { makeKv } from './helpers/kv';
import { cliAuthObjects, type CliAuthObjects } from './helpers/cli-auth';
import { RateLimitError, type CliAuthObject } from '../src/cli/auth-store';
import { cliRoutes, type CliRoutesAuthority, type CliRoutesEnv } from '../src/cli/routes';
import {
  bootstrappedProfile, cliAccount, unreachableAssets, unreachableNamespace,
} from './helpers/bindings';
import type { ObjectNamespace } from '@kinu.run/core';
import type { KvStore } from '@kinu.run/agent-utils';
import type { UserCaller } from '@kinu.run/core';
import { sha256Hex } from '@kinu.run/core';
import * as v from 'valibot';

const cli = serveFamily(cliRoutes);

const ErrorResponseSchema = v.object({ error: v.string() });

/** Device-code sign-in reaches neither the published assets nor a workspace object. */
function testEnv(
  AUTH_KV: KvStore, UserDO: ObjectNamespace<string, CliRoutesAuthority>, CliAuthDO: CliAuthObjects = cliAuthObjects(),
): CliRoutesEnv<string> {
  return {
    AUTH_KV,
    CliAuthDO,
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

/** `resetAccount`: the platform resets the account's object once at each of its calls, before the call runs or after. */
function setupEnv(options: { resetAccount?: 'before' | 'after' } = {}) {
  const kv = makeKv();
  const objects = cliAuthObjects();
  const minted: string[] = [];
  const claimed: string[] = [];
  const once = resettingOnce(options.resetAccount ?? 'before');
  const account = <T>(operation: string, run: () => Promise<T>): Promise<T> => (options.resetAccount === undefined ? run() : once(operation, run));

  const userDO = cliAccount({
    async ensureProfile(_caller: UserCaller, email: string) { return await account('ensureProfile', async () => bootstrappedProfile(email)); },
    async mintCliToken(_caller: UserCaller, userId: string, authorizationHash: string, label?: string) {
      return await account('mintCliToken', async () => {
        // Refuses like the real UserDO's unique index (unit-user-authority-races.test.ts), so this
        // exercises the flow's half: the poll names the approval and maps the DO's refusal.
        if (claimed.includes(authorizationHash)) {
          throw new Error('That CLI authorization has already been redeemed.');
        }

        claimed.push(authorizationHash);
        const token = `ptc_${userId}_testtoken`;
        minted.push(`${label ?? ''}:${token}`);

        return { token, tokenHash: 'hash', expiresAt: Date.now() + 60_000 };
      });
    },
  });

  return {
    objects,
    minted,
    claimed,
    env: testEnv(kv, { idFromName: (name) => name, get: () => userDO }, objects),
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

/** The runtime's words when storage resets an object under a call (platform-catalog.ts), with the flag it sets. */
function storageReset(): Error {
  return Object.assign(new Error('Internal error in Durable Object storage caused object to be reset; reference = test'), { retryable: true });
}

/** A call failed once per key by a storage reset: `before` it runs, as a reset that loses the call, or `after`, as one
 *  that loses only its answer. */
function resettingOnce(when: 'before' | 'after') {
  const reset = new Set<string>();

  return async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    if (reset.has(key)) return await run();
    reset.add(key);

    if (when === 'after') await run();

    throw storageReset();
  };
}

const EVERY_CALL = new Set(['claimCode', 'deviceOf', 'open', 'read', 'approve', 'collect']);

/** `objects` as the platform answers when it resets each object once at each call `calls` names. A stub that carried a
 *  reset is broken, as the platform's is, so a repeat reaches the object only through a fresh one. */
function resetObjects(
  objects: ObjectNamespace<string, CliAuthObject>, when: 'before' | 'after', calls: ReadonlySet<string>,
): ObjectNamespace<string, CliAuthObject> {
  const once = resettingOnce(when);

  return {
    idFromName: (name) => objects.idFromName(name),
    get: (name) => {
      const object = objects.get(name);
      let broken = false;

      const at = async <T>(call: string, run: () => Promise<T>): Promise<T> => {
        if (broken) throw new Error('a stub that carried a reset was used again');

        try {
          return await (calls.has(call) ? once(`${name} ${call}`, run) : run());
        } catch (failed) {
          broken = true;
          throw failed;
        }
      };

      return {
        claimCode: (deviceHash, until) => at('claimCode', () => object.claimCode(deviceHash, until)),
        deviceOf: () => at('deviceOf', () => object.deviceOf()),
        open: (record, until) => at('open', () => object.open(record, until)),
        read: () => at('read', () => object.read()),
        approve: (userId, email, now) => at('approve', () => object.approve(userId, email, now)),
        collect: (now) => at('collect', () => object.collect(now)),
      };
    },
  };
}

const APPROVER = { userId: '0123456789abcdef0123456789abcdef', email: 'ashish@example.com', sub: 'sub', provider: 'test', authTime: Date.now() };

describe('CLI auth store', () => {
  test('approves and consumes a CLI auth request exactly once', async () => {
    const { env, objects, minted, claimed } = setupEnv();
    const userId = '0123456789abcdef0123456789abcdef';

    const started = await startAuth(env, 'https://kinu.example.com', 'Ashish terminal');
    expect(started.verificationUrl).toContain(`/cli/auth?code=${encodeURIComponent(started.userCode)}`);

    const pending = await inspectCliAuth(env, started.userCode);
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
    expect(minted).toHaveLength(1);

    // One approval is one token whatever the request's object answers: the UserDO refuses the second redemption.
    // The record is rewound to `approved`, which no step of the flow writes twice.
    await objects.get(`device:${await sha256Hex(started.deviceToken)}`).open({
      userCode: started.userCode,
      deviceName: 'Ashish terminal',
      status: 'approved',
      origin: 'https://kinu.example.com',
      userId,
      userEmail: 'ashish@example.com',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      approvedAt: Date.now(),
    }, Date.now() + 600_000);
    const replayed = await pollCliAuth(env, started.deviceToken, '127.0.0.1');
    expect(replayed.status).toBe('expired');
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
    const { env, objects } = setupEnv();
    const started = await startAuth(env, 'https://o.example', 't');
    expect(await inspectCliAuth(env, started.userCode)).toMatchObject({ status: 'pending' });
    const deadline = Date.parse(started.expiresAt);
    const retained = deadline + 10 * 60 * 1000;

    try {
      setSystemTime(new Date(deadline + 1_000));
      expect(await inspectCliAuth(env, started.userCode)).toMatchObject({ status: 'expired' });
      expect(await pollCliAuth(env, started.deviceToken, '127.0.0.1'))
        .toMatchObject({ status: 'expired' });

      // At the end of retention each of its objects deletes itself on its own alarm, with no sweep.
      setSystemTime(new Date(retained + 1_000));
      expect([...objects.held.keys()].map((name) => name.split(':')[0]).sort()).toEqual(['code', 'device']);

      for (const { object, ctx } of objects.held.values()) {
        expect(await ctx.storage.getAlarm()).toBe(retained);
        await object.alarm();
        expect([...(await ctx.storage.list({ prefix: '' })).keys()]).toEqual([]);
      }

      expect(await inspectCliAuth(env, started.userCode)).toBeNull();
      expect(await pollCliAuth(env, started.deviceToken, '127.0.0.1'))
        .toMatchObject({ status: 'expired', message: 'Unknown CLI auth request.' });
    } finally {
      setSystemTime();
    }
  });

  test('a code typed loosely finds its sign-in, and text no start could draw reaches no object', async () => {
    const { env, objects } = setupEnv();
    const started = await startAuth(env, 'https://o.example', 't');
    const approver = { userId: '0123456789abcdef0123456789abcdef', email: 'ashish@example.com', sub: 'sub', provider: 'test', authTime: Date.now() };

    expect(await inspectCliAuth(env, ` ${started.userCode.replace('-', '').toLowerCase()} `)).toMatchObject({ status: 'pending' });
    const reached = [...objects.held.keys()];

    expect(await inspectCliAuth(env, 'x'.repeat(4096))).toBeNull();
    await expect(approveCliAuth(env, 'ABCD-EFGH-JKLM', approver, '127.0.0.1'))
      .rejects.toMatchObject({ code: 'bad_input', message: expect.stringContaining('Unknown CLI auth code.') });
    expect([...objects.held.keys()]).toEqual(reached);
  });
});

// Staging 2026-10-23: a start among 30 at once answered 500 on "Internal error in Durable Object storage caused object
// to be reset". The platform flags such a failure retryable, and each call of a sign-in is repeated on a fresh stub.
describe('a CLI sign-in the platform resets under', () => {
  test('signs in though every call of it, its objects\' and the account\'s, is reset once before it runs', async () => {
    const { env, minted } = setupEnv({ resetAccount: 'before' });
    const resetting = { ...env, CliAuthDO: resetObjects(env.CliAuthDO, 'before', EVERY_CALL) };

    const started = await startAuth(resetting, 'https://kinu.example.com', 'terminal');
    expect(await inspectCliAuth(resetting, started.userCode)).toMatchObject({ status: 'pending', deviceName: 'terminal' });
    await approveCliAuth(resetting, started.userCode, APPROVER, '127.0.0.1');

    expect(await pollCliAuth(resetting, started.deviceToken, '127.0.0.1')).toMatchObject({ status: 'approved', token: `ptc_${APPROVER.userId}_testtoken` });
    expect(minted).toHaveLength(1);
  });

  test('keeps one code, one approval and one token when the platform loses only the answers of the calls that keep them', async () => {
    const { env, objects, minted, claimed } = setupEnv();
    const resetting = { ...env, CliAuthDO: resetObjects(objects, 'after', new Set(['claimCode', 'open', 'approve'])) };

    const started = await startAuth(resetting, 'https://kinu.example.com', 'terminal');
    const device = await sha256Hex(started.deviceToken);

    // The repeated claim was this sign-in's own: one code was drawn, and it names this start's device.
    expect([...objects.held.keys()].filter((name) => name.startsWith('code:'))).toEqual([`code:${started.userCode}`]);
    expect(await objects.get(`code:${started.userCode}`).deviceOf()).toBe(device);
    await approveCliAuth(resetting, started.userCode, APPROVER, '127.0.0.1');

    expect(await pollCliAuth(resetting, started.deviceToken, '127.0.0.1')).toMatchObject({ status: 'approved', token: `ptc_${APPROVER.userId}_testtoken` });
    expect(await pollCliAuth(resetting, started.deviceToken, '127.0.0.1')).toMatchObject({ status: 'expired', message: expect.stringContaining('already delivered') });
    expect(minted).toHaveLength(1);
    expect(claimed).toEqual([device]);
  });

  test('mints no second token when the platform loses the answers of its claim, its approval and its mint', async () => {
    const { env, objects, minted, claimed } = setupEnv({ resetAccount: 'after' });
    const resetting = { ...env, CliAuthDO: resetObjects(objects, 'after', new Set(['claimCode', 'open', 'approve'])) };

    const started = await startAuth(resetting, 'https://kinu.example.com', 'terminal');
    await approveCliAuth(resetting, started.userCode, APPROVER, '127.0.0.1');
    const polls = [await pollCliAuth(resetting, started.deviceToken, '127.0.0.1'), await pollCliAuth(resetting, started.deviceToken, '127.0.0.1')];

    // The mint was kept before its answer was lost: its repeat is refused as redeemed, so no second token exists.
    expect(minted).toHaveLength(1);
    expect(claimed).toEqual([await sha256Hex(started.deviceToken)]);
    expect(polls.filter((poll) => poll.token !== undefined)).toHaveLength(0);
    expect(polls.map((poll) => poll.status)).toEqual(['expired', 'expired']);
  });

  test('never hands one approval out twice: a delivery whose answer is lost is told as delivered, not failed', async () => {
    const { env, minted } = setupEnv();
    const resetting = { ...env, CliAuthDO: resetObjects(env.CliAuthDO, 'after', new Set(['collect'])) };

    const started = await startAuth(resetting, 'https://kinu.example.com', 'terminal');
    await approveCliAuth(resetting, started.userCode, APPROVER, '127.0.0.1');

    expect(await pollCliAuth(resetting, started.deviceToken, '127.0.0.1')).toMatchObject({ status: 'expired', message: expect.stringContaining('already delivered') });
    expect(minted).toHaveLength(0);
  });
});

describe('minting a CLI bearer is the owner capability\'s alone', () => {
  const USER_ID = '0123456789abcdef0123456789abcdef';

  test('the device flow mints through the real account object, and a workspace holding its own capability cannot', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const env = testEnv(makeKv(), { idFromName: () => USER_ID, get: () => harness.userDO });
    const workspace: UserCaller = { workspaceToken: await provisionTestWorkspace(harness, 'workspace-a') };

    const started = await startAuth(env, 'https://kinu.example.com', 'terminal');
    await approveCliAuth(env, started.userCode, { userId: USER_ID, email: 'ashish@example.com', sub: 'sub', provider: 'test', authTime: Date.now() }, '127.0.0.1');
    const approved = await pollCliAuth(env, started.deviceToken, '127.0.0.1');

    expect(approved.status).toBe('approved');
    expect(approved.token).toMatch(new RegExp(`^ptc_${USER_ID}_`));
    // A CLI bearer is the whole account's: a workspace that could mint one would hold every sibling.
    await expect(harness.userDO.mintCliToken(workspace, USER_ID, 'c'.repeat(64), 'escalation')).rejects.toThrow('account authority');
    harness.close();
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
    expect(replay).toMatchObject({ status: 'approved', user: { id: approver.userId } });
  });

  test('an already-approved code is rejected for any other user (no identity disclosure)', async () => {
    const { env } = setupEnv();
    const started = await startAuth(env, 'https://o.example', 't');
    await approveCliAuth(env, started.userCode, approver, '127.0.0.1');

    const stranger = { ...approver, userId: 'feedfacefeedfacefeedfacefeedface', email: 'mallory@example.com' };
    await expect(approveCliAuth(env, started.userCode, stranger, '10.0.0.9'))
      .rejects.toMatchObject({ code: 'bad_input' });
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
    expect(await inspectCliAuth(env, other.userCode)).toMatchObject({ status: 'pending', deviceName: 't' });
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

    const res = await cli(startRequest(), env);
    expect(res?.status).toBe(429);
  });

  test('infra failure during start → 500, not 429', async () => {
    const env = testEnv(brokenKv(), unreachableNamespace('UserDO'));

    const res = handled(await cli(startRequest(), env));
    expect(res.status).toBe(500);
    expect(v.parse(ErrorResponseSchema, await res.json()).error).not.toMatch(/namespace unavailable/i);
  });

  test('an object the platform resets past every retry → 503, try again, not 500', async () => {
    const reset = async (): Promise<never> => { throw storageReset(); };

    const resetting: CliAuthObject = { claimCode: reset, deviceOf: reset, open: reset, read: reset, approve: reset, collect: reset };
    const env = testEnv(makeKv(), unreachableNamespace('UserDO'), { held: new Map(), idFromName: (name) => name, get: () => resetting });

    const res = handled(await cli(startRequest(), env));
    expect(res.status).toBe(503);
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
      await handled(await cli(sessionsRequest(device.token), env)).json(),
    );

    expect(inventory.sessions.map((row) => row.label).sort())
      .toEqual(['device', 'the machine that is gone']);
    const orphan = inventory.sessions.find((row) => row.label === 'the machine that is gone');
    expect(orphan?.tokenHash).toBe(lost.tokenHash);

    const revoked = await cli(sessionsRequest(device.token, { method: 'DELETE', hash: orphan?.tokenHash ?? '' }), env);

    expect(revoked?.status).toBe(200);
    expect(await harness.userDO.verifyCliToken(owner, lost.token))
      .toMatchObject({ ok: false });
    expect(await harness.userDO.verifyCliToken(owner, device.token)).toMatchObject({ ok: true });
    expect((await harness.userDO.listCliTokens(owner)).map((row) => row.label)).toEqual(['device']);
    // The generation rose, so that bearer's sockets are closed.
    expect(harness.revokedSocketPushes).toContain('workspace-a:1');
    harness.close();
  });

  test('revoke-all is the answer when no hash can name the orphan', async () => {
    const { harness, owner, env, device, lost } = await account();

    const response = await cli(sessionsRequest(device.token, { method: 'DELETE' }), env);

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
      const refused = await cli(request, env);
      expect(refused?.status).toBe(403);
    }

    expect(await harness.userDO.verifyCliToken(owner, device.token)).toMatchObject({ ok: true });
    harness.close();
  });

  test('a hash that is not 64 hex is not a route at all', async () => {
    const { harness, env, device } = await account();

    const refused = await cli(sessionsRequest(device.token, { method: 'DELETE', hash: 'not-a-hash' }), env);

    expect(refused?.status).toBe(404);
    harness.close();
  });
});
