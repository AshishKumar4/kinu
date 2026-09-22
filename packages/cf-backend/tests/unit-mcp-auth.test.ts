// /mcp/v1/<agentName> is routed before the browser-session gate (server.ts step 6b): external MCP clients authenticate
// with their CLI bearer token and run the same ownership claim as the rest of the per-agent API.
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { describe, test, expect } from 'bun:test';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { mcpAccount, unreachableKv } from './helpers/bindings';
import type { McpAgentClient, McpEnv } from '../src/mcp-server';

mockAgentsSdk();

const { handleMcpRequest } = await import('../src/mcp-server');

const USER_ID = '0123456789abcdef0123456789abcdef';

const TOKEN = `ptc_${USER_ID}_abcdefghijklmnopqrstuvwxyz`;

function mcpWorkspace() {
  const calls: string[] = [];

  const userDO = mcpAccount({
    async verifyCliToken(_caller, token: string) {
      return token === TOKEN
        ? { ok: true, tokenHash: 'hash', user: { id: USER_ID, email: 'a@example.com', displayName: null } }
        : { ok: false, error: 'invalid token' };
    },
    async hasWorkspace(_caller, name: string) { return name === 'jarvis'; },
    async ensureWorkspaceCapability() {},
  });

  const agent = {
    async claimOwner(userId: string) {
      calls.push(`claim:${userId}`);

      return { owner: userId, capabilityHash: 'sha-existing' };
    },
  };

  const env: McpEnv<string> = {
    // Its presence makes an unauthenticated request a 401 rather than the unconfigured deployment's 500.
    AUTH_KV: unreachableKv('AUTH_KV'),
    UserDO: { idFromName: (n) => n, get: () => userDO },
    OrchestratorAgent: { idFromName: (n) => n, get: () => agent },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  };

  // Every case stops at the gate, so resolving the tool surface is itself the failure.
  const resolveAgent = (name: string): Promise<McpAgentClient> => {
    throw new Error(`OrchestratorAgent.${name}: the MCP tool surface is not reachable in this test`);
  };

  return { env, calls, resolveAgent };
}

function initializeRequest(agentName: string, token?: string) {
  const headers = new Headers({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  });

  if (token) headers.set('authorization', `Bearer ${token}`);

  return new Request(`https://kinu.example.com/mcp/v1/${agentName}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    }),
  });
}

describe('MCP server auth gate', () => {
  test('valid CLI bearer token + owned agent → MCP initialize succeeds', async () => {
    const { env, calls, resolveAgent } = mcpWorkspace();
    const res = await handleMcpRequest(initializeRequest('jarvis', TOKEN), env, resolveAgent);
    expect(res?.status).toBe(200);
    expect(calls).toContain(`claim:${USER_ID}`);
    expect(await res?.text()).toContain('"serverInfo"');
  });

  test('no credentials at all → 401', async () => {
    const { env, resolveAgent } = mcpWorkspace();
    const res = await handleMcpRequest(initializeRequest('jarvis'), env, resolveAgent);
    expect(res?.status).toBe(401);
  });

  test('invalid bearer token → 401', async () => {
    const { env, calls, resolveAgent } = mcpWorkspace();

    const res = await handleMcpRequest(
      initializeRequest('jarvis', `ptc_${USER_ID}_zzzzzzzzzzzzzzzzzzzzzzzzzz`), env, resolveAgent,
    );

    expect(res?.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  test('valid token but agent not in caller registry → 404', async () => {
    const { env, resolveAgent } = mcpWorkspace();
    const res = await handleMcpRequest(initializeRequest('not-mine', TOKEN), env, resolveAgent);
    expect(res?.status).toBe(404);
  });

  test('non-MCP paths are ignored', async () => {
    const { env, resolveAgent } = mcpWorkspace();
    const res = await handleMcpRequest(new Request('https://kinu.example.com/api/health'), env, resolveAgent);
    expect(res).toBeNull();
  });
});
