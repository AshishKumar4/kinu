// Credential mutations must notify the user's active agents so each drops
// its cached provider/model state (orchestrator.onCredentialsChanged) —
// previously the hook existed but nothing ever invoked it.
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { describe, test, expect } from 'bun:test';
import { handleUserRequest } from '../src/user/routes';
import type { AuthIdentity } from '../src/auth/session';
import type { JsonValue } from '@kinu/core';

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
    async backfillWorkspaceCapabilities() { return { provisioned: 0 }; },
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
  const partialCtx: Partial<ExecutionContext> = {};
  Object.assign(partialCtx, {
    waitUntil(promise: Promise<unknown>) { pending.push(promise); },
  });
  // SAFETY: The constructed context provides the waitUntil method used here,
  // and that method is constructed immediately above with the tested queue.
  const ctx = partialCtx as ExecutionContext;
  const partialEnv: Partial<Env> = {};
  Object.assign(partialEnv, {
    UserDO: { idFromName: (n: string) => n, get: () => stub },
    OrchestratorAgent: {
      idFromName: (n: string) => n,
      get: (id: string) => ({ async onCredentialsChanged() { notified.push(id); return { ok: true }; } }),
    },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  });
  // SAFETY: The constructed environment provides the two locally owned
  // constructed namespaces and encryption key above; no other Env binding is
  // reachable in the fanout behavior exercised here.
  const env = partialEnv as Env;
  return { env, ctx, notified, pending };
}

async function call(env: Env, ctx: ExecutionContext, path: string, method: string, body?: JsonValue) {
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
