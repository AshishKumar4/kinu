// Credential mutations must notify the user's active agents so each drops
// its cached provider/model state (orchestrator.onCredentialsChanged) — a
// hook nothing invokes leaves every live agent on a stale catalog.
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { describe, test, expect } from 'bun:test';
import { handleUserRequest, type UserRoutesEnv } from '../src/user/routes';
import { bootstrappedProfile, userAccount, workspaceObject } from './helpers/bindings';
import type { UserCaller } from '@kinu.run/core';
import type { AuthIdentity } from '../src/auth/session';
import type { JsonValue } from '@kinu.run/core';

const IDENTITY: AuthIdentity = {
  userId: '0123456789abcdef0123456789abcdef',
  email: 'ashish@example.com',
  sub: 'sub',
  provider: 'test',
  authTime: Date.now(),
};

function setup() {
  const notified: string[] = [];

  const stub = userAccount({
    async ensureProfile(_caller: UserCaller, email: string) { return bootstrappedProfile(email); },
    async userMcp_warmConnections() { return { servers: 0 }; },
    async setCredential() {},
    async deleteCredential() {},
    async disconnectCodex() {},
    async pollCodexDeviceFlow() { return { connected: true, accountId: 'acc' }; },
    async listActiveWorkspaces() {
      return [
        { name: 'jarvis', displayName: 'Jarvis', createdAt: 1, nameOrigin: 'user' as const },
        { name: 'old-bot', displayName: 'Old', createdAt: 2, nameOrigin: 'user' as const },
      ];
    },
  });

  // The route hands the fan-out to `waitUntil` and calls nothing else on the
  // context, so the suite holds the promises and joins them at the assertion.
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil(promise: Promise<unknown>) { pending.push(promise); } };

  const env: UserRoutesEnv<string> = {
    UserDO: { idFromName: (n) => n, get: () => stub },
    OrchestratorAgent: {
      idFromName: (n) => n,
      get: (id) => workspaceObject({
        async onCredentialsChanged() {
          notified.push(id);

          return { ok: true as const };
        },
      }),
    },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  };

  return { env, ctx, notified, pending };
}

interface UserApiCall {
  readonly env: UserRoutesEnv<string>;
  readonly ctx: Pick<ExecutionContext, 'waitUntil'>;
  readonly path: string;
  readonly method: string;
  readonly body?: JsonValue;
}

async function call({ env, ctx, path, method, body }: UserApiCall) {
  return handleUserRequest(new Request(`https://kinu.example.com/api/user${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, IDENTITY, ctx);
}

describe('credential-change fanout to agent DOs', () => {
  test('setting a credential notifies every enumerated agent', async () => {
    const { env, ctx, notified, pending } = setup();
    const res = await call({ env, ctx, path: '/credentials/openai.api', method: 'POST', body: { kind: 'bearer', token: 'sk-x' } });
    expect(res?.status).toBe(200);
    await Promise.all(pending);
    expect(notified).toEqual(['jarvis', 'old-bot']);
  });

  test('deleting a credential notifies agents', async () => {
    const { env, ctx, notified, pending } = setup();
    await call({ env, ctx, path: '/credentials/openai.api', method: 'DELETE' });
    await Promise.all(pending);
    expect(notified).toEqual(['jarvis', 'old-bot']);
  });

  test('codex disconnect and successful poll notify agents', async () => {
    const { env, ctx, notified, pending } = setup();
    await call({ env, ctx, path: '/codex', method: 'DELETE' });
    await call({ env, ctx, path: '/codex/poll', method: 'POST', body: {} });
    await Promise.all(pending);
    expect(notified).toEqual(['jarvis', 'old-bot', 'jarvis', 'old-bot']);
  });
});
