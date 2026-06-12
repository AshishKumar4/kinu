// Step-up gate on the web trigger-creation route (events/routes.ts) —
// the same isFreshAuthTime rule the CLI webhook route enforces.
import { describe, test, expect, mock } from 'bun:test';
import { STEP_UP_WINDOW_MS, isFreshAuthTime } from '../src/auth/session.js';

// The real `agents` package imports cloudflare:email, which bun test can't
// resolve — stub the one function events/routes.ts uses at this seam.
mock.module('agents', () => ({
  getAgentByName: async (ns: DurableObjectNamespace, name: string) => ns.get(ns.idFromName(name)),
}));
const { handleHubRequest } = await import('../src/events/routes.js');

function hubEnv() {
  const calls: string[] = [];
  const agent = {
    // getAgentByName (partyserver getServerByName) calls setName first.
    async setName() {},
    async createDurableWebhook(opts: unknown) {
      calls.push(`webhook:${JSON.stringify(opts)}`);
      return { trigger_id: 'trg_1', url: '/api/agents/jarvis/webhook/trg_1', auth_mode: 'hmac', secret: null };
    },
  };
  const env = {
    OrchestratorAgent: {
      idFromName(name: string) { return name; },
      get() { return agent; },
    },
  } as unknown as Env;
  return { env, calls };
}

function createTriggerRequest(authTime: number | null) {
  return new Request('https://proteus.example.com/api/agents/jarvis/triggers', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authTime !== null ? { 'x-proteus-auth-time': String(authTime) } : {}),
    },
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
