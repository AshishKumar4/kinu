import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { serveFamily } from './helpers/api';
import { describe, expect, test } from 'bun:test';
import {
  CapabilityDeniedError,
  summarizeDeviceAction,
  type JsonValue,
} from '@kinu.run/core';
import { userRoutes, type UserRoutesEnv } from '../src/user/routes';
import { unreachableNamespace, userAccount, workerContext } from './helpers/bindings';
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
      method: 'statPath',
      param: '/tmp/a; echo PWNED',
      command: 'statPath(/tmp/a; echo PWNED)',
    },
  ] as const;

  for (const { name, method, param, command } of summaries) {
    test(name, () => {
      expect(summarizeDeviceAction(method, [param])).toEqual({ method, command });
    });
  }

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
    grantDeviceConsent: account.grantDeviceConsent.bind(account),
  });

  const env: UserRoutesEnv<string> = {
    UserDO: { idFromName: (name) => name, get: () => stub },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    OrchestratorAgent: unreachableNamespace('OrchestratorAgent'),
  };

  const call = (path: string, method: string, body?: JsonValue): Promise<Response | null> =>
    serveFamily(userRoutes, { identity: IDENTITY, ctx: workerContext() })(new Request(`https://kinu.example.com/api/user${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);

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
    await harness.deviceCall(harness.workspace, 'statPath', ['/home/me/a.md'], { agentName: WORKSPACE });

    const rows = await consents();

    expect(rows).toEqual([expect.objectContaining({ agentName: WORKSPACE, deviceId: harness.deviceId, policy: 'allow' })]);
    await harness.closeDeviceHarness();
  });

  // The owner, on production f9c17ac7b (2026-10-14), could give a workspace a connected machine only by answering an
  // agent's approval box. The Env tab's one click records the same binding, decided by the owner.
  test("the owner gives a workspace a machine, and the machine's next call there asks nothing", async () => {
    const { harness, call, consents } = await deviceRoutesSetup();

    const given = await call(`/devices/${harness.deviceId}/consent?agentName=${WORKSPACE}`, 'POST');

    expect(requiredResponse(given).status).toBe(200);
    expect(await consents()).toEqual([expect.objectContaining({ agentName: WORKSPACE, deviceId: harness.deviceId, policy: 'allow' })]);
    // No card can answer: a call that asked would be refused, so one that runs was not asked.
    harness.consentDecision = 'deny';
    await harness.userDO.deviceRpc(harness.workspace, 'statPath', ['/home/me/a.md'], { agentName: WORKSPACE });
    await harness.closeDeviceHarness();
  });

  test('a workspace cannot give itself a machine, and nothing is given for a machine or workspace the account lacks', async () => {
    const { harness, call, consents } = await deviceRoutesSetup();

    await expect(harness.userDO.grantDeviceConsent(harness.workspace, WORKSPACE, harness.deviceId)).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(requiredResponse(await call(`/devices/dev-nope/consent?agentName=${WORKSPACE}`, 'POST')).status).toBe(404);
    expect(requiredResponse(await call(`/devices/${harness.deviceId}/consent?agentName=not-a-workspace`, 'POST')).status).toBe(404);
    expect(await consents()).toEqual([]);
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
