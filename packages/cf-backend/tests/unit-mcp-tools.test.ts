// Behavior tests for the MCP write/act tools (run_task, send_peer, list_peers,
// release). Each is a thin wrapper over an existing @callable on the
// orchestrator: the tests drive a real MCP `tools/call` through handleMcpRequest
// and assert the wrapper (a) reached the right @callable with the right args,
// (b) surfaced its result honestly, and (c) is gated by the SAME auth +
// per-agent ownership as the read tools — a scoped access token can't reach the
// write surface at all, and an unowned agent is refused before any tool runs.
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import type { JsonObject, JsonValue } from '@kinu/core';
import type { UserCaller } from '../src/user/workspace-capability';
import { mockAgentsSdk } from './helpers/agents-sdk';

mockAgentsSdk();
const { handleMcpRequest } = await import('../src/mcp-server');

const USER_ID = '0123456789abcdef0123456789abcdef';
const SESSION_TOKEN = `ptc_${USER_ID}_abcdefghijklmnopqrstuvwxyz`;
const ACCESS_TOKEN = `pta_${USER_ID}_abcdefghijklmnopqrstuvwxyz012345`;

interface AgentCall { method: string; args: JsonValue[]; }

function mcpEnv() {
  const calls: AgentCall[] = [];
  const record = (method: string, ...args: JsonValue[]) => { calls.push({ method, args }); };
  const userDO = {
    async verifyCliToken(_caller: UserCaller, token: string) {
      return token === SESSION_TOKEN
        ? { ok: true, tokenHash: 'hash', user: { id: USER_ID, email: 'a@example.com', displayName: null } }
        : { ok: false, error: 'invalid token' };
    },
    async verifyAccessToken(_caller: UserCaller, token: string) {
      return token === ACCESS_TOKEN
        ? { ok: true, tokenHash: 'ahash', scopes: ['workspace.exec'], user: { id: USER_ID, email: 'a@example.com', displayName: null } }
        : { ok: false, error: 'invalid token' };
    },
    async hasWorkspace(_caller: UserCaller, name: string) { return name === 'jarvis'; },
    async ensureWorkspaceCapability() {},
  };
  const agent = {
    async claimOwner(userId: string) { record('claimOwner', userId); return { owner: userId, capabilityHash: 'sha-existing' }; },
    async runTaskFromMcp(text: string) { record('runTaskFromMcp', text); return { status: 'queued' }; },
    async sendPeerFromMcp(input: { agent: string; message: string; topic?: string }) {
      record('sendPeerFromMcp', input);
      if (input.agent === 'stranger') throw new Error('unknown peer "stranger" — list your team with action:"list"');
      return { status: 'delivered', message_id: 'evt_123' };
    },
    async listPeersFromMcp() { record('listPeersFromMcp'); return [{ name: 'atlas', displayName: 'Atlas' }]; },
    async getReleaseBoard(limit: number) { record('getReleaseBoard', limit); return { changes: [], bindings: [] }; },
    async createReleaseChange(input: JsonObject) { record('createReleaseChange', input); return { id: 'pc_1', status: 'draft', bindingId: 'bind_1' }; },
    async transitionReleaseChange(changeId: string, status: string) { record('transitionReleaseChange', changeId, status); return { id: changeId, status }; },
  };
  const bindings = {
    AUTH_KV: {},
    UserDO: { idFromName: (n: string) => n, get: () => userDO },
    OrchestratorAgent: { idFromName: (n: string) => n, get: () => agent },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  };
  const partialEnv: Partial<Env> = {};
  Object.assign(partialEnv, bindings);
  // SAFETY: handleMcpRequest only reaches the locally constructed auth and
  // orchestrator namespaces above; every method used by this suite is present.
  const env = partialEnv as Env;
  return { env, calls };
}

