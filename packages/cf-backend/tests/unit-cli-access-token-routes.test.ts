// Route-level behavior for scoped `pta_…` CI access tokens: exec/read scopes
// gate exactly the surfaces they name, everything sensitive stays
// interactive-session-only, and minting is step-up gated.
import { describe, expect, test } from 'bun:test';
import { handleCliRequest } from '../src/cli/routes.js';

const USER_ID = '0123456789abcdef0123456789abcdef';
const SESSION_TOKEN = `ptc_${USER_ID}_abcdefghijklmnopqrstuvwxyz`;
const EXEC_TOKEN = `pta_${USER_ID}_${'e'.repeat(44)}`;
const READ_TOKEN = `pta_${USER_ID}_${'r'.repeat(44)}`;
const BOTH_TOKEN = `pta_${USER_ID}_${'b'.repeat(44)}`;

const ACCESS_TOKENS: Record<string, { hash: string; scopes: string[] }> = {
  [EXEC_TOKEN]: { hash: 'exec-hash', scopes: ['agent.exec'] },
  [READ_TOKEN]: { hash: 'read-hash', scopes: ['agent.read'] },
  [BOTH_TOKEN]: { hash: 'both-hash', scopes: ['agent.read', 'agent.exec'] },
};

function setupEnv(opts: { sessionMintedAt?: number } = {}) {
  const calls: string[] = [];
  const userDO = {
    async verifyCliToken(token: string) {
      return {
        ok: token === SESSION_TOKEN,
        tokenHash: 'session-hash',
        user: { id: USER_ID, email: 'ashish@example.com', displayName: 'Ashish' },
      };
    },
    async verifyAccessToken(token: string) {
      const entry = ACCESS_TOKENS[token];
      if (!entry) return { ok: false, error: 'invalid token' };
      return {
        ok: true,
        tokenHash: entry.hash,
        scopes: entry.scopes,
        user: { id: USER_ID, email: 'ashish@example.com', displayName: 'Ashish' },
      };
    },
    async listCliTokens() {
      return [{
        tokenHash: 'session-hash',
        label: 'terminal',
        createdAt: opts.sessionMintedAt ?? Date.now(),
        expiresAt: Date.now() + 60_000,
        lastUsedAt: null,
      }];
    },
    async mintAccessToken(userId: string, name: string, scopes: string[]) {
      calls.push(`tokens:mint:${userId}:${name}:${scopes.join('+')}`);
      if (name === 'dup') return { ok: false as const, error: 'An active access token named "dup" already exists.' };
      return {
        ok: true as const,
        token: `pta_${userId}_${'n'.repeat(44)}`,
        record: { tokenHash: 'new-hash', name, scopes, createdAt: 123, lastUsedAt: null },
      };
    },
    async listAccessTokens() {
      calls.push('tokens:list');
      return [{ tokenHash: 'exec-hash', name: 'ci', scopes: ['agent.exec'], createdAt: 1, lastUsedAt: 2 }];
    },
    async revokeAccessToken(ref: string) {
      calls.push(`tokens:revoke:${ref}`);
      return { ok: true as const, revoked: ref === 'ci' };
    },
    async hasAgent(name: string) {
      return name === 'jarvis';
    },
    async issueCliAgentConnectTicket(input: { cliTokenHash: string }) {
      calls.push(`connect-ticket:${input.cliTokenHash}`);
      return { ok: true, ticket: `pat_${USER_ID}_ticket`, expiresAt: 1234 };
    },
    async listDevices() {
      calls.push('devices:list');
      return [];
    },
    async registerDevice() {
      calls.push('devices:register');
      return { deviceId: 'dev_1', token: 'raw-device-token' };
    },
  };
  const agent = {
    async claimOwner(userId: string) {
      return { owner: userId };
    },
    async getAgentStatus() {
      calls.push('status');
      return { name: 'jarvis', purpose: 'help' };
    },
    async cancelCurrentWork() {
      calls.push('work:cancel');
      return { ok: true };
    },
    async executeInExecutor(id: string, command: string) {
      calls.push(`executors:exec:${id}:${command}`);
      return { stdout: 'ok', exitCode: 0 };
    },
    async setModel(spec: string) {
      calls.push(`model:set:${spec}`);
      return { ok: true, spec };
    },
    async resolveDeviceConsent(id: string, decision: string) {
      calls.push(`consents:resolve:${id}:${decision}`);
      return { ok: true };
    },
    async createTimerTrigger() {
      calls.push('triggers:timer');
      return { id: 'trg_1', kind: 'timer_oneshot', nextFireAt: 1 };
    },
    async createDurableWebhook() {
      calls.push('triggers:webhook');
      return { trigger_id: 'trg_webhook' };
    },
  };
  const env = {
    UserDO: { idFromName: (n: string) => n, get: () => userDO },
    OrchestratorAgent: { idFromName: (n: string) => n, get: () => agent },
  } as unknown as Env;
  return { env, calls };
}

