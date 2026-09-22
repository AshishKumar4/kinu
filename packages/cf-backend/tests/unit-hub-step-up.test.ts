// Step-up gate on web trigger creation (events/routes.ts): the CLI webhook route's isFreshAuthTime rule.
import type { HubEnv, HubTarget } from '../src/events/routes';
import { describe, test, expect } from 'bun:test';
import { isFreshAuthTime } from '../src/auth/session';
import { mockAgentsSdk } from './helpers/agents-sdk';

mockAgentsSdk();

const { handleHubRequest } = await import('../src/events/routes');

/** Any call reaching the workspace object fails: the gate is proven only if nothing else answered. */
function unreached(member: string) {
  return (): never => { throw new Error(`OrchestratorAgent.${member}: not reachable in this test`); };
}

function hubWorkspace() {
  const calls: string[] = [];

  const agent: HubTarget = {
    listTriggers: unreached('listTriggers'),
    cancelTrigger: unreached('cancelTrigger'),
    listRecentEvents: unreached('listRecentEvents'),
    getEmailIngress: unreached('getEmailIngress'),
    setEmailAllowlist: unreached('setEmailAllowlist'),
    setEmailNotifications: unreached('setEmailNotifications'),
    async createDurableWebhook(opts) {
      calls.push(`webhook:${JSON.stringify(opts)}`);

      return {
        trigger_id: '01HZY6QK9N4T7M2P8V3XABCDEF',
        url: '/api/workspaces/jarvis/webhook/01HZY6QK9N4T7M2P8V3XABCDEF/v1-'
          + 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        auth_mode: 'hmac',
        secret: null,
      };
    },
  };

  const env: HubEnv = {
    // Unsignable delivery URLs are refused downstream; the step-up gate is upstream (unit-webhook-route.test.ts).
    WEBHOOK_ROUTE_SECRET: 'test-webhook-route-secret-0123456789',
  };

  return { env, calls, resolveAgent: () => Promise.resolve(agent) };
}

function createTriggerRequest(authTime: number | null) {
  const headers = new Headers({ 'content-type': 'application/json' });

  if (authTime !== null) headers.set('x-kinu-auth-time', String(authTime));

  return new Request('https://kinu.example.com/api/workspaces/jarvis/triggers', {
    method: 'POST',
    headers,
    body: JSON.stringify({ label: 'github', auth_mode: 'hmac' }),
  });
}

describe('web trigger-creation step-up gate', () => {
  test('fresh auth time → trigger created', async () => {
    const { env, calls, resolveAgent } = hubWorkspace();
    const res = await handleHubRequest(createTriggerRequest(Date.now() - 1000), env, 'jarvis', resolveAgent);
    expect(res?.status).toBe(201);
    expect(calls).toHaveLength(1);
  });

  test('stale auth time → 401, orchestrator never invoked', async () => {
    const { env, calls, resolveAgent } = hubWorkspace();

    const res = await handleHubRequest(
      createTriggerRequest(Date.now() - 5 * 60 * 1000 - 1000), env, 'jarvis', resolveAgent,
    );

    expect(res?.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  test('missing auth time → 401', async () => {
    const { env, calls, resolveAgent } = hubWorkspace();
    const res = await handleHubRequest(createTriggerRequest(null), env, 'jarvis', resolveAgent);
    expect(res?.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe('isFreshAuthTime', () => {
  test('boundary behavior', () => {
    const now = Date.now();
    expect(isFreshAuthTime(now, now)).toBe(true);
    expect(isFreshAuthTime(now - 5 * 60 * 1000, now)).toBe(true);
    expect(isFreshAuthTime(now - 5 * 60 * 1000 - 1, now)).toBe(false);
    expect(isFreshAuthTime(null, now)).toBe(false);
    expect(isFreshAuthTime(undefined, now)).toBe(false);
    expect(isFreshAuthTime(0, now)).toBe(false);
  });
});
