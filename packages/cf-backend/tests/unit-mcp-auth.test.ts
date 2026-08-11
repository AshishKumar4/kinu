// Behavior tests for the MCP server auth + ownership gate.
//
// /mcp/v1/<agentName> is routed BEFORE the browser-session gate (server.ts
// step 6b) because external MCP clients can't do browser OAuth — they
// authenticate with their per-user CLI bearer token, and every request runs
// the same ownership claim as the rest of the per-agent API.
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do.js';
import { describe, test, expect } from 'bun:test';
import { mockAgentsSdk } from './helpers/agents-sdk.js';

mockAgentsSdk();
const { handleMcpRequest } = await import('../src/mcp-server.js');

const USER_ID = '0123456789abcdef0123456789abcdef';
const TOKEN = `ptc_${USER_ID}_abcdefghijklmnopqrstuvwxyz`;

function mcpEnv() {
  const calls: string[] = [];
  const userDO = {
    async verifyCliToken(_caller: unknown, token: string) {
      return token === TOKEN
        ? { ok: true, tokenHash: 'hash', user: { id: USER_ID, email: 'a@example.com', displayName: null } }
        : { ok: false, error: 'invalid token' };
    },
    async hasWorkspace(_caller: unknown, name: string) { return name === 'jarvis'; },
    async ensureWorkspaceCapability() {},
  };
  const agent = {
    async claimOwner(userId: string) { calls.push(`claim:${userId}`); return { owner: userId, capabilityHash: 'sha-existing' }; },
  };
  const env = {
    // Present but never reached in these tests (no session cookie is sent);
    // its presence makes the unauthenticated path a clean AuthError 401.
    AUTH_DB: {},
    UserDO: { idFromName: (n: string) => n, get: () => userDO },
    OrchestratorAgent: { idFromName: (n: string) => n, get: () => agent }, CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY } as unknown as Env;
  return { env, calls };
}

function initializeRequest(agentName: string, token?: string) {
  return new Request(`https://proteus.example.com/mcp/v1/${agentName}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
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
    const { env, calls } = mcpEnv();
    const res = await handleMcpRequest(initializeRequest('jarvis', TOKEN), env);
    expect(res?.status).toBe(200);
    expect(calls).toContain(`claim:${USER_ID}`);
    expect(await res?.text()).toContain('"serverInfo"');
  });

  test('no credentials at all → 401', async () => {
    const { env } = mcpEnv();
    const res = await handleMcpRequest(initializeRequest('jarvis'), env);
    expect(res?.status).toBe(401);
  });

  test('invalid bearer token → 401', async () => {
    const { env, calls } = mcpEnv();
    const res = await handleMcpRequest(initializeRequest('jarvis', `ptc_${USER_ID}_zzzzzzzzzzzzzzzzzzzzzzzzzz`), env);
    expect(res?.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  test('valid token but agent not in caller registry → 404', async () => {
    const { env } = mcpEnv();
    const res = await handleMcpRequest(initializeRequest('not-mine', TOKEN), env);
    expect(res?.status).toBe(404);
  });

  test('non-MCP paths are ignored', async () => {
    const { env } = mcpEnv();
    const res = await handleMcpRequest(new Request('https://proteus.example.com/api/health'), env);
    expect(res).toBeNull();
  });
});
