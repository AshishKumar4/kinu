/**
 * The control-plane index learns a workspace exists only from an owned request: indexing before
 * `ensureAgentOwnership` let any signed-in user pollute the operator's workspaces list with invented names.
 * Driven through the real `server.ts` fetch entry, because the order is the substance.
 */
import { describe, expect, test } from 'bun:test';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { workerContext } from './helpers/bindings';
import type { PresentedCaller } from '@kinu.run/core/control-plane';
import { DEV_IDENTITY_HEADER, type UserCaller } from '@kinu.run/core';

mockAgentsSdk();

// Dynamic: a static import hoists above mockAgentsSdk(), and the entry's DO graph reaches `cloudflare:*`
// modules that exist only inside workerd.
const { default: worker } = await import('../src/server');

const APP_HOST = 'app.example.com';

// Not `owner@example.com`: the observe feed memoizes on the derived userId, and other suites prime that memo.
const OWNER_EMAIL = 'index-feed-owner@example.com';

const SECRET = 'index-feed-test-secret-0123456789';

/** Held the way the eval harness does, since the fixture drives a published (non-localhost) host. */
const DEV_IDENTITY_SECRET = 'index-feed-dev-identity-secret';

function appRequest(path: string): Request {
  return new Request(`https://${APP_HOST}${path}`, {
    headers: { [DEV_IDENTITY_HEADER]: DEV_IDENTITY_SECRET },
  });
}

interface IndexWrites {
  users: string[];
  workspaces: { userId: string; name: string }[];
}

/** The Worker with a recording control plane; CSRF, the index feed and the ownership check run as in production. */
function harness(owned: readonly string[]) {
  const index: IndexWrites = { users: [], workspaces: [] };

  const controlPlane = {
    idFromName: (name: string) => name,
    get: () => ({
      async observeUser(_caller: PresentedCaller, observation: { userId: string }) {
        index.users.push(observation.userId);
      },
      async observeWorkspace(_caller: PresentedCaller, observation: { userId: string; name: string }) {
        index.workspaces.push({ userId: observation.userId, name: observation.name });
      },
      async touchWorkspace(_caller: PresentedCaller, observation: { userId: string; name: string }) {
        index.workspaces.push({ userId: observation.userId, name: observation.name });
      },
    }),
  };

  const userDO = {
    idFromName: (name: string) => name,
    get: () => ({
      async hasWorkspace(_caller: UserCaller, name: string) { return owned.includes(name); },
      async ensureWorkspaceCapability() { /* the two sides already agree */ },
    }),
  };

  const orchestrator = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      async claimOwner(userId: string) {
        if (!owned.includes(name)) throw new Error('Agent owned by a different user');

        return { owner: userId, capabilityHash: null };
      },
    }),
  };

  const partialEnv: Partial<Env> = {};
  Object.assign(partialEnv, {
    CLI_PUBLIC_ORIGIN: `https://${APP_HOST}`,
    PREVIEW_HOST_SUFFIX: APP_HOST,
    DEV_USER_EMAIL: OWNER_EMAIL,
    DEV_IDENTITY_SECRET,
    CREDENTIAL_ENCRYPTION_KEY: SECRET,
    ControlPlaneDO: controlPlane,
    UserDO: userDO,
    OrchestratorAgent: orchestrator,
    ASSETS: { fetch: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }) },
  });
  // SAFETY: this fixture constructs every binding the path under test reads —
  // the dev identity, the control-plane namespace the index feed addresses, the
  // UserDO and OrchestratorAgent namespaces the ownership gate resolves, and
  // ASSETS for the SPA fallback an owned request falls through to.
  const env = partialEnv as Env;

  // Retained: the index feed writes inside `waitUntil`, so dropping the promise would pass any ordering.
  const ctx = workerContext();

  return {
    env,
    ctx,
    index,
    async settle(): Promise<void> { await Promise.allSettled(ctx.retained); },
  };
}

describe('the workspace index feed sits behind the ownership gate', () => {
  test('a request for a workspace the caller does not own writes no workspace row', async () => {
    const h = harness([]);
    const response = await worker.fetch(appRequest('/api/workspaces/not-mine/state'), h.env, h.ctx);
    await h.settle();

    expect(response.status).toBe(404);
    expect(h.index.workspaces).toEqual([]);
    // The account half still lands: a signed-in request does prove the account exists.
    expect(h.index.users.length).toBe(1);
  });

  test('a request for a workspace the caller owns writes it', async () => {
    const h = harness(['mine']);
    await worker.fetch(appRequest('/api/workspaces/mine/state'), h.env, h.ctx);
    await h.settle();

    expect(h.index.workspaces).toEqual([
      { userId: expect.stringMatching(/^[a-f0-9]{32}$/), name: 'mine' },
    ]);
  });

  test('an invented name in the same session never reaches the index', async () => {
    // One session, many names: each is a distinct memo key, so each would be a separate row.
    const h = harness(['mine']);

    for (const name of ['made-up-1', 'made-up-2', 'made-up-3']) {
      const response = await worker.fetch(appRequest(`/api/workspaces/${name}/state`), h.env, h.ctx);
      expect(response.status).toBe(404);
    }

    await h.settle();

    expect(h.index.workspaces).toEqual([]);
  });
});
