import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { describe, expect, test } from 'bun:test';
import { handleCliRequest } from '../src/cli/routes';
import { JsonValueSchema, type JsonObject, type JsonValue } from '@kinu/core';
import type { UserCaller } from '../src/user/workspace-capability';
import * as v from 'valibot';

const USER_ID = '0123456789abcdef0123456789abcdef';
const TOKEN = `ptc_${USER_ID}_abcdefghijklmnopqrstuvwxyz`;

const OkResponseSchema = v.object({ ok: v.boolean() });
const TicketResponseSchema = v.object({ ticket: v.string(), expiresAt: v.number() });
const ErrorResponseSchema = v.object({ error: v.string() });
const RpcResponseSchema = v.object({ result: JsonValueSchema });

interface TestNamespace<Stub> {
  idFromName(name: string): string;
  get(): Stub;
}

interface ControlRouteTestBindings<UserStub, AgentStub> {
  UserDO: TestNamespace<UserStub>;
  OrchestratorAgent: TestNamespace<AgentStub>;
  CREDENTIAL_ENCRYPTION_KEY: string;
}

function testEnv<UserStub, AgentStub>(bindings: ControlRouteTestBindings<UserStub, AgentStub>): Env {
  const env: Partial<Env> = {};
  Object.assign(env, bindings);
  // SAFETY: The control routes reach only the two constructed namespaces and
  // credential key; every typed binding reachable in these tests is present.
  return env as Env;
}

function handled(response: Response | null): Response {
  if (!response) throw new Error('CLI control route did not handle the request');
  return response;
}

async function errorBody(response: Response | null) {
  return v.parse(ErrorResponseSchema, await handled(response).json());
}

function setupEnv(opts: { tokenMintedAt?: number } = {}) {
  const calls: string[] = [];
  const userDO = {
    async verifyCliToken(_caller: UserCaller, token: string) {
      return {
        ok: token === TOKEN,
        tokenHash: 'hash',
        user: { id: USER_ID, email: 'ashish@example.com', displayName: 'Ashish' },
      };
    },
    async listCliTokens(_caller: UserCaller) {
      return [{
        tokenHash: 'hash',
        label: 'terminal',
        createdAt: opts.tokenMintedAt ?? Date.now(),
        expiresAt: Date.now() + 60_000,
        lastUsedAt: null,
      }];
    },
    async hasWorkspace(_caller: UserCaller, name: string) {
      return name === 'jarvis';
    },
    async ensureWorkspaceCapability() {},
    async removeWorkspace(_caller: UserCaller, name: string, ownerUserId: string) {
      calls.push(`workspace:remove:${name}:${ownerUserId}`);
    },
    async issueCliAgentConnectTicket(_caller: UserCaller, input: { userId: string; agentName: string; cliTokenHash: string }) {
      calls.push(`connect-ticket:${input.userId}:${input.agentName}:${input.cliTokenHash}`);
      return { ok: true, ticket: `pat_${USER_ID}_ticket`, expiresAt: 1234 };
    },
  };
  const agent = {
    async claimOwner(userId: string) {
      calls.push(`claim:${userId}`);
      return { owner: userId, capabilityHash: 'sha-existing' };
    },
    async getAgentStatus() {
      calls.push('status');
      return { name: 'jarvis', purpose: 'help', messageCount: 3 };
    },
    async getToolDescriptions() {
      calls.push('tools');
      return { builtIn: [{ name: 'run', description: 'Run command' }], crafted: [], executors: [] };
    },
    async getChatHistoryPage(request: { limit?: number }) {
      calls.push(`messages:${request.limit}`);
      return {
        status: 'end',
        items: [
          { id: 'u1', role: 'user', content: 'hello', createdAt: '2026-06-08 00:00:00.000' },
          { id: 'a1', role: 'assistant', content: 'hi', createdAt: '2026-06-08 00:00:00.001' },
        ],
      };
    },
    async listPendingConsents() {
      calls.push('consents:list');
      return [{ consentId: 'cons-1', deviceLabel: 'Workstation', method: 'exec', command: 'pwd', scope: 'all_local_actions', createdAt: 1 }];
    },
    async resolveDeviceConsent(id: string, decision: string) {
      calls.push(`consents:resolve:${id}:${decision}`);
      return { ok: true };
    },
    async setModel(spec: string) {
      calls.push(`model:set:${spec}`);
      return { ok: true, spec };
    },
    async getReasoningEffort() {
      calls.push('effort:get');
      return { effort: 'medium' };
    },
    async setReasoningEffort(effort: string) {
      calls.push(`effort:set:${effort}`);
      return { ok: true, effort };
    },
    async createTimerTrigger(opts: JsonObject) {
      calls.push(`triggers:create:${JSON.stringify(opts)}`);
      return { id: 'trg_1', kind: 'timer_oneshot', nextFireAt: 123 };
    },
    async listBackgroundJobs(limit: number) {
      calls.push(`jobs:list:${limit}`);
      return [{ id: 'job_1', kind: 'run', status: 'running' }];
    },
    async cancelBackgroundJob(id: string) {
      calls.push(`jobs:cancel:${id}`);
      return { ok: true };
    },
    async cancelCurrentWork() {
      calls.push('work:cancel');
      return { ok: true, cancelledJobs: ['job_1'], abortedTools: 1 };
    },
    async searchMemoryHybrid(query: string, limit: number) {
      calls.push(`memory:search:${query}:${limit}`);
      return [{ path: 'memory/MEMORY.md', snippet: 'hit', score: 1 }];
    },
    async executeInExecutor(id: string, command: string) {
      calls.push(`executors:exec:${id}:${command}`);
      return { stdout: 'ok', exitCode: 0 };
    },
    async createDurableWebhook(opts: JsonObject) {
      calls.push(`triggers:webhook:${JSON.stringify(opts)}`);
      return { trigger_id: 'trg_webhook', url: '/api/workspaces/jarvis/webhook/trg_webhook', secret: 'secret' };
    },
    // Off-table on purpose: the rpc dispatcher must never reach this.
    async destroyAgent(expectedOwnerUserId: string) {
      calls.push(`destroy:${expectedOwnerUserId}`);
      return { ok: true };
    },
    async deviceRpc(method: string) {
      calls.push(`deviceRpc:${method}`);
      return null;
    },
  };
  const env = testEnv({
    UserDO: {
      idFromName(name: string) { return name; },
      get() { return userDO; },
    },
    OrchestratorAgent: {
      idFromName(name: string) { return name; },
      get() { return agent; },
    }, CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });
  return { env, calls };
}

