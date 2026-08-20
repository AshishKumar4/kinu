// Route-level behavior for scoped `pta_…` CI access tokens: exec/read scopes
// gate exactly the surfaces they name, everything sensitive stays
// interactive-session-only, and minting is step-up gated.
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { describe, expect, test } from 'bun:test';
import { handleCliRequest } from '../src/cli/routes';
import type { JsonValue } from '@kinu/core';
import type { UserCaller } from '../src/user/workspace-capability';
import * as v from 'valibot';

const USER_ID = '0123456789abcdef0123456789abcdef';
const SESSION_TOKEN = `ptc_${USER_ID}_abcdefghijklmnopqrstuvwxyz`;
const EXEC_TOKEN = `pta_${USER_ID}_${'e'.repeat(44)}`;
const READ_TOKEN = `pta_${USER_ID}_${'r'.repeat(44)}`;
const BOTH_TOKEN = `pta_${USER_ID}_${'b'.repeat(44)}`;

const ACCESS_TOKENS = new Map([
  [EXEC_TOKEN, { hash: 'exec-hash', scopes: ['workspace.exec'] }],
  [READ_TOKEN, { hash: 'read-hash', scopes: ['workspace.read'] }],
  [BOTH_TOKEN, { hash: 'both-hash', scopes: ['workspace.read', 'workspace.exec'] }],
]);

const ErrorResponseSchema = v.object({ error: v.string() });
const RpcStatusResponseSchema = v.object({ result: v.object({ name: v.string() }) });
const MeResponseSchema = v.object({
  user: v.object({ id: v.string() }),
  token: v.object({
    kind: v.string(),
    scopes: v.union([v.literal('all'), v.array(v.string())]),
  }),
});
const MintedTokenSchema = v.object({
  token: v.string(),
  name: v.string(),
  scopes: v.array(v.string()),
});
const TokenListSchema = v.object({
  tokens: v.array(v.object({
    tokenHash: v.string(),
    name: v.string(),
    scopes: v.array(v.string()),
    createdAt: v.number(),
    lastUsedAt: v.nullable(v.number()),
  })),
});

interface TestNamespace<Stub> {
  idFromName(name: string): string;
  get(): Stub;
}

interface AccessTokenTestBindings<UserStub, AgentStub> {
  UserDO: TestNamespace<UserStub>;
  OrchestratorAgent: TestNamespace<AgentStub>;
  CREDENTIAL_ENCRYPTION_KEY: string;
}

function testEnv<UserStub, AgentStub>(bindings: AccessTokenTestBindings<UserStub, AgentStub>): Env {
  const env: Partial<Env> = {};
  Object.assign(env, bindings);
  // SAFETY: The scoped-token paths reach only the two constructed namespaces
  // and credential key; every typed binding reachable in these tests is present.
  return env as Env;
}

function handled(response: Response | null): Response {
  if (!response) throw new Error('CLI route did not handle the request');
  return response;
}

async function errorBody(response: Response | null) {
  return v.parse(ErrorResponseSchema, await handled(response).json());
}

