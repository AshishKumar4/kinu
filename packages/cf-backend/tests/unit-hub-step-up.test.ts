// Step-up gate on the web trigger-creation route (events/routes.ts) —
// the same isFreshAuthTime rule the CLI webhook route enforces.
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { describe, test, expect } from 'bun:test';
import { STEP_UP_WINDOW_MS, isFreshAuthTime } from '../src/auth/session';
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
      return { trigger_id: 'trg_1', url: '/api/workspaces/jarvis/webhook/trg_1', auth_mode: 'hmac', secret: null };
    },
  };
  const bindings = {
    OrchestratorAgent: {
      idFromName(name: string) { return name; },
      get() { return agent; },
    },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  };
  const partialEnv: Partial<Env> = {};
  Object.assign(partialEnv, bindings);
  // SAFETY: the hub route only reaches the locally constructed orchestrator
  // namespace and credential secret in this suite.
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
    const res = await handleHubRequest(createTriggerRequest(Date.now() - STEP_UP_WINDOW_MS - 1000), env, 'jarvis');
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
    expect(isFreshAuthTime(now - STEP_UP_WINDOW_MS, now)).toBe(true);
    expect(isFreshAuthTime(now - STEP_UP_WINDOW_MS - 1, now)).toBe(false);
    expect(isFreshAuthTime(null, now)).toBe(false);
    expect(isFreshAuthTime(undefined, now)).toBe(false);
    expect(isFreshAuthTime(0, now)).toBe(false);
  });
});
