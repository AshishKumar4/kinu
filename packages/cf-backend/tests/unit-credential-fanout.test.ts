// Credential mutations must notify the user's active agents so each drops
// its cached provider/model state (orchestrator.onCredentialsChanged) —
// previously the hook existed but nothing ever invoked it.
import { describe, test, expect } from 'bun:test';
import { handleUserRequest } from '../src/user/routes.js';
import type { AuthIdentity } from '../src/auth/session.js';

const IDENTITY: AuthIdentity = {
  userId: '0123456789abcdef0123456789abcdef',
  email: 'ashish@example.com',
  sub: 'sub',
  provider: 'test',
  authTime: Date.now(),
};

function setup() {
  const notified: string[] = [];
  const stub = {
    async ensureProfile() {},
    async userMcp_warmConnections() { return { servers: 0 }; },
    async setCredential() {},
    async deleteCredential() {},
    async disconnectCodex() {},
    async pollCodexDeviceFlow() { return { connected: true, accountId: 'acc' }; },
    async listWorkspaces() {
      return [
        { name: 'jarvis', displayName: 'Jarvis', createdAt: 1, lastVisited: 1, archivedAt: null },
        { name: 'old-bot', displayName: 'Old', createdAt: 1, lastVisited: 1, archivedAt: 123 },
      ];
    },
  };
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;
  const env = {
    UserDO: { idFromName: (n: string) => n, get: () => stub },
    OrchestratorAgent: {
      idFromName: (n: string) => n,
      get: (id: unknown) => ({ async onCredentialsChanged() { notified.push(String(id)); return { ok: true }; } }),
    },
  } as unknown as Env;
  return { env, ctx, notified, pending };
}

async function call(env: Env, ctx: ExecutionContext, path: string, method: string, body?: unknown) {
  return handleUserRequest(new Request(`https://proteus.example.com/api/user${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, IDENTITY, ctx);
}

describe('credential-change fanout to agent DOs', () => {
  test('setting a credential notifies active agents only', async () => {
    const { env, ctx, notified, pending } = setup();
    const res = await call(env, ctx, '/credentials/openai.api', 'POST', { kind: 'bearer', token: 'sk-x' });
    expect(res?.status).toBe(200);
    await Promise.all(pending);
    expect(notified).toEqual(['jarvis']); // archived old-bot untouched
  });

  test('deleting a credential notifies agents', async () => {
    const { env, ctx, notified, pending } = setup();
    await call(env, ctx, '/credentials/openai.api', 'DELETE');
    await Promise.all(pending);
    expect(notified).toEqual(['jarvis']);
  });

  test('codex disconnect and successful poll notify agents', async () => {
    const { env, ctx, notified, pending } = setup();
    await call(env, ctx, '/codex', 'DELETE');
    await call(env, ctx, '/codex/poll', 'POST', {});
    await Promise.all(pending);
    expect(notified).toEqual(['jarvis', 'jarvis']);
  });
});
