/**
 * The overview must be refused at the shared ownership gate before the overview
 * RPC is asked; driven end-to-end because the order is the substance.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { WorkspaceOverviewSchema } from '@kinu.run/core';
import type { PresentedCaller } from '@kinu.run/core/control-plane';
import { makeEnv } from './helpers/actor-harness';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { workerContext } from './helpers/bindings';
import { createTestUserDO, provisionTestWorkspace, TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';

mockAgentsSdk();

// Dynamic: a static import hoists above mockAgentsSdk(), and the DO graph
// reaches `cloudflare:*` modules that exist only inside workerd.
const { default: worker } = await import('../src/server');

const APP_HOST = 'app.example.com';

const OWNER_EMAIL = 'owner@example.com';

const DEV_IDENTITY_SECRET = 'overview-dev-identity-secret';

/** `forgedUserId` smuggles the Worker-stamped header; the route must answer for the verified identity. */
function appRequest(path: string, forgedUserId?: string): Request {
  const headers = new Headers({ 'x-kinu-dev-identity': DEV_IDENTITY_SECRET });

  if (forgedUserId !== undefined) headers.set('x-kinu-user-id', forgedUserId);

  return new Request(`https://${APP_HOST}${path}`, { headers });
}

const OVERVIEW = {
  observedAt: 1, activity: 'idle', decisionsWaiting: 3, hasUpdates: true,
  latestRun: { status: 'completed', task: 'the last thing' }, primarySlate: null,
};

async function harness(opts: {
  readonly owned: readonly string[];
  readonly claimOwners?: Record<string, string>;
  readonly overviewError?: string;
}) {
  const calls: { method: string; workspace: string; userId?: string }[] = [];
  const ctx = workerContext();

  const controlPlane = {
    idFromName: (name: string) => name,
    get: () => ({
      async observeUser(_caller: PresentedCaller, _observation: { userId: string }) {},
      async observeWorkspace(_caller: PresentedCaller, _observation: { userId: string; name: string }) {},
      async touchWorkspace(_caller: PresentedCaller, _observation: { userId: string; name: string }) {},
    }),
  };

  const user = createTestUserDO({ credentialEncryptionKey: TEST_CREDENTIAL_ENCRYPTION_KEY });

  for (const name of opts.owned) await provisionTestWorkspace(user, name);

  // The object half stays a recording stub: the call order is observable only in its log.
  const orchestrator = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      async claimOwner(userId: string) {
        calls.push({ method: 'claimOwner', workspace: name, userId });

        const owner = opts.claimOwners?.[name] ?? userId;

        if (owner !== userId) throw new Error('Agent owned by a different user');

        return { owner: userId, capabilityHash: null };
      },
      async getWorkspaceOverview() {
        calls.push({ method: 'getWorkspaceOverview', workspace: name });

        if (opts.overviewError) throw new Error(opts.overviewError);

        return OVERVIEW;
      },
    }),
  };

  const env = makeEnv(undefined, undefined, { userDO: user.userDO });

  Object.assign(env, {
    CLI_PUBLIC_ORIGIN: `https://${APP_HOST}`,
    PREVIEW_HOST_SUFFIX: APP_HOST,
    DEV_USER_EMAIL: OWNER_EMAIL,
    DEV_IDENTITY_SECRET,
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    ControlPlaneDO: controlPlane,
    OrchestratorAgent: orchestrator,
    ASSETS: { fetch: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }) },
  });

  return {
    env,
    ctx,
    calls,
    async settle(): Promise<void> { await Promise.allSettled(ctx.retained); },
  };
}

describe('the workspace overview route', () => {
  test('the owner gets the overview, answered against the shared schema', async () => {
    const h = await harness({ owned: ['jarvis'] });

    const res = await worker.fetch(appRequest('/api/workspaces/jarvis/overview'), h.env, h.ctx);

    expect(res.status).toBe(200);

    const body = v.parse(WorkspaceOverviewSchema, await res.json());

    expect(body.decisionsWaiting).toBe(3);
    expect(body.latestRun?.task).toBe('the last thing');
    expect(h.calls.map((c) => c.method)).toEqual(['claimOwner', 'getWorkspaceOverview']);
  });

  test('a roster row naming somebody else\'s object dies at claimOwner — the overview is never asked', async () => {
    const h = await harness({ owned: ['jarvis'], claimOwners: { jarvis: 'b'.repeat(32) } });

    const res = await worker.fetch(appRequest('/api/workspaces/jarvis/overview'), h.env, h.ctx);

    expect(res.status).toBe(403);
    expect(h.calls.map((c) => c.method)).toEqual(['claimOwner']);
  });

  test('a name nobody registered is a 404 before any object wakes', async () => {
    const h = await harness({ owned: [] });

    const res = await worker.fetch(appRequest('/api/workspaces/ghost/overview'), h.env, h.ctx);

    expect(res.status).toBe(404);
    expect(h.calls).toEqual([]);
  });

  test('a forged user header cannot mint ownership the gate already denied', async () => {
    // A fresh name: a proven membership skips the registry read this case needs.
    const h = await harness({ owned: [] });

    const res = await worker.fetch(
      appRequest('/api/workspaces/forge-ghost/overview', 'f'.repeat(32)), h.env, h.ctx,
    );

    expect(res.status).toBe(404);
    expect(h.calls).toEqual([]);
  });

  test('a forged user header on an OWNED name is rewritten to the verified identity', async () => {
    const h = await harness({ owned: ['jarvis'] });

    const res = await worker.fetch(
      appRequest('/api/workspaces/jarvis/overview', 'f'.repeat(32)), h.env, h.ctx,
    );

    expect(res.status).toBe(200);
    expect(h.calls[0]?.userId).toMatch(/^[a-f0-9]{32}$/);
    expect(h.calls[0]?.userId).not.toBe('f'.repeat(32));
  });

  test('a failing overview read propagates as a 500, not a zeroed card', async () => {
    const h = await harness({ owned: ['jarvis'], overviewError: 'the consent store is unreadable' });

    const res = await worker.fetch(appRequest('/api/workspaces/jarvis/overview'), h.env, h.ctx);

    expect(res.status).toBe(500);

    const body = v.parse(v.object({ error: v.string() }), await res.json());

    expect(body.error).toContain('consent store');
    expect(h.calls.map((c) => c.method)).toEqual(['claimOwner', 'getWorkspaceOverview']);
  });
});