function req(token: string, path: string, init: RequestInit = {}) {
  return new Request(`https://proteus.example.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

const jsonInit = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('access token scope enforcement', () => {
  test('agent.exec token can mint connect tickets, stop work, and run executors', async () => {
    const { env, calls } = setupEnv();
    const ticket = await handleCliRequest(req(EXEC_TOKEN, '/api/cli/agents/jarvis/connect-ticket', { method: 'POST' }), env);
    expect(ticket?.status).toBe(200);
    expect(calls).toContain('connect-ticket:exec-hash');

    const stop = await handleCliRequest(req(EXEC_TOKEN, '/api/cli/agents/jarvis/stop', { method: 'POST' }), env);
    expect(stop?.status).toBe(200);

    const exec = await handleCliRequest(
      req(EXEC_TOKEN, '/api/cli/agents/jarvis/executors/workspace/exec', jsonInit({ command: 'pwd' })),
      env,
    );
    expect(exec?.status).toBe(200);
  });

  test('agent.exec token cannot read agent state without agent.read', async () => {
    const { env, calls } = setupEnv();
    const res = await handleCliRequest(req(EXEC_TOKEN, '/api/cli/agents/jarvis/status'), env);
    expect(res?.status).toBe(403);
    expect((await res?.json() as { error: string }).error).toContain('agent.read');
    expect(calls).not.toContain('status');
  });

  test('agent.read token can read but cannot exec', async () => {
    const { env, calls } = setupEnv();
    const status = await handleCliRequest(req(READ_TOKEN, '/api/cli/agents/jarvis/status'), env);
    expect(status?.status).toBe(200);
    expect(await status?.json()).toMatchObject({ name: 'jarvis' });

    const ticket = await handleCliRequest(req(READ_TOKEN, '/api/cli/agents/jarvis/connect-ticket', { method: 'POST' }), env);
    expect(ticket?.status).toBe(403);
    expect((await ticket?.json() as { error: string }).error).toContain('agent.exec');
    expect(calls.some((c) => c.startsWith('connect-ticket:'))).toBe(false);
  });

  test('access tokens are denied every interactive-only surface, server-side', async () => {
    const { env, calls } = setupEnv({ sessionMintedAt: Date.now() });
    const forbidden: Array<[string, RequestInit]> = [
      ['/api/cli/agents/jarvis/triggers/webhook', jsonInit({ label: 'ci', auth_mode: 'hmac' })],
      ['/api/cli/agents/jarvis/triggers/timer', jsonInit({ atMs: Date.now() + 1000 })],
      ['/api/cli/devices', jsonInit({ label: 'pc' })],
      ['/api/cli/devices', { method: 'GET' }],
      ['/api/cli/agents', jsonInit({ name: 'new-agent' })],
      ['/api/cli/agents/jarvis/consents/cons-1', jsonInit({ decision: 'always' })],
      ['/api/cli/agents/jarvis/model', jsonInit({ spec: 'openai/gpt-5.1' }, 'PUT')],
      ['/api/cli/tokens', jsonInit({ name: 'more', scopes: ['agent.exec'] })],
      ['/api/cli/tokens', { method: 'GET' }],
      ['/api/cli/tokens/ci', { method: 'DELETE' }],
      ['/api/cli/logout', { method: 'POST' }],
    ];
    for (const [path, init] of forbidden) {
      const res = await handleCliRequest(req(BOTH_TOKEN, path, init), env);
      expect(`${path}:${res?.status}`).toBe(`${path}:403`);
      expect((await res?.json() as { error: string }).error).toContain('interactive CLI session token');
    }
    expect(calls.filter((c) => !c.startsWith('connect-ticket'))).toEqual([]);
  });

  test('/me works for any valid bearer and reports kind and scopes', async () => {
    const { env } = setupEnv();
    const me = await handleCliRequest(req(EXEC_TOKEN, '/api/cli/me'), env);
    expect(me?.status).toBe(200);
    expect(await me?.json()).toMatchObject({
      user: { id: USER_ID },
      token: { kind: 'access', scopes: ['agent.exec'] },
    });

    const sessionMe = await handleCliRequest(req(SESSION_TOKEN, '/api/cli/me'), env);
    expect(await sessionMe?.json()).toMatchObject({ token: { kind: 'session', scopes: 'all' } });
  });

  test('unknown access tokens are rejected with 401', async () => {
    const { env } = setupEnv();
    const res = await handleCliRequest(req(`pta_${USER_ID}_${'x'.repeat(44)}`, '/api/cli/me'), env);
    expect(res?.status).toBe(401);
  });
});

describe('access token management routes (session tokens only)', () => {
  test('minting requires a step-up-fresh session token', async () => {
    const fresh = setupEnv({ sessionMintedAt: Date.now() - 60_000 });
    const minted = await handleCliRequest(
      req(SESSION_TOKEN, '/api/cli/tokens', jsonInit({ name: 'ci', scopes: ['agent.exec', 'agent.read'] })),
      fresh.env,
    );
    expect(minted?.status).toBe(201);
    expect(minted?.headers.get('cache-control')).toBe('no-store');
    expect(await minted?.json()).toMatchObject({
      token: expect.stringMatching(/^pta_/),
      name: 'ci',
      scopes: ['agent.exec', 'agent.read'],
    });
    expect(fresh.calls).toContain(`tokens:mint:${USER_ID}:ci:agent.exec+agent.read`);

    const stale = setupEnv({ sessionMintedAt: Date.now() - 24 * 60 * 60 * 1000 });
    const refused = await handleCliRequest(
      req(SESSION_TOKEN, '/api/cli/tokens', jsonInit({ name: 'ci', scopes: ['agent.exec'] })),
      stale.env,
    );
    expect(refused?.status).toBe(401);
    expect((await refused?.json() as { error: string }).error).toContain('step-up auth required');
    expect(stale.calls.some((c) => c.startsWith('tokens:mint'))).toBe(false);
  });

  test('mint validates input and surfaces store rejections as 400', async () => {
    const { env } = setupEnv({ sessionMintedAt: Date.now() });
    const missing = await handleCliRequest(req(SESSION_TOKEN, '/api/cli/tokens', jsonInit({ name: 'ci' })), env);
    expect(missing?.status).toBe(400);
    const dup = await handleCliRequest(
      req(SESSION_TOKEN, '/api/cli/tokens', jsonInit({ name: 'dup', scopes: ['agent.exec'] })),
      env,
    );
    expect(dup?.status).toBe(400);
    expect((await dup?.json() as { error: string }).error).toContain('already exists');
  });

  test('lists active tokens and revokes by ref with honest 404s', async () => {
    const { env, calls } = setupEnv();
    const list = await handleCliRequest(req(SESSION_TOKEN, '/api/cli/tokens'), env);
    expect(list?.status).toBe(200);
    expect(await list?.json()).toEqual({
      tokens: [{ tokenHash: 'exec-hash', name: 'ci', scopes: ['agent.exec'], createdAt: 1, lastUsedAt: 2 }],
    });

    const revoked = await handleCliRequest(req(SESSION_TOKEN, '/api/cli/tokens/ci', { method: 'DELETE' }), env);
    expect(revoked?.status).toBe(200);
    expect(calls).toContain('tokens:revoke:ci');

    const missing = await handleCliRequest(req(SESSION_TOKEN, '/api/cli/tokens/ghost', { method: 'DELETE' }), env);
    expect(missing?.status).toBe(404);
  });
});
