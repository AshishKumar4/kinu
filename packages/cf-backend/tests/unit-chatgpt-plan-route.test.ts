// A ChatGPT sign-in finishes on the owner's machine and tells nobody; the web's read that first sees it is the
// notice. That read reaches warm workspaces the way a credential write does (SIWC-08).
import { describe, expect, test } from 'bun:test';
import type { UserCaller } from '@kinu.run/core';
import { serveFamily } from './helpers/api';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { bootstrappedProfile, userAccount, workspaceObject } from './helpers/bindings';
import { userRoutes, type UserRoutesEnv } from '../src/user/routes';
import type { AuthIdentity } from '../src/auth/session';
import type { ChatGptPlanStatus } from '../src/user/user-do';

const IDENTITY: AuthIdentity = { userId: '0123456789abcdef0123456789abcdef', email: 'owner@example.com', sub: 'sub', provider: 'test', authTime: Date.now() };

const SIGNED_IN: ChatGptPlanStatus = {
  device: { id: 'dev-1', label: 'studio' },
  status: { signedIn: true, email: 'owner@example.com', planEnabled: true, planDeclined: false, pending: false, lastFailure: null, firstSignIn: true },
  account: null,
  machineSignIn: null,
  changed: true,
};

/** The web against a UserDO answering `answers` in turn; `notified` names each workspace told of a change. */
function web(answers: ChatGptPlanStatus[]) {
  const notified: string[] = [];
  const pending: Promise<unknown>[] = [];

  const stub = userAccount({
    async ensureProfile(_caller: UserCaller, email: string) { return bootstrappedProfile(email); },
    async userMcp_warmConnections() { return { servers: 0 }; },
    async listActiveWorkspaces() { return [{ name: 'jarvis', displayName: 'Jarvis', createdAt: 1, nameOrigin: 'user' as const }]; },
    async chatgptPlan() {
      const next = answers.shift();

      if (next === undefined) throw new Error('the web asked for the ChatGPT plan more often than the test answers');

      return next;
    },
  });

  const env: UserRoutesEnv<string> = {
    UserDO: { idFromName: (name) => name, get: () => stub },
    OrchestratorAgent: {
      idFromName: (name) => name,
      get: (id) => workspaceObject({
        async onModelSettingsChanged() {
          notified.push(id);

          return { ok: true as const };
        },
      }),
    },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  };

  const serve = serveFamily(userRoutes, { identity: IDENTITY, ctx: { waitUntil(promise: Promise<unknown>) { pending.push(promise); } } });

  const read = async (): Promise<number> => {
    const response = await serve(new Request('https://kinu.example.com/api/user/chatgpt'), env);

    await Promise.all(pending);

    return response?.status ?? 404;
  };

  return { read, notified };
}

describe('GET /api/user/chatgpt', () => {
  test('the read that first sees a machine\'s sign-in tells the warm workspaces, and the next read does not', async () => {
    const owner = web([SIGNED_IN, { ...SIGNED_IN, changed: false }]);

    expect(await owner.read()).toBe(200);
    expect(owner.notified).toEqual(['jarvis']);
    expect(await owner.read()).toBe(200);
    expect(owner.notified).toEqual(['jarvis']);
  });
});
