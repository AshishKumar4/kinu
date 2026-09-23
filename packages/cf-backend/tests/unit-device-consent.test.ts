import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { serveFamily } from './helpers/api';
import { describe, expect, test } from 'bun:test';
import {
  DEVICE_CONSENT_DENIED, DEVICE_CONSENT_UNANSWERED, DEVICE_CONNECT_DISCLOSURE,
  summarizeDeviceAction,
  type JsonValue,
} from '@kinu.run/core';
import { userRoutes, type UserRoutesEnv } from '../src/user/routes';
import { bootstrappedProfile, unreachableNamespace, userAccount, workerContext } from './helpers/bindings';
import type { AuthIdentity } from '../src/auth/session';
import type { DeviceTier, UserCaller } from '@kinu.run/core';
import * as v from 'valibot';

describe('device consent prompt data', () => {
  const summaries = [
    {
      name: 'exec consent shows the exact shell command',
      method: 'exec',
      param: 'echo hi; touch /tmp/x',
      command: 'echo hi; touch /tmp/x',
    },
    {
      name: 'helper consent shows the method and path as a local action',
      method: 'readFile',
      param: '/tmp/a; echo PWNED',
      command: 'readFile(/tmp/a; echo PWNED)',
    },
  ] as const;

  for (const { name, method, param, command } of summaries) {
    test(name, () => {
      expect(summarizeDeviceAction(method, [param])).toEqual({ method, command });
    });
  }

  test('an unanswered prompt does not read as a refusal', () => {
    // A refusal is policy and should stop an unattended agent asking; an expired prompt only means nobody was
    // at the keyboard. One sentence for both turns an AFK moment into a permanent capability loss.
    expect(DEVICE_CONSENT_UNANSWERED).not.toBe(DEVICE_CONSENT_DENIED);
    expect(DEVICE_CONSENT_UNANSWERED).toContain('nobody decided');
    expect(DEVICE_CONSENT_UNANSWERED).toContain('ask again later');
    expect(DEVICE_CONSENT_DENIED).toContain('declined');
    expect(DEVICE_CONSENT_DENIED).not.toContain('later');
  });

  test('the connect disclosure is three lines: daemon, sandbox, revoke', () => {
    // What a person reads before the daemon is installed: an extra line must not arrive unnoticed.
    expect(DEVICE_CONNECT_DISCLOSURE).toEqual([
      'Kinu installs a small daemon here and links this machine to your account.',
      'A workspace you approve runs in a sandbox: its own home plus folders you pick. Everything else stays invisible to it.',
      'The daemon only dials out. Revoke it any time under Account settings → Devices.',
    ]);
  });
});

// PUT /api/user/devices/:id/sandbox: the owner-set tier is the only tier; there is no per-workspace tier.

const IDENTITY: AuthIdentity = {
  userId: '0123456789abcdef0123456789abcdef',
  email: 'me@example.com',
  sub: 'sub',
  provider: 'test',
  authTime: Date.now(),
};

function deviceRoutesSetup() {
  // Mirrors the UserDO contract so the flip is observable through the browser's routes.
  const tiers = new Map<string, string>();
  const calls: Array<{ deviceId: string; tier: string }> = [];

  const stub = userAccount({
    async ensureProfile(_caller: UserCaller, email: string) { return bootstrappedProfile(email); },
    async listDeviceConsents(_caller: UserCaller) {
      return [{ agentName: 'jarvis', deviceId: 'dev-1', policy: 'allow', lastMethod: null, lastSummary: null }];
    },
    async setDeviceTier(_caller: UserCaller, deviceId: string, tier: DeviceTier) {
      calls.push({ deviceId, tier });

      if (deviceId !== 'dev-1') return { ok: false as const };
      tiers.set(deviceId, tier);

      return { ok: true as const };
    },
  });

  const env: UserRoutesEnv<string> = {
    UserDO: { idFromName: (name) => name, get: () => stub },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    OrchestratorAgent: unreachableNamespace('OrchestratorAgent'),
  };

  const call = (path: string, method: string, body?: JsonValue) =>
    serveFamily(userRoutes, { identity: IDENTITY, ctx: workerContext() })(new Request(`https://kinu.example.com/api/user${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);

  return { call, calls, tiers };
}

function requiredResponse(response: Response | null | undefined): Response {
  if (!response) throw new Error('expected user route to return a response');

  return response;
}

describe('the device Sandbox route', () => {
  test('PUT turns the sandbox off and the tier reaches the UserDO', async () => {
    const { call, calls, tiers } = deviceRoutesSetup();

    const off = await call('/devices/dev-1/sandbox', 'PUT', { tier: 'raw' });
    expect(requiredResponse(off).status).toBe(200);
    expect(calls).toEqual([{ deviceId: 'dev-1', tier: 'raw' }]);
    expect(tiers.get('dev-1')).toBe('raw');

    const on = await call('/devices/dev-1/sandbox', 'PUT', { tier: 'sandboxed' });
    expect(requiredResponse(on).status).toBe(200);
    expect(tiers.get('dev-1')).toBe('sandboxed');
  });

  test('a tier outside the vocabulary is refused before the DO call', async () => {
    const { call, calls } = deviceRoutesSetup();

    // `files_only` is what a machine reports, never what an owner selects.
    for (const tier of ['files_only', 'root_of_everything', '']) {
      const bad = await call('/devices/dev-1/sandbox', 'PUT', { tier });
      expect(requiredResponse(bad).status).toBe(400);
    }

    const missing = await call('/devices/dev-1/sandbox', 'PUT', {});
    expect(requiredResponse(missing).status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('an unknown device answers 404 rather than reporting success', async () => {
    const { call } = deviceRoutesSetup();
    const gone = await call('/devices/dev-nope/sandbox', 'PUT', { tier: 'raw' });
    expect(requiredResponse(gone).status).toBe(404);
  });

  test('a binding listing carries no tier of its own', async () => {
    const { call } = deviceRoutesSetup();
    const list = await call('/devices/consents', 'GET');
    expect(requiredResponse(list).status).toBe(200);

    const rows = v.parse(
      v.array(v.looseObject({ agentName: v.string(), deviceId: v.string() })),
      await requiredResponse(list).json(),
    );

    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {})).not.toContain('scope');
  });

  test('the consent-tier PUT is gone, not merely unused', async () => {
    const { call, calls } = deviceRoutesSetup();
    const answer = await call('/devices/dev-1/consent', 'PUT', { agentName: 'jarvis', scope: 'full_filesystem' });
    // Either way, nothing reached the UserDO.
    expect(answer === null || answer === undefined || answer.status === 404).toBe(true);
    expect(calls).toEqual([]);
  });
});
