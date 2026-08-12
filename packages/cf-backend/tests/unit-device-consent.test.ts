import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do.js';
import { describe, expect, test } from 'bun:test';
import {
  DEVICE_CONSENT_SCOPE, DEVICE_CONSENT_SCOPE_FULL_FS,
  DEVICE_CONSENT_DENIED, DEVICE_CONSENT_UNANSWERED,
  mergeConsentScope, parseConsentScope, summarizeDeviceAction,
} from '@proteus/core';
import { handleUserRequest } from '../src/user/routes.js';
import type { AuthIdentity } from '../src/auth/session.js';

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

  test('remembered consent scope is the broad local action grant', () => {
    expect(DEVICE_CONSENT_SCOPE).toBe('all_local_actions');
  });

  test('an unanswered prompt does not read as a refusal', () => {
    // Both are failures, but they mean opposite things to an agent running
    // unattended: a refusal is policy and should stop it asking, while an
    // expired prompt only means nobody was at the keyboard. They used to be
    // the same sentence, so an AFK moment became a permanent capability loss.
    expect(DEVICE_CONSENT_UNANSWERED).not.toBe(DEVICE_CONSENT_DENIED);
    expect(DEVICE_CONSENT_UNANSWERED).toContain('NOT a refusal');
    expect(DEVICE_CONSENT_UNANSWERED).toContain('ask again later');
    expect(DEVICE_CONSENT_DENIED).toContain('declined');
    expect(DEVICE_CONSENT_DENIED).not.toContain('later');
  });
});

describe('consent tiers (the /pc mount scope)', () => {
  test('the full-filesystem tier is a distinct, never-default scope', () => {
    expect(DEVICE_CONSENT_SCOPE_FULL_FS).toBe('full_filesystem');
    expect(parseConsentScope(undefined)).toBe(DEVICE_CONSENT_SCOPE);
    expect(parseConsentScope(null)).toBe(DEVICE_CONSENT_SCOPE);
    expect(parseConsentScope('garbage')).toBe(DEVICE_CONSENT_SCOPE);
    expect(parseConsentScope('full_filesystem')).toBe(DEVICE_CONSENT_SCOPE_FULL_FS);
  });

  test('remembering a base action grant never downgrades full_filesystem', () => {
    expect(mergeConsentScope('full_filesystem', DEVICE_CONSENT_SCOPE)).toBe(DEVICE_CONSENT_SCOPE_FULL_FS);
    expect(mergeConsentScope('all_local_actions', DEVICE_CONSENT_SCOPE)).toBe(DEVICE_CONSENT_SCOPE);
    expect(mergeConsentScope(null, DEVICE_CONSENT_SCOPE_FULL_FS)).toBe(DEVICE_CONSENT_SCOPE_FULL_FS);
    expect(mergeConsentScope('garbage', DEVICE_CONSENT_SCOPE)).toBe(DEVICE_CONSENT_SCOPE);
  });
});

// ── The grant path: /api/user/devices/consents + …/:id/consent ─────────────
// setDeviceConsentScope previously had ZERO callers — the full_filesystem
// tier existed and was enforced by the /pc mount but could never be granted.

const IDENTITY: AuthIdentity = {
  userId: '0123456789abcdef0123456789abcdef',
  email: 'me@example.com',
  sub: 'sub',
  provider: 'test',
  authTime: Date.now(),
};

function consentRoutesSetup() {
  // In-memory (agent, device) → scope, mirroring the UserDO consent table's
  // grant/reduce contract so the flip is observable through the same routes.
  const scopes = new Map<string, string>();
  const calls: Array<{ agentName: string; deviceId: string; scope: string }> = [];
  const stub = {
    async ensureProfile() {},
    async listDeviceConsents(_caller: unknown) {
      return [...scopes.entries()].map(([key, scope]) => {
        const [agentName, deviceId] = key.split('|');
        return { agentName, deviceId, policy: 'allow', scope, lastMethod: null, lastSummary: null };
      });
    },
    async setDeviceConsentScope(_caller: unknown, agentName: string, deviceId: string, scope: string) {
      calls.push({ agentName, deviceId, scope });
      if (scope !== DEVICE_CONSENT_SCOPE && scope !== DEVICE_CONSENT_SCOPE_FULL_FS) return { ok: false };
      scopes.set(`${agentName}|${deviceId}`, scope);
      return { ok: true };
    },
  };
  const env = { UserDO: { idFromName: (n: string) => n, get: () => stub }, CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY } as unknown as Env;
  const call = (path: string, method: string, body?: unknown) =>
    handleUserRequest(new Request(`https://proteus.example.com/api/user${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env, IDENTITY);
  return { call, calls, scopes };
}

describe('device consent-tier routes (the full_filesystem grant path)', () => {
  test('PUT grants the full-filesystem tier and the flip is visible in the consent listing', async () => {
    const { call, calls } = consentRoutesSetup();

    const put = await call('/devices/dev-1/consent', 'PUT', { agentName: 'jarvis', scope: 'full_filesystem' });
    expect(put?.status).toBe(200);
    expect(calls).toEqual([{ agentName: 'jarvis', deviceId: 'dev-1', scope: 'full_filesystem' }]);

    const list = await call('/devices/consents', 'GET');
    expect(list?.status).toBe(200);
    expect(await list?.json<unknown[]>()).toEqual([
      expect.objectContaining({ agentName: 'jarvis', deviceId: 'dev-1', scope: 'full_filesystem' }),
    ]);
  });

  test('PUT reduces back to the base tier (explicit choice overrides no-downgrade)', async () => {
    const { call, scopes } = consentRoutesSetup();
    await call('/devices/dev-1/consent', 'PUT', { agentName: 'jarvis', scope: 'full_filesystem' });
    const reduce = await call('/devices/dev-1/consent', 'PUT', { agentName: 'jarvis', scope: 'all_local_actions' });
    expect(reduce?.status).toBe(200);
    expect(scopes.get('jarvis|dev-1')).toBe('all_local_actions');
  });

  test('an out-of-vocabulary scope or missing agent is refused before the DO call', async () => {
    const { call, calls } = consentRoutesSetup();
    const bad = await call('/devices/dev-1/consent', 'PUT', { agentName: 'jarvis', scope: 'root_of_everything' });
    expect(bad?.status).toBe(400);
    const missing = await call('/devices/dev-1/consent', 'PUT', { scope: 'full_filesystem' });
    expect(missing?.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