function cliRequest(path: string, init: RequestInit = {}) {
  return new Request(`https://kinu.example.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...init.headers,
    },
  });
}

function rpcRequest(method: string, args: JsonValue[] = [], agent = 'jarvis') {
  return cliRequest(`/api/cli/workspaces/${agent}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, args }),
  });
}

async function rpcResult(env: Env, method: string, args: JsonValue[] = []): Promise<JsonValue> {
  const res = await handleCliRequest(rpcRequest(method, args), env);
  expect(`${method}:${res?.status}`).toBe(`${method}:200`);
  return v.parse(RpcResponseSchema, await handled(res).json()).result;
}

describe('CLI control routes', () => {
  test('deletes an owned workspace through the authenticated user DO', async () => {
    const { env, calls } = setupEnv();

    const deleted = await handleCliRequest(cliRequest('/api/cli/workspaces/%6Aarvis', { method: 'DELETE' }), env);
    expect(deleted?.status).toBe(200);
    expect(v.parse(OkResponseSchema, await handled(deleted).json())).toEqual({ ok: true });
    expect(calls).toContain(`workspace:remove:jarvis:${USER_ID}`);

    const missing = await handleCliRequest(cliRequest('/api/cli/workspaces/unknown', { method: 'DELETE' }), env);
    expect(missing?.status).toBe(404);
    expect(calls.some((call) => call.includes('workspace:remove:unknown'))).toBe(false);
  });

  test('mints scoped agent websocket tickets for owned agents', async () => {
    const { env, calls } = setupEnv();

    const ticket = await handleCliRequest(cliRequest('/api/cli/workspaces/jarvis/connect-ticket', { method: 'POST' }), env);
    expect(ticket?.status).toBe(200);
    expect(handled(ticket).headers.get('cache-control')).toBe('no-store');
    expect(v.parse(TicketResponseSchema, await handled(ticket).json()))
      .toEqual({ ticket: `pat_${USER_ID}_ticket`, expiresAt: 1234 });
    expect(calls).toContain(`connect-ticket:${USER_ID}:jarvis:hash`);

    const missing = await handleCliRequest(cliRequest('/api/cli/workspaces/unknown/connect-ticket', { method: 'POST' }), env);
    expect(missing?.status).toBe(404);
  });

  test('the generic rpc endpoint dispatches every table method through the owned OrchestratorAgent', async () => {
    const { env, calls } = setupEnv();

    expect(await rpcResult(env, 'getAgentStatus')).toMatchObject({ name: 'jarvis', messageCount: 3 });
    expect(await rpcResult(env, 'getToolDescriptions')).toMatchObject({ builtIn: [{ name: 'run' }] });
    expect(await rpcResult(env, 'getChatHistoryPage', [{ limit: 17 }])).toEqual({
      status: 'end',
      items: [
        { id: 'u1', role: 'user', content: 'hello', createdAt: '2026-06-08 00:00:00.000' },
        { id: 'a1', role: 'assistant', content: 'hi', createdAt: '2026-06-08 00:00:00.001' },
      ],
    });
    expect(await rpcResult(env, 'listPendingConsents')).toEqual([
      { consentId: 'cons-1', deviceLabel: 'Workstation', method: 'exec', command: 'pwd', scope: 'all_local_actions', createdAt: 1 },
    ]);
    expect(await rpcResult(env, 'resolveDeviceConsent', ['cons-1', 'once'])).toEqual({ ok: true });
    expect(await rpcResult(env, 'setModel', ['openai/gpt-5.1'])).toEqual({ ok: true, spec: 'openai/gpt-5.1' });
    expect(await rpcResult(env, 'getReasoningEffort')).toEqual({ effort: 'medium' });
    expect(await rpcResult(env, 'setReasoningEffort', ['high'])).toEqual({ ok: true, effort: 'high' });
    expect(await rpcResult(env, 'createTimerTrigger', [{ atMs: 123, label: 'wake', trust: 'owner' }]))
      .toMatchObject({ id: 'trg_1', nextFireAt: 123 });
    expect(await rpcResult(env, 'listBackgroundJobs', [7])).toEqual([{ id: 'job_1', kind: 'run', status: 'running' }]);
    expect(await rpcResult(env, 'cancelBackgroundJob', ['job_1'])).toEqual({ ok: true });
    expect(await rpcResult(env, 'cancelCurrentWork')).toMatchObject({ ok: true, abortedTools: 1 });
    expect(await rpcResult(env, 'searchMemoryHybrid', ['repo', 3])).toEqual([{ path: 'memory/MEMORY.md', snippet: 'hit', score: 1 }]);
    expect(await rpcResult(env, 'executeInExecutor', ['workspace', 'pwd'])).toEqual({ stdout: 'ok', exitCode: 0 });

    expect(calls).toContain(`claim:${USER_ID}`);
    expect(calls).toContain('status');
    expect(calls).toContain('tools');
    expect(calls).toContain('messages:17');
    expect(calls).toContain('consents:list');
    expect(calls).toContain('consents:resolve:cons-1:once');
    expect(calls).toContain('model:set:openai/gpt-5.1');
    expect(calls).toContain('effort:get');
    expect(calls).toContain('effort:set:high');
    expect(calls).toContain('triggers:create:{"atMs":123,"label":"wake","trust":"owner"}');
    expect(calls).toContain('jobs:list:7');
    expect(calls).toContain('jobs:cancel:job_1');
    expect(calls).toContain('work:cancel');
    expect(calls).toContain('memory:search:repo:3');
    expect(calls).toContain('executors:exec:workspace:pwd');
  });

  test('off-table and never methods are rejected WITHOUT dispatching', async () => {
    const { env, calls } = setupEnv();
    for (const method of ['deviceRpc', 'claimOwner', 'constructor', '__proto__', 'destroyAgent']) {
      const res = await handleCliRequest(rpcRequest(method, ['x']), env);
      expect(`${method}:${res?.status}`).toBe(`${method}:404`);
      expect((await errorBody(res)).error).toContain('No such agent RPC method');
    }
    // Nothing was invoked on the DO — not even the ownership claim.
    expect(calls).toEqual([]);
  });

  test('malformed rpc bodies are 400s, unknown workspaces are 404s', async () => {
    const { env } = setupEnv();
    const noMethod = await handleCliRequest(cliRequest('/api/cli/workspaces/jarvis/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: [] }),
    }), env);
    expect(noMethod?.status).toBe(400);

    const badArgs = await handleCliRequest(cliRequest('/api/cli/workspaces/jarvis/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'getAgentStatus', args: { not: 'an array' } }),
    }), env);
    expect(badArgs?.status).toBe(400);

    const unknownAgent = await handleCliRequest(rpcRequest('getAgentStatus', [], 'unknown'), env);
    expect(unknownAgent?.status).toBe(404);
  });

  test('a throwing method surfaces as a 400 with its message', async () => {
    const env = testEnv({
      UserDO: {
        idFromName: (n: string) => n,
        get: () => ({
          async verifyCliToken(_caller: UserCaller, token: string) {
            return { ok: token === TOKEN, tokenHash: 'hash', user: { id: USER_ID, email: 'a@example.com', displayName: null } };
          },
          async hasWorkspace(_caller: UserCaller) { return true; },
          async ensureWorkspaceCapability() {},
        }),
      },
      OrchestratorAgent: {
        idFromName: (n: string) => n,
        get: () => ({
          async claimOwner() { return { owner: USER_ID, capabilityHash: 'sha-existing' }; },
          async createTimerTrigger() { throw new Error('Timer trigger requires cron or atMs'); },
        }),
      }, CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });
    const thrown = await handleCliRequest(rpcRequest('createTimerTrigger', [{}]), env);
    expect(thrown?.status).toBe(400);
    expect((await errorBody(thrown)).error).toContain('Timer trigger requires cron or atMs');
  });
});

