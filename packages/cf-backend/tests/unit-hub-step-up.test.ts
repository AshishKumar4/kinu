// Step-up gate on the web trigger-creation route (events/routes.ts) —
// the same isFreshAuthTime rule the CLI webhook route enforces.
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { describe, test, expect } from 'bun:test';
import { isFreshAuthTime } from '../src/auth/session';
import { mockAgentsSdk } from './helpers/agents-sdk';

mockAgentsSdk();
const { handleHubRequest } = await import('../src/events/routes');

interface WebhookOptions {
  readonly label: string;
  readonly auth_mode: 'hmac' | 'bearer' | 'mtls';
  readonly secret?: string;
  readonly accepted_content_type?: string;
  readonly rate_limit_per_min?: number;
}

function hubEnv() {
  const calls: string[] = [];
  const agent = {
    // getAgentByName (partyserver getServerByName) calls setName first.
    async setName() {},
    async createDurableWebhook(opts: WebhookOptions) {
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
  const bindings = {
    OrchestratorAgent: {
      idFromName(name: string) { return name; },
      get() { return agent; },
    },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    // Creation refuses without it, because a webhook whose delivery URL cannot
    // be signed is a row nobody can deliver to. The step-up gate this suite is
    // about is upstream of that refusal — see unit-webhook-route.test.ts.
    WEBHOOK_ROUTE_SECRET: 'test-webhook-route-secret-0123456789',
  };
  const partialEnv: Partial<Env> = {};
  Object.assign(partialEnv, bindings);
  // SAFETY: every member the hub route reads is constructed by the assign above
  // — the orchestrator namespace, the credential secret and the route secret.
  const env = partialEnv as Env;
  return { env, calls };
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
    const { env, calls } = hubEnv();
    const res = await handleHubRequest(createTriggerRequest(Date.now() - 1000), env, 'jarvis');
    expect(res?.status).toBe(201);
    expect(calls).toHaveLength(1);
  });

  test('stale auth time → 401, orchestrator never invoked', async () => {
    const { env, calls } = hubEnv();
    const res = await handleHubRequest(createTriggerRequest(Date.now() - 5 * 60 * 1000 - 1000), env, 'jarvis');
    expect(res?.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  test('missing auth time → 401', async () => {
    const { env, calls } = hubEnv();
    const res = await handleHubRequest(createTriggerRequest(null), env, 'jarvis');
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
