/**
 * The control-plane index learns a workspace exists only from an OWNED request.
 *
 * THE DEFECT THIS COVERS. The Worker used to observe the identity and the
 * workspace together, at the auth gate — before `ensureAgentOwnership`. So the
 * name in `/api/workspaces/<name>` was indexed on the strength of the caller
 * having typed it: any signed-in user could grow `ControlPlaneDO`'s SQLite index
 * and pollute the operator's cross-account workspaces list with names they do
 * not own, one row per invented string, and the 403 they earned changed nothing.
 * A request under that path proves a workspace is live only once the ownership
 * gate has agreed the caller has it.
 *
 * Driven through the real `server.ts` fetch entry, because the ORDER is the
 * substance. Every other way of asserting it — reading the source, calling
 * `observeWorkspaceUse` directly — would still be green if somebody moved the
 * call back above the gate.
 */
import { describe, expect, test } from 'bun:test';
import { mockAgentsSdk } from './helpers/agents-sdk';
import type { PresentedCaller } from '../src/control-plane/capability';
import type { UserCaller } from '../src/user/workspace-capability';

mockAgentsSdk();

// Dynamic: a static import hoists above mockAgentsSdk(), and the entry's whole
// DO graph reaches `cloudflare:*` modules that exist only inside workerd.
const { default: worker } = await import('../src/server');

const APP_HOST = 'app.example.com';
const OWNER_EMAIL = 'owner@example.com';
const SECRET = 'index-feed-test-secret-0123456789';
/** What a caller presents to act as `DEV_USER_EMAIL` on a host that is not
 *  localhost. The fixture drives a published host, so it holds the secret the
 *  way the staging eval harness does. */
const DEV_IDENTITY_SECRET = 'index-feed-dev-identity-secret';

/** A signed-in request to the app host, authenticated the one way this
 *  deployment shape allows. */
function appRequest(path: string): Request {
  return new Request(`https://${APP_HOST}${path}`, {
    headers: { 'x-kinu-dev-identity': DEV_IDENTITY_SECRET },
  });
}

/** What the control-plane index was told, in order. */
interface IndexWrites {
  users: string[];
  workspaces: { userId: string; name: string }[];
}

/**
 * The Worker, with a control plane that records what it is told and a UserDO
 * whose roster decides who owns what.
 *
 * `DEV_USER_EMAIL` names the identity a request authenticates as without a
 * session store, and `DEV_IDENTITY_SECRET` is what a caller on a published host
 * presents to hold it. Every gate after that — CSRF, the index feed, the
 * ownership check — runs exactly as it does in production.
 */
function harness(owned: readonly string[]) {
  const index: IndexWrites = { users: [], workspaces: [] };
  const retained: Promise<unknown>[] = [];

  const controlPlane = {
    idFromName: (name: string) => name,
    get: () => ({
      async observeUser(_caller: PresentedCaller, observation: { userId: string }) {
        index.users.push(observation.userId);
      },
      async observeWorkspace(_caller: PresentedCaller, observation: { userId: string; name: string }) {
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

  const partialCtx: Partial<ExecutionContext> = {};
  Object.assign(partialCtx, {
    // Retained rather than dropped: the index feed writes inside `waitUntil`, so
    // a fixture that discarded the promise would report "no row written" for
    // every request and pass whatever the ordering was.
    waitUntil(promise: Promise<unknown>) { retained.push(promise); },
    passThroughOnException() {},
  });
  // SAFETY: constructs both ExecutionContext methods, which is the whole surface
  // this path uses.
  const ctx = partialCtx as ExecutionContext;

  return {
    env,
    ctx,
    index,
    async settle(): Promise<void> { await Promise.allSettled(retained); },
  };
}

describe('the workspace index feed sits behind the ownership gate', () => {
  test('a request for a workspace the caller does not own writes no workspace row', async () => {
    const h = harness([]);
    const response = await worker.fetch(appRequest('/api/workspaces/not-mine/state'), h.env, h.ctx);
    await h.settle();

    // Refused, and the refusal is the point: the name was never the caller's.
    expect(response.status).toBe(404);
    expect(h.index.workspaces).toEqual([]);
    // The ACCOUNT half still lands. A signed-in request does prove the account
    // exists and was here, which is what that feed is for.
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
    // The shape that made this exploitable: one signed-in session, many names.
    // Each one is a distinct memo key, so each one used to be a separate row.
    const h = harness(['mine']);
    for (const name of ['made-up-1', 'made-up-2', 'made-up-3']) {
      const response = await worker.fetch(appRequest(`/api/workspaces/${name}/state`), h.env, h.ctx);
      expect(response.status).toBe(404);
    }
    await h.settle();

    expect(h.index.workspaces).toEqual([]);
  });
});