function setupEnv(opts: { sessionMintedAt?: number } = {}) {
  const calls: string[] = [];
  const userDO = {
    async verifyCliToken(_caller: UserCaller, token: string) {
      return {
        ok: token === SESSION_TOKEN,
        tokenHash: 'session-hash',
        user: { id: USER_ID, email: 'ashish@example.com', displayName: 'Ashish' },
      };
    },
    async verifyAccessToken(_caller: UserCaller, token: string) {
      const entry = ACCESS_TOKENS.get(token);
      if (!entry) return { ok: false, error: 'invalid token' };
      return {
        ok: true,
        tokenHash: entry.hash,
        scopes: entry.scopes,
        user: { id: USER_ID, email: 'ashish@example.com', displayName: 'Ashish' },
      };
    },
    async listCliTokens(_caller: UserCaller) {
      return [{
        tokenHash: 'session-hash',
        label: 'terminal',
        createdAt: opts.sessionMintedAt ?? Date.now(),
        expiresAt: Date.now() + 60_000,
        lastUsedAt: null,
      }];
    },
    async mintAccessToken(_caller: UserCaller, userId: string, name: string, scopes: string[]) {
      calls.push(`tokens:mint:${userId}:${name}:${scopes.join('+')}`);
      if (name === 'dup') return { ok: false as const, error: 'An active access token named "dup" already exists.' };
      return {
        ok: true as const,
        token: `pta_${userId}_${'n'.repeat(44)}`,
        record: { tokenHash: 'new-hash', name, scopes, createdAt: 123, lastUsedAt: null },
      };
    },
    async listAccessTokens(_caller: UserCaller) {
      calls.push('tokens:list');
      return [{ tokenHash: 'exec-hash', name: 'ci', scopes: ['workspace.exec'], createdAt: 1, lastUsedAt: 2 }];
    },
    async revokeAccessToken(_caller: UserCaller, ref: string) {
      calls.push(`tokens:revoke:${ref}`);
      return { ok: true as const, revoked: ref === 'ci' };
    },
    async hasWorkspace(_caller: UserCaller, name: string) {
      return name === 'jarvis';
    },
    async ensureWorkspaceCapability() {},
    async issueCliAgentConnectTicket(_caller: UserCaller, input: { cliTokenHash: string }) {
      calls.push(`connect-ticket:${input.cliTokenHash}`);
      return { ok: true, ticket: `pat_${USER_ID}_ticket`, expiresAt: 1234 };
    },
    async listDevices(_caller: UserCaller) {
      calls.push('devices:list');
      return [];
    },
    async registerDevice(_caller: UserCaller) {
      calls.push('devices:register');
      return { deviceId: 'dev_1', token: 'raw-device-token' };
    },
  };
  const agent = {
    async claimOwner(userId: string) {
      return { owner: userId, capabilityHash: 'sha-existing' };
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
  const env = testEnv({
    UserDO: { idFromName: (n: string) => n, get: () => userDO },
    OrchestratorAgent: { idFromName: (n: string) => n, get: () => agent },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  });
  return { env, calls };
}

function req(token: string, path: string, init: RequestInit = {}) {
  return new Request(`https://proteus.example.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  });
}

const jsonInit = (body: JsonValue, method = 'POST'): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const rpcInit = (method: string, args: JsonValue[] = []): RequestInit => jsonInit({ method, args });
const RPC = '/api/cli/workspaces/jarvis/rpc';

describe('access token scope enforcement', () => {
  test('workspace.exec token can mint connect tickets, stop work, and run executors', async () => {
    const { env, calls } = setupEnv();
    const ticket = await handleCliRequest(req(EXEC_TOKEN, '/api/cli/workspaces/jarvis/connect-ticket', { method: 'POST' }), env);
    expect(ticket?.status).toBe(200);
    expect(calls).toContain('connect-ticket:exec-hash');

    const stop = await handleCliRequest(req(EXEC_TOKEN, RPC, rpcInit('cancelCurrentWork')), env);
    expect(stop?.status).toBe(200);

    const exec = await handleCliRequest(req(EXEC_TOKEN, RPC, rpcInit('executeInExecutor', ['workspace', 'pwd'])), env);
    expect(exec?.status).toBe(200);
    expect(calls).toContain('executors:exec:workspace:pwd');
  });

  test('workspace.exec token cannot read agent state without workspace.read', async () => {
    const { env, calls } = setupEnv();
    const res = await handleCliRequest(req(EXEC_TOKEN, RPC, rpcInit('getAgentStatus')), env);
    expect(res?.status).toBe(403);
    expect((await errorBody(res)).error).toContain('workspace.read');
    expect(calls).not.toContain('status');
  });

  test('workspace.read token can read but cannot exec', async () => {
    const { env, calls } = setupEnv();
    const status = await handleCliRequest(req(READ_TOKEN, RPC, rpcInit('getAgentStatus')), env);
    expect(status?.status).toBe(200);
    const statusBody = v.parse(RpcStatusResponseSchema, await handled(status).json());
    expect(statusBody.result).toMatchObject({ name: 'jarvis' });

    const exec = await handleCliRequest(req(READ_TOKEN, RPC, rpcInit('executeInExecutor', ['workspace', 'pwd'])), env);
    expect(exec?.status).toBe(403);
    expect((await errorBody(exec)).error).toContain('workspace.exec');

    const ticket = await handleCliRequest(req(READ_TOKEN, '/api/cli/workspaces/jarvis/connect-ticket', { method: 'POST' }), env);
    expect(ticket?.status).toBe(403);
    expect((await errorBody(ticket)).error).toContain('workspace.exec');
    expect(calls.some((c) => c.startsWith('connect-ticket:'))).toBe(false);
  });

  test('access tokens are denied every interactive-only surface, server-side', async () => {
    const { env, calls } = setupEnv({ sessionMintedAt: Date.now() });
    const forbidden: Array<[string, RequestInit]> = [
      ['/api/cli/workspaces/jarvis/triggers/webhook', jsonInit({ label: 'ci', auth_mode: 'hmac' })],
      [RPC, rpcInit('createTimerTrigger', [{ atMs: Date.now() + 1000, trust: 'owner' }])],
      ['/api/cli/devices', jsonInit({ label: 'pc' })],
      ['/api/cli/devices', { method: 'GET' }],
      ['/api/cli/workspaces', jsonInit({ name: 'new-agent' })],
      ['/api/cli/workspaces/jarvis', { method: 'DELETE' }],
      [RPC, rpcInit('resolveDeviceConsent', ['cons-1', 'always'])],
      [RPC, rpcInit('setModel', ['openai/gpt-5.1'])],
      ['/api/cli/tokens', jsonInit({ name: 'more', scopes: ['workspace.exec'] })],
      ['/api/cli/tokens', { method: 'GET' }],
      ['/api/cli/tokens/ci', { method: 'DELETE' }],
      ['/api/cli/logout', { method: 'POST' }],
    ];
    for (const [path, init] of forbidden) {
      const res = await handleCliRequest(req(BOTH_TOKEN, path, init), env);
      expect(`${path}:${res?.status}`).toBe(`${path}:403`);
      expect((await errorBody(res)).error).toContain('interactive CLI session token');
    }
    expect(calls.filter((c) => !c.startsWith('connect-ticket'))).toEqual([]);
  });

  test('off-table rpc methods are 404s for scoped tokens without dispatch', async () => {
    const { env, calls } = setupEnv();
    const res = await handleCliRequest(req(BOTH_TOKEN, RPC, rpcInit('destroyAgent', ['someone'])), env);
    expect(res?.status).toBe(404);
    expect(calls).toEqual([]);
  });

  test('/me works for any valid bearer and reports kind and scopes', async () => {
    const { env } = setupEnv();
    const me = await handleCliRequest(req(EXEC_TOKEN, '/api/cli/me'), env);
    expect(me?.status).toBe(200);
    expect(v.parse(MeResponseSchema, await handled(me).json())).toMatchObject({
      user: { id: USER_ID },
      token: { kind: 'access', scopes: ['workspace.exec'] },
    });

    const sessionMe = await handleCliRequest(req(SESSION_TOKEN, '/api/cli/me'), env);
    expect(v.parse(MeResponseSchema, await handled(sessionMe).json()))
      .toMatchObject({ token: { kind: 'session', scopes: 'all' } });
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
      req(SESSION_TOKEN, '/api/cli/tokens', jsonInit({ name: 'ci', scopes: ['workspace.exec', 'workspace.read'] })),
      fresh.env,
    );
    expect(minted?.status).toBe(201);
    expect(handled(minted).headers.get('cache-control')).toBe('no-store');
    expect(v.parse(MintedTokenSchema, await handled(minted).json())).toMatchObject({
      token: expect.stringMatching(/^pta_/),
      name: 'ci',
      scopes: ['workspace.exec', 'workspace.read'],
    });
    expect(fresh.calls).toContain(`tokens:mint:${USER_ID}:ci:workspace.exec+workspace.read`);

    const stale = setupEnv({ sessionMintedAt: Date.now() - 24 * 60 * 60 * 1000 });
    const refused = await handleCliRequest(
      req(SESSION_TOKEN, '/api/cli/tokens', jsonInit({ name: 'ci', scopes: ['workspace.exec'] })),
      stale.env,
    );
    expect(refused?.status).toBe(401);
    expect((await errorBody(refused)).error).toContain('step-up auth required');
    expect(stale.calls.some((c) => c.startsWith('tokens:mint'))).toBe(false);
  });

  test('mint validates input and surfaces store rejections as 400', async () => {
    const { env } = setupEnv({ sessionMintedAt: Date.now() });
    const missing = await handleCliRequest(req(SESSION_TOKEN, '/api/cli/tokens', jsonInit({ name: 'ci' })), env);
    expect(missing?.status).toBe(400);
    const dup = await handleCliRequest(
      req(SESSION_TOKEN, '/api/cli/tokens', jsonInit({ name: 'dup', scopes: ['workspace.exec'] })),
      env,
    );
    expect(dup?.status).toBe(400);
    expect((await errorBody(dup)).error).toContain('already exists');
  });

  test('lists active tokens and revokes by ref with honest 404s', async () => {
    const { env, calls } = setupEnv();
    const list = await handleCliRequest(req(SESSION_TOKEN, '/api/cli/tokens'), env);
    expect(list?.status).toBe(200);
    expect(v.parse(TokenListSchema, await handled(list).json())).toEqual({
      tokens: [{ tokenHash: 'exec-hash', name: 'ci', scopes: ['workspace.exec'], createdAt: 1, lastUsedAt: 2 }],
    });

    const revoked = await handleCliRequest(req(SESSION_TOKEN, '/api/cli/tokens/ci', { method: 'DELETE' }), env);
    expect(revoked?.status).toBe(200);
    expect(calls).toContain('tokens:revoke:ci');

    const missing = await handleCliRequest(req(SESSION_TOKEN, '/api/cli/tokens/ghost', { method: 'DELETE' }), env);
    expect(missing?.status).toBe(404);
  });
});
