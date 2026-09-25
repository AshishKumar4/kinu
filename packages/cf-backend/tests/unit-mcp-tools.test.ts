// MCP write/act tools must reach the right @callable and share the read
// tools' auth + per-agent ownership gate.
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import type { JsonObject, JsonValue } from '@kinu.run/core';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { mcpAccount, unreachableKv } from './helpers/bindings';
import type { McpAgentClient, McpEnv } from '../src/mcp-server';

mockAgentsSdk();

const { handleMcpRequest } = await import('../src/mcp-server');

const USER_ID = '0123456789abcdef0123456789abcdef';

const SESSION_TOKEN = `ptc_${USER_ID}_abcdefghijklmnopqrstuvwxyz`;

const ACCESS_TOKEN = `pta_${USER_ID}_abcdefghijklmnopqrstuvwxyz012345`;

interface AgentCall { method: string; args: JsonValue[]; }

/** A write tool that reached a read surface must fail, not resolve against a stand-in. */
function unreached(member: string) {
  return (): never => { throw new Error(`OrchestratorAgent.${member}: not reachable in this test`); };
}

function mcpWorkspace() {
  const calls: AgentCall[] = [];
  const record = (method: string, ...args: JsonValue[]) => { calls.push({ method, args }); };

  const userDO = mcpAccount({
    async verifyCliToken(_caller, token: string) {
      return token === SESSION_TOKEN
        ? { ok: true, tokenHash: 'hash', user: { id: USER_ID, email: 'a@example.com', displayName: null } }
        : { ok: false, error: 'invalid token' };
    },
    async verifyAccessToken(_caller, token: string) {
      return token === ACCESS_TOKEN
        ? { ok: true, tokenHash: 'ahash', scopes: ['workspace.exec' as const], user: { id: USER_ID, email: 'a@example.com', displayName: null } }
        : { ok: false, error: 'invalid token' };
    },
    async hasWorkspace(_caller, name: string) { return name === 'jarvis'; },
    async ensureWorkspaceCapability() {},
  });

  const owner = {
    async claimOwner(userId: string) {
      record('claimOwner', userId);

      return { owner: userId, capabilityHash: 'sha-existing' };
    },
  };

  const tools: McpAgentClient = {
    searchMemoryHybrid: unreached('searchMemoryHybrid'),
    saveNoteFromMcp: unreached('saveNoteFromMcp'),
    getToolList: unreached('getToolList'),
    runScaffoldOnce: unreached('runScaffoldOnce'),
    getShadowStatus: unreached('getShadowStatus'),
    listRuns: unreached('listRuns'),
    getRunEvents: unreached('getRunEvents'),
    getMemoryContent: unreached('getMemoryContent'),
    async runTaskFromMcp(text) {
      record('runTaskFromMcp', text);

      return { status: 'queued' };
    },
    async sendPeerFromMcp(input) {
      record('sendPeerFromMcp', { ...input });

      if (input.agent === 'stranger') throw new Error('unknown peer "stranger" — list your team with action:"list"');

      return { status: 'delivered', message_id: 'evt_123' };
    },
    async listPeersFromMcp() {
      record('listPeersFromMcp');

      return [{ name: 'atlas', displayName: 'Atlas' }];
    },
  };

  const env: McpEnv<string> = {
    // Its presence makes an unauthenticated request a 401 rather than the 500 an
    // unconfigured deployment answers with.
    AUTH_KV: unreachableKv('AUTH_KV'),
    UserDO: { idFromName: (n) => n, get: () => userDO },
    OrchestratorAgent: { idFromName: (n) => n, get: () => owner },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  };

  return { env, calls, resolveAgent: () => Promise.resolve(tools) };
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

async function resultText(res: Response | null): Promise<string> {
  if (!res) throw new Error('Expected the MCP handler to return a response');
  const body = await res.text();
  const match = /"text":"((?:[^"\\]|\\.)*)"/.exec(body);

  return match?.[1] ? v.parse(v.string(), JSON.parse(`"${match[1]}"`)) : body;
}

describe('MCP write tools → real @callables', () => {
  // The tool handler runs while the SSE body is produced: read the body before
  // asserting on recorded @callable invocations.

  test('run_task invokes runTaskFromMcp and reports queued', async () => {
    const { env, calls, resolveAgent } = mcpWorkspace();

    const res = await handleMcpRequest(
      toolCall('jarvis', 'run_task', { text: '  ship it  ' }, SESSION_TOKEN), env, resolveAgent,
    );

    expect(res?.status).toBe(200);
    expect(await resultText(res)).toContain('queued');
    expect(calls.find((c) => c.method === 'runTaskFromMcp')?.args).toEqual(['  ship it  ']);
  });

  test('send_peer invokes sendPeerFromMcp and reports delivery', async () => {
    const { env, calls, resolveAgent } = mcpWorkspace();

    const res = await handleMcpRequest(
      toolCall('jarvis', 'send_peer', { agent: 'atlas', message: 'hi', topic: 'sync' }, SESSION_TOKEN),
      env, resolveAgent,
    );

    expect(res?.status).toBe(200);
    expect(await resultText(res)).toContain('delivered to atlas');
    expect(calls.find((c) => c.method === 'sendPeerFromMcp')?.args).toEqual([{ agent: 'atlas', message: 'hi', topic: 'sync' }]);
  });

  test('send_peer surfaces the DO roster/ownership rejection honestly', async () => {
    const { env, resolveAgent } = mcpWorkspace();

    const res = await handleMcpRequest(
      toolCall('jarvis', 'send_peer', { agent: 'stranger', message: 'hi' }, SESSION_TOKEN), env, resolveAgent,
    );

    expect(res?.status).toBe(200);
    expect(await resultText(res)).toContain('unknown peer');
  });

  test('list_peers invokes listPeersFromMcp', async () => {
    const { env, calls, resolveAgent } = mcpWorkspace();

    const res = await handleMcpRequest(
      toolCall('jarvis', 'list_peers', {}, SESSION_TOKEN), env, resolveAgent,
    );

    expect(res?.status).toBe(200);
    expect(await resultText(res)).toContain('atlas');
    expect(calls.some((c) => c.method === 'listPeersFromMcp')).toBe(true);
  });
});

describe('MCP write tools — auth + ownership gate (a scoped token cannot exceed its grant)', () => {
  test('scoped pta_ access token is refused before any write tool runs', async () => {
    const { env, calls, resolveAgent } = mcpWorkspace();

    const res = await handleMcpRequest(
      toolCall('jarvis', 'run_task', { text: 'go' }, ACCESS_TOKEN), env, resolveAgent,
    );

    expect(res?.status).toBe(403);
    expect(calls.some((c) => c.method === 'runTaskFromMcp')).toBe(false);
  });

  test('unowned agent is refused (404) before any write tool runs', async () => {
    const { env, calls, resolveAgent } = mcpWorkspace();

    const res = await handleMcpRequest(
      toolCall('not-mine', 'run_task', { text: 'go' }, SESSION_TOKEN), env, resolveAgent,
    );

    expect(res?.status).toBe(404);
    expect(calls.some((c) => c.method === 'runTaskFromMcp')).toBe(false);
  });

  test('no credentials → 401, no tool runs', async () => {
    const { env, calls, resolveAgent } = mcpWorkspace();

    const res = await handleMcpRequest(
      toolCall('jarvis', 'run_task', { text: 'go' }), env, resolveAgent,
    );

    expect(res?.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});
