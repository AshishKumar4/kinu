// The role a create request asks for, and where it lands.
//
// `POST /workspaces` accepts a `role` on both transports, `kinu create --role`
// sends one (`cli/src/agent-create.ts`), and `createCloudWorkspaceForUser`
// selects it on the new workspace before its first turn. The hop between the
// parsed request and the create input is a mapping, and until that mapping was
// named the field crossed by structural accident alone — which `gate:wired`
// reported as a wire read at one end and connected at neither.
import { describe, expect, test } from 'bun:test';
import { asFetchFunction } from '@kinu.run/core';
import { handleCreateWorkspaceRequest } from '../src/user/workspace-access';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import type { UserCaller } from '../src/user/workspace-capability';

const USER_ID = '0123456789abcdef0123456789abcdef';
const AGENT = 'jarvis';

interface CreateBody {
  name: string;
  purpose: string;
  role?: string;
}

/** One `POST /workspaces`, and every RPC the new workspace received in order.
 *
 *  The whole route is driven rather than `createCloudWorkspaceForUser` alone,
 *  because the request-body-to-input mapping is the thing under test and
 *  calling the create directly would step over it. */
async function postCreate(body: CreateBody): Promise<{ status: number; calls: string[] }> {
  const calls: string[] = [];
  const userDO = {
    async getConfig(_caller: UserCaller) { return null; },
    async getAuthHeaders(_caller: UserCaller) { return { authorization: 'Bearer token' }; },
    async getCredentialBaseURL(_caller: UserCaller) {
      return 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1';
    },
    async listCredentials(_caller: UserCaller) { return []; },
    async ensureWorkspaceCapability() {},
    async registerWorkspace(_caller: UserCaller, name: string, displayName?: string) {
      return {
        entry: { name, displayName: displayName ?? name, createdAt: 7, lastVisited: 7, archivedAt: null },
        existed: false,
      };
    },
    async releaseWorkspaceReservation() { return true; },
    async removeWorkspace() {},
  };
  const orchestrator = {
    async claimOwner(userId: string) { return { owner: userId, capabilityHash: null }; },
    async setInitialDisplayName() {},
    async setSoul() {},
    async resetWorkspaceBaseline() {},
    async setModel() {},
    async setRole(roleId: string) { calls.push(`role:${roleId}`); return { role: roleId }; },
    async beginGenesisTurn() { calls.push('genesis'); },
  };
  const env: Partial<Env> = {};
  Object.assign(env, {
    UserDO: { idFromName: (name: string) => name, get: () => userDO },
    OrchestratorAgent: { idFromName: (name: string) => name, get: () => orchestrator },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  });
  // SAFETY: Workspace creation reads exactly the constructed UserDO and
  // OrchestratorAgent namespaces plus credential key. Every typed binding
  // reachable in this test is present.
  const typed = env as Env;

  const originalFetch = globalThis.fetch;
  // No provider is reachable, so the model menu falls back to the native
  // Workers AI default — which is what a create resolves to in production too.
  globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));
  try {
    const response = await handleCreateWorkspaceRequest(
      new Request('https://kinu.run/api/user/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      typed,
      USER_ID,
      typed.UserDO.get(typed.UserDO.idFromName(USER_ID)),
    );
    return { status: response.status, calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('the role a create request asks for', () => {
  test('reaches the new workspace, before its first turn runs', async () => {
    const created = await postCreate({ name: AGENT, purpose: 'Review the checkout flow.', role: 'auditor' });

    expect(created.status).toBe(201);
    expect(created.calls).toContain('role:auditor');
    // Ordering, not just presence: the genesis turn has to run UNDER the role
    // the request chose, so a role applied after it would be a turn that ran
    // as something else.
    expect(created.calls.indexOf('role:auditor')).toBeLessThan(created.calls.indexOf('genesis'));
  });

  test('is left alone when the request names none', async () => {
    const created = await postCreate({ name: AGENT, purpose: 'Review the checkout flow.' });

    expect(created.status).toBe(201);
    expect(created.calls).toEqual(['genesis']);
  });

  test('selects nothing when the request names the default role', async () => {
    // 'general' is where a workspace already starts, so asking for it is not a
    // selection and must not spend an RPC changing the role to itself.
    const created = await postCreate({ name: AGENT, purpose: 'Review the checkout flow.', role: 'general' });

    expect(created.status).toBe(201);
    expect(created.calls).toEqual(['genesis']);
  });
});
