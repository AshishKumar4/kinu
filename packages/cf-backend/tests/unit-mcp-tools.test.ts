// Behavior tests for the MCP write/act tools (run_task, send_peer, list_peers,
// product_change). Each is a thin wrapper over an existing @callable on the
// orchestrator: the tests drive a real MCP `tools/call` through handleMcpRequest
// and assert the wrapper (a) reached the right @callable with the right args,
// (b) surfaced its result honestly, and (c) is gated by the SAME auth +
// per-agent ownership as the read tools — a scoped access token can't reach the
// write surface at all, and an unowned agent is refused before any tool runs.
import { describe, test, expect, mock } from 'bun:test';

mock.module('agents', () => ({
  getAgentByName: async (ns: DurableObjectNamespace, name: string) => ns.get(ns.idFromName(name)),
}));
const { handleMcpRequest } = await import('../src/mcp-server.js');

const USER_ID = '0123456789abcdef0123456789abcdef';
const SESSION_TOKEN = `ptc_${USER_ID}_abcdefghijklmnopqrstuvwxyz`;
const ACCESS_TOKEN = `pta_${USER_ID}_abcdefghijklmnopqrstuvwxyz012345`;

interface AgentCall { method: string; args: unknown[]; }

function mcpEnv() {
  const calls: AgentCall[] = [];
  const record = (method: string, ...args: unknown[]) => { calls.push({ method, args }); };
  const userDO = {
    async verifyCliToken(token: string) {
      return token === SESSION_TOKEN
        ? { ok: true, tokenHash: 'hash', user: { id: USER_ID, email: 'a@example.com', displayName: null } }
        : { ok: false, error: 'invalid token' };
    },
    async verifyAccessToken(token: string) {
      return token === ACCESS_TOKEN
        ? { ok: true, tokenHash: 'ahash', scopes: ['agent.exec'], user: { id: USER_ID, email: 'a@example.com', displayName: null } }
        : { ok: false, error: 'invalid token' };
    },
    async hasAgent(name: string) { return name === 'jarvis'; },
  };
  const agent = {
    async claimOwner(userId: string) { record('claimOwner', userId); return { owner: userId }; },
    async runTaskFromMcp(text: string) { record('runTaskFromMcp', text); return { status: 'queued' }; },
    async sendPeerFromMcp(input: { agent: string; message: string; topic?: string }) {
      record('sendPeerFromMcp', input);
      if (input.agent === 'stranger') throw new Error('unknown peer "stranger" — list your team with action:"list"');
      return { status: 'delivered', message_id: 'evt_123' };
    },
    async listPeersFromMcp() { record('listPeersFromMcp'); return [{ name: 'atlas', displayName: 'Atlas' }]; },
    async getProductChangeBoard(limit: number) { record('getProductChangeBoard', limit); return { changes: [], bindings: [] }; },
    async createProductChange(input: unknown) { record('createProductChange', input); return { id: 'pc_1', status: 'draft', bindingId: 'bind_1' }; },
    async transitionProductChange(changeId: string, status: string) { record('transitionProductChange', changeId, status); return { id: changeId, status }; },
  };
  const env = {
    AUTH_DB: {},
    UserDO: { idFromName: (n: string) => n, get: () => userDO },
    OrchestratorAgent: { idFromName: (n: string) => n, get: () => agent },
  } as unknown as Env;
  return { env, calls };
}

function toolCall(agentName: string, name: string, args: Record<string, unknown>, token?: string) {
  return new Request(`https://proteus.example.com/mcp/v1/${agentName}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-03-26',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
  });
}

/** The MCP result text for a tools/call — pulled out of the SSE body. */
async function resultText(res: Response | null): Promise<string> {
  const body = await res!.text();
  const match = /"text":"((?:[^"\\]|\\.)*)"/.exec(body);
  return match ? JSON.parse(`"${match[1]}"`) : body;
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

  test('product_change list invokes getProductChangeBoard', async () => {
    const { env, calls } = mcpEnv();
    const res = await handleMcpRequest(toolCall('jarvis', 'product_change', { action: 'list' }, SESSION_TOKEN), env);
    expect(res?.status).toBe(200);
    await resultText(res);
    expect(calls.some((c) => c.method === 'getProductChangeBoard')).toBe(true);
  });

  test('product_change create invokes createProductChange with mapped args', async () => {
    const { env, calls } = mcpEnv();
    const res = await handleMcpRequest(toolCall('jarvis', 'product_change', { action: 'create', bindingId: 'bind_1', prompt: 'add a button' }, SESSION_TOKEN), env);
    expect(res?.status).toBe(200);
    expect(await resultText(res)).toContain('pc_1');
    expect(calls.find((c) => c.method === 'createProductChange')?.args).toEqual([{ bindingId: 'bind_1', userPrompt: 'add a button', plan: null }]);
  });

  test('product_change advance invokes transitionProductChange', async () => {
    const { env, calls } = mcpEnv();
    const res = await handleMcpRequest(toolCall('jarvis', 'product_change', { action: 'advance', changeId: 'pc_1', status: 'planning' }, SESSION_TOKEN), env);
    expect(res?.status).toBe(200);
    await resultText(res);
    expect(calls.find((c) => c.method === 'transitionProductChange')?.args).toEqual(['pc_1', 'planning']);
  });

  test('product_change create without required args does not call the @callable', async () => {
    const { env, calls } = mcpEnv();
    const res = await handleMcpRequest(toolCall('jarvis', 'product_change', { action: 'create' }, SESSION_TOKEN), env);
    expect(res?.status).toBe(200);
    expect(await resultText(res)).toContain('requires bindingId and prompt');
    expect(calls.some((c) => c.method === 'createProductChange')).toBe(false);
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