describe('shared ownership claim status mapping', () => {
  function envWithClaimFailure(message: string) {
    return testEnv({
      UserDO: {
        idFromName: (n: string) => n,
        get: () => ({
          async verifyCliToken(_caller: UserCaller, token: string) {
            return { ok: token === TOKEN, tokenHash: 'hash', user: { id: USER_ID, email: 'a@example.com', displayName: null } };
          },
          async hasWorkspace(_caller: UserCaller) { return true; },
          async ensureWorkspaceCapability() {},
        }),
      },
      OrchestratorAgent: {
        idFromName: (n: string) => n,
        get: () => ({ async claimOwner() { throw new Error(message); } }),
      }, CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });
  }

  test('cross-user collision → 403', async () => {
    const res = await handleCliRequest(rpcRequest('getAgentStatus'), envWithClaimFailure('Agent owned by a different user (stored=aaaa…, caller=bbbb…)'));
    expect(res?.status).toBe(403);
  });

  test('infra failure during claim → 500, not 403', async () => {
    const res = await handleCliRequest(rpcRequest('getAgentStatus'), envWithClaimFailure('SQLITE_ERROR: no such table: workspace_identity'));
    expect(res?.status).toBe(500);
  });
});

describe('CLI webhook creation step-up gate', () => {
  const webhookInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'github', auth_mode: 'hmac' as const }),
  };

  test('freshly-minted token (recent kinu auth) may create webhooks', async () => {
    const { env, calls } = setupEnv({ tokenMintedAt: Date.now() - 60_000 });
    const res = await handleCliRequest(cliRequest('/api/cli/workspaces/jarvis/triggers/webhook', webhookInit), env);
    expect(res?.status).toBe(201);
    expect(calls.some((c) => c.startsWith('triggers:webhook:'))).toBe(true);
  });

  test('long-lived token is denied with 401 step-up (same policy as the web route)', async () => {
    const { env, calls } = setupEnv({ tokenMintedAt: Date.now() - 24 * 60 * 60 * 1000 });
    const res = await handleCliRequest(cliRequest('/api/cli/workspaces/jarvis/triggers/webhook', webhookInit), env);
    expect(res?.status).toBe(401);
    expect((await errorBody(res)).error).toContain('step-up auth required');
    expect(calls.some((c) => c.startsWith('triggers:webhook:'))).toBe(false);
  });

  test('timer triggers are not step-up gated (matches web semantics)', async () => {
    const { env } = setupEnv({ tokenMintedAt: Date.now() - 24 * 60 * 60 * 1000 });
    const res = await handleCliRequest(rpcRequest('createTimerTrigger', [{ atMs: Date.now() + 1000, trust: 'owner' }]), env);
    expect(res?.status).toBe(200);
  });
});
