import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { describe, expect, test } from 'bun:test';
import {
  DEVICE_CONSENT_DENIED, DEVICE_CONSENT_UNANSWERED, DEVICE_CONNECT_DISCLOSURE,
  summarizeDeviceAction,
  type JsonValue,
} from '@kinu.run/core';
import { handleUserRequest } from '../src/user/routes';
import type { AuthIdentity } from '../src/auth/session';
import type { UserCaller } from '../src/user/workspace-capability';
import * as v from 'valibot';

describe('device consent prompt data', () => {
  test('exec consent shows the exact shell command', () => {
    expect(summarizeDeviceAction('exec', ['echo hi; touch /tmp/x'])).toEqual({
      method: 'exec',
      command: 'echo hi; touch /tmp/x',
    });
  });

  test('helper consent shows the method and path as a local action', () => {
    expect(summarizeDeviceAction('readFile', ['/tmp/a; echo PWNED'])).toEqual({
      method: 'readFile',
      command: 'readFile(/tmp/a; echo PWNED)',
    });
  });

  test('an unanswered prompt does not read as a refusal', () => {
    // Both are failures, but they mean opposite things to an agent running
    // unattended: a refusal is policy and should stop it asking, while an
    // expired prompt only means nobody was at the keyboard. They used to be
    // the same sentence, so an AFK moment became a permanent capability loss.
    expect(DEVICE_CONSENT_UNANSWERED).not.toBe(DEVICE_CONSENT_DENIED);
    expect(DEVICE_CONSENT_UNANSWERED).toContain('nobody decided');
    expect(DEVICE_CONSENT_UNANSWERED).toContain('ask again later');
    expect(DEVICE_CONSENT_DENIED).toContain('declined');
    expect(DEVICE_CONSENT_DENIED).not.toContain('later');
  });

  test('the connect disclosure states the sandbox and where the switch is', () => {
    // The disclosure is what a person reads BEFORE the daemon is installed, so
    // it has to describe what actually happens now: a sandbox by default, and
    // one switch that turns it off. It said "run commands, read and write
    // files here, as you" — true only with the sandbox off.
    const text = DEVICE_CONNECT_DISCLOSURE.join(' ');
    expect(text).toContain('sandbox');
    expect(text).toContain('Sandbox switch');
    expect(text).toContain('each workspace');
    expect(text).toContain('no inbound ports');
  });
});

// ── The Sandbox switch: PUT /api/user/devices/:id/sandbox ──────────────────
// The tier the owner sets is the only tier there is. The consent-scope PUT
// this replaces granted a `full_filesystem` tier per workspace; there is no
// per-workspace tier now, so the route is gone with the vocabulary.

const IDENTITY: AuthIdentity = {
  userId: '0123456789abcdef0123456789abcdef',
  email: 'me@example.com',
  sub: 'sub',
  provider: 'test',
  authTime: Date.now(),
};

function deviceRoutesSetup() {
  // In-memory device → tier, mirroring the UserDO contract so the flip is
  // observable through the same routes a browser uses.
  const tiers = new Map<string, string>();
  const calls: Array<{ deviceId: string; tier: string }> = [];
  const stub = {
    async ensureProfile() {},
    async listDeviceConsents(_caller: UserCaller) {
      return [{ agentName: 'jarvis', deviceId: 'dev-1', policy: 'allow', lastMethod: null, lastSummary: null }];
    },
    async setDeviceTier(_caller: UserCaller, deviceId: string, tier: string) {
      calls.push({ deviceId, tier });
      if (deviceId !== 'dev-1') return { ok: false };
      tiers.set(deviceId, tier);
      return { ok: true };
    },
  };
  const partialEnv: Partial<Env> = {};
  Object.assign(partialEnv, {
    UserDO: { idFromName: (name: string) => name, get: () => stub },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  });
  // SAFETY: The constructed environment provides exactly UserDO.idFromName,
  // UserDO.get, and CREDENTIAL_ENCRYPTION_KEY, all constructed immediately
  // above; no other Env binding is reachable on these request paths.
  const env = partialEnv as Env;
  const call = (path: string, method: string, body?: JsonValue) =>
    handleUserRequest(new Request(`https://kinu.example.com/api/user${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env, IDENTITY);
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
    // `files_only` is what a machine REPORTS, never what an owner selects. A
    // route that accepted it would let the UI offer a third state that means
    // "run nothing", which no owner would choose on purpose.
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
    // One tier, on the device. A per-workspace tier beside it is what made two
    // answers to "what may this reach" possible in the first place.
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
    const legacy = await call('/devices/dev-1/consent', 'PUT', { agentName: 'jarvis', scope: 'full_filesystem' });
    // No route matches, so the user router falls through to its own 404 or
    // answers nothing at all. Either way, nothing reached the UserDO.
    expect(legacy === null || legacy === undefined || legacy.status === 404).toBe(true);
    expect(calls).toEqual([]);
  });
});
