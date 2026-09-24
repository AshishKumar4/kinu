import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { describe, expect, test } from 'bun:test';
import {
  DEVICE_CONSENT_DENIED, DEVICE_CONSENT_UNANSWERED, DEVICE_CONNECT_DISCLOSURE,
  summarizeDeviceAction,
  type JsonValue,
} from '@kinu.run/core';
import { handleUserRequest, type UserRoutesEnv } from '../src/user/routes';
import { unreachableNamespace, userAccount } from './helpers/bindings';
import { WORKSPACE, deviceHarness } from './helpers/device-harness';
import type { AuthIdentity } from '../src/auth/session';
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
// Driven over a real UserDO, so what a route did is what Settings -> Devices reads back.

const IDENTITY: AuthIdentity = {
  userId: '0123456789abcdef0123456789abcdef',
  email: 'me@example.com',
  sub: 'sub',
  provider: 'test',
  authTime: Date.now(),
};

const DeviceRowsSchema = v.array(v.looseObject({ id: v.string(), sandbox: v.looseObject({ tier: v.string() }) }));

const ConsentRowsSchema = v.array(v.looseObject({ agentName: v.string(), deviceId: v.string(), policy: v.string() }));

async function deviceRoutesSetup() {
  const harness = await deviceHarness();
  const account = harness.userDO;

  const stub = userAccount({
    ensureProfile: account.ensureProfile.bind(account),
    listDevices: account.listDevices.bind(account),
    setDeviceTier: account.setDeviceTier.bind(account),
    listDeviceConsents: account.listDeviceConsents.bind(account),
  });

  const env: UserRoutesEnv<string> = {
    UserDO: { idFromName: (name) => name, get: () => stub },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    OrchestratorAgent: unreachableNamespace('OrchestratorAgent'),
  };

  const call = (path: string, method: string, body?: JsonValue): Promise<Response | null> =>
    handleUserRequest(new Request(`https://kinu.example.com/api/user${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env, IDENTITY);

  /** The device's Sandbox switch, as the Devices page reads it. */
  const tier = async (): Promise<string | undefined> => {
    const rows = v.parse(DeviceRowsSchema, await requiredResponse(await call('/devices', 'GET')).json());

    return rows.find((row) => row.id === harness.deviceId)?.sandbox.tier;
  };

  const consents = async () => v.parse(ConsentRowsSchema, await requiredResponse(await call('/devices/consents', 'GET')).json());

  return { harness, call, tier, consents };
}

function requiredResponse(response: Response | null): Response {
  if (!response) throw new Error('expected user route to return a response');

  return response;
}

describe('the device Sandbox route', () => {
  test('PUT turns the sandbox off and on, and the Devices page reads it back', async () => {
    const { harness, call, tier } = await deviceRoutesSetup();

    const off = await call(`/devices/${harness.deviceId}/sandbox`, 'PUT', { tier: 'raw' });
    expect(requiredResponse(off).status).toBe(200);
    expect(await tier()).toBe('raw');

    const on = await call(`/devices/${harness.deviceId}/sandbox`, 'PUT', { tier: 'sandboxed' });
    expect(requiredResponse(on).status).toBe(200);
    expect(await tier()).toBe('sandboxed');
    await harness.closeDeviceHarness();
  });

  test('a tier outside the vocabulary is refused and the device keeps its switch', async () => {
    const { harness, call, tier } = await deviceRoutesSetup();
    const before = await tier();

    // `files_only` is what a machine reports, never what an owner selects.
    for (const bad of ['files_only', 'root_of_everything', '']) {
      const refused = await call(`/devices/${harness.deviceId}/sandbox`, 'PUT', { tier: bad });
      expect(requiredResponse(refused).status).toBe(400);
    }

    const missing = await call(`/devices/${harness.deviceId}/sandbox`, 'PUT', {});
    expect(requiredResponse(missing).status).toBe(400);
    expect(await tier()).toBe(before);
    await harness.closeDeviceHarness();
  });

  test('an unknown device answers 404 rather than reporting success', async () => {
    const { harness, call, tier } = await deviceRoutesSetup();
    const before = await tier();

    const gone = await call('/devices/dev-nope/sandbox', 'PUT', { tier: 'raw' });
    expect(requiredResponse(gone).status).toBe(404);
    expect(await tier()).toBe(before);
    await harness.closeDeviceHarness();
  });

  test('a binding listing carries no tier of its own', async () => {
    const { harness, consents } = await deviceRoutesSetup();
    harness.consentDecision = 'always';
    await harness.userDO.deviceRpc(harness.workspace, 'readFile', ['/home/me/a.md'], { agentName: WORKSPACE });

    const rows = await consents();

    expect(rows).toEqual([expect.objectContaining({ agentName: WORKSPACE, deviceId: harness.deviceId, policy: 'allow' })]);
    expect(Object.keys(rows[0] ?? {})).not.toContain('scope');
    await harness.closeDeviceHarness();
  });

  test('the consent-tier PUT is gone, not merely unused', async () => {
    const { harness, call, consents } = await deviceRoutesSetup();

    const answer = await call(`/devices/${harness.deviceId}/consent`, 'PUT', { agentName: WORKSPACE, scope: 'full_filesystem' });

    expect(answer === null || answer.status === 404).toBe(true);
    expect(await consents()).toEqual([]);
    await harness.closeDeviceHarness();
  });
});