function toolCall(agentName: string, name: string, args: JsonObject, token?: string) {
  const headers = new Headers({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-03-26',
  });
  if (token) headers.set('authorization', `Bearer ${token}`);
  return new Request(`https://kinu.example.com/mcp/v1/${agentName}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
  });
}

/** The MCP result text for a tools/call — pulled out of the SSE body. */
async function resultText(res: Response | null): Promise<string> {
  if (!res) throw new Error('Expected the MCP handler to return a response');
  const body = await res.text();
  const match = /"text":"((?:[^"\\]|\\.)*)"/.exec(body);
  return match?.[1] ? v.parse(v.string(), JSON.parse(`"${match[1]}"`)) : body;
}

describe('MCP write tools → real @callables', () => {
  // The transport streams the tool result as SSE; the tool handler runs while
  // the body is produced, so every test reads the body (resultText) BEFORE
  // asserting on the recorded @callable invocations.

  test('run_task invokes runTaskFromMcp and reports queued', async () => {
    const { env, calls } = mcpEnv();
    const res = await handleMcpRequest(toolCall('jarvis', 'run_task', { text: '  ship it  ' }, SESSION_TOKEN), env);
    expect(res?.status).toBe(200);
    expect(await resultText(res)).toContain('queued');
    expect(calls.find((c) => c.method === 'runTaskFromMcp')?.args).toEqual(['  ship it  ']);
  });

  test('send_peer invokes sendPeerFromMcp and reports delivery', async () => {
    const { env, calls } = mcpEnv();
    const res = await handleMcpRequest(toolCall('jarvis', 'send_peer', { agent: 'atlas', message: 'hi', topic: 'sync' }, SESSION_TOKEN), env);
    expect(res?.status).toBe(200);
    expect(await resultText(res)).toContain('delivered to atlas');
    expect(calls.find((c) => c.method === 'sendPeerFromMcp')?.args).toEqual([{ agent: 'atlas', message: 'hi', topic: 'sync' }]);
  });

  test('send_peer surfaces the DO roster/ownership rejection honestly', async () => {
    const { env } = mcpEnv();
    const res = await handleMcpRequest(toolCall('jarvis', 'send_peer', { agent: 'stranger', message: 'hi' }, SESSION_TOKEN), env);
    expect(res?.status).toBe(200);
    expect(await resultText(res)).toContain('unknown peer');
  });

  test('list_peers invokes listPeersFromMcp', async () => {
    const { env, calls } = mcpEnv();
    const res = await handleMcpRequest(toolCall('jarvis', 'list_peers', {}, SESSION_TOKEN), env);
    expect(res?.status).toBe(200);
    expect(await resultText(res)).toContain('atlas');
    expect(calls.some((c) => c.method === 'listPeersFromMcp')).toBe(true);
  });

  test('release list invokes getReleaseBoard', async () => {
    const { env, calls } = mcpEnv();
    const res = await handleMcpRequest(toolCall('jarvis', 'release', { action: 'list' }, SESSION_TOKEN), env);
    expect(res?.status).toBe(200);
    await resultText(res);
    expect(calls.some((c) => c.method === 'getReleaseBoard')).toBe(true);
  });

  test('release create invokes createReleaseChange with mapped args', async () => {
    const { env, calls } = mcpEnv();
    const res = await handleMcpRequest(toolCall('jarvis', 'release', { action: 'create', bindingId: 'bind_1', prompt: 'add a button' }, SESSION_TOKEN), env);
    expect(res?.status).toBe(200);
    expect(await resultText(res)).toContain('pc_1');
    expect(calls.find((c) => c.method === 'createReleaseChange')?.args).toEqual([{ bindingId: 'bind_1', userPrompt: 'add a button', plan: null }]);
  });

  test('release advance invokes transitionReleaseChange', async () => {
    const { env, calls } = mcpEnv();
    const res = await handleMcpRequest(toolCall('jarvis', 'release', { action: 'advance', changeId: 'pc_1', status: 'planning' }, SESSION_TOKEN), env);
    expect(res?.status).toBe(200);
    await resultText(res);
    expect(calls.find((c) => c.method === 'transitionReleaseChange')?.args).toEqual(['pc_1', 'planning']);
  });

  test('release create without required args does not call the @callable', async () => {
    const { env, calls } = mcpEnv();
    const res = await handleMcpRequest(toolCall('jarvis', 'release', { action: 'create' }, SESSION_TOKEN), env);
    expect(res?.status).toBe(200);
    expect(await resultText(res)).toContain('requires bindingId and prompt');
    expect(calls.some((c) => c.method === 'createReleaseChange')).toBe(false);
  });

  test('release advance into an engine-owned state is refused — same gate as the builtin tool', async () => {
    const { env, calls } = mcpEnv();
    for (const status of ['validating', 'preview_ready', 'applying', 'deployed', 'rolled_back']) {
      const res = await handleMcpRequest(toolCall('jarvis', 'release', { action: 'advance', changeId: 'pc_1', status }, SESSION_TOKEN), env);
      expect(res?.status).toBe(200);
      expect(await resultText(res)).toContain('earned by execution');
    }
    expect(calls.some((c) => c.method === 'transitionReleaseChange')).toBe(false);
  });

  test('release advance with a status outside the real enum is refused by the schema', async () => {
    const { env, calls } = mcpEnv();
    const res = await handleMcpRequest(toolCall('jarvis', 'release', { action: 'advance', changeId: 'pc_1', status: 'shipped' }, SESSION_TOKEN), env);
    expect(res?.status).toBe(200);
    expect(await resultText(res)).toContain('Invalid');
    expect(calls.some((c) => c.method === 'transitionReleaseChange')).toBe(false);
  });
});

describe('MCP write tools — auth + ownership gate (a scoped token cannot exceed its grant)', () => {
  test('scoped pta_ access token is refused before any write tool runs', async () => {
    const { env, calls } = mcpEnv();
    const res = await handleMcpRequest(toolCall('jarvis', 'run_task', { text: 'go' }, ACCESS_TOKEN), env);
    expect(res?.status).toBe(403);
    expect(calls.some((c) => c.method === 'runTaskFromMcp')).toBe(false);
  });

  test('unowned agent is refused (404) before any write tool runs', async () => {
    const { env, calls } = mcpEnv();
    const res = await handleMcpRequest(toolCall('not-mine', 'run_task', { text: 'go' }, SESSION_TOKEN), env);
    expect(res?.status).toBe(404);
    expect(calls.some((c) => c.method === 'runTaskFromMcp')).toBe(false);
  });

  test('no credentials → 401, no tool runs', async () => {
    const { env, calls } = mcpEnv();
    const res = await handleMcpRequest(toolCall('jarvis', 'run_task', { text: 'go' }), env);
    expect(res?.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});
