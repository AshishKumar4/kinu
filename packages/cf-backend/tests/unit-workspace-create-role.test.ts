// The role a create request asks for, and where it lands.
//
// `POST /workspaces` accepts a `role` on both transports, `kinu create --role`
// sends one (`cli/src/agent-create.ts`), and `createCloudWorkspaceForUser`
// selects it on the new workspace before its first turn. The hop between the
// parsed request and the create input is a mapping, and until that mapping was
// named the field crossed by structural accident alone — which `gate:wired`
// reported as a wire read at one end and connected at neither.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  asFetchFunction, BUILTIN_PROFILE_CATALOG, DEFAULT_WORKERS_AI_MODEL_SPEC, profileCatalogDigest,
  resolveTurnProfile, workspaceSlug, type ProfileCatalog, type ProfileCatalogEnvelope,
} from '@kinu.run/core';
import { handleCreateWorkspaceRequest } from '../src/user/workspace-access';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import type { UserCaller } from '../src/user/workspace-capability';

const USER_ID = '0123456789abcdef0123456789abcdef';
const AGENT = 'jarvis';
/** A Workers AI model the offline menu still lists, and not the native default,
 *  so a create that lands on it must have READ the catalog. */
const CATALOG_DEFAULT = 'workers-ai/@cf/moonshotai/kimi-k2.6';

function envelopeWithDefault(model: string): ProfileCatalogEnvelope {
  const catalog: ProfileCatalog = { ...BUILTIN_PROFILE_CATALOG, tiers: { default: { model } } };
  return { authority: { kind: 'account', accountId: USER_ID }, version: 1, digest: profileCatalogDigest(catalog), catalog };
}

interface CreateBody {
  name: string;
  purpose: string;
  role?: string;
  model?: string;
  reasoningEffort?: string;
}

/** One `POST /workspaces`, and every RPC the new workspace received in order.
 *  The whole route is driven rather than `createCloudWorkspaceForUser` alone,
 *  because the request-body-to-input mapping is the thing under test and
 *  calling the create directly would step over it. */
async function postCreate(
  body: CreateBody,
  envelope: ProfileCatalogEnvelope = envelopeWithDefault(DEFAULT_WORKERS_AI_MODEL_SPEC),
): Promise<{ status: number; calls: string[]; error: string | null }> {
  const calls: string[] = [];
  const userDO = {
    async getProfileCatalog(_caller: UserCaller) { return envelope; },
    async getAuthHeaders(_caller: UserCaller) { return { authorization: 'Bearer token' }; },
    async getCredentialBaseURL(_caller: UserCaller) {
      return 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1';
    },
    async listCredentials(_caller: UserCaller) { return []; },
    async ensureWorkspaceCapability() {},
    async registerWorkspace(_caller: UserCaller, name: string, displayName?: string) {
      return {
        entry: { name, displayName: displayName ?? name, createdAt: 7, lastVisited: 7, archivedAt: null },
        status: 'created' as const,
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
    async setModel(model: string) { calls.push(`model:${model}`); },
    async setReasoningEffort(effort: string) { calls.push(`effort:${effort}`); },
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
    const error = response.ok ? null : v.parse(v.object({ error: v.string() }), await response.json()).error;
    return { status: response.status, calls, error };
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
    expect(created.calls).toEqual([`model:${DEFAULT_WORKERS_AI_MODEL_SPEC}`, 'genesis']);
  });

  test('selects nothing when the request names the default role', async () => {
    // 'general' is where a workspace already starts, so asking for it is not a
    // selection and must not spend an RPC changing the role to itself.
    const created = await postCreate({ name: AGENT, purpose: 'Review the checkout flow.', role: 'general' });

    expect(created.status).toBe(201);
    expect(created.calls).toEqual([`model:${DEFAULT_WORKERS_AI_MODEL_SPEC}`, 'genesis']);
  });
});

describe('the model and effort a create request asks for', () => {
  test('a supplied model short-circuits the catalog default', async () => {
    const created = await postCreate(
      { name: AGENT, purpose: 'Review the checkout flow.', model: DEFAULT_WORKERS_AI_MODEL_SPEC },
      envelopeWithDefault(CATALOG_DEFAULT),
    );

    expect(created.status).toBe(201);
    expect(created.calls).toContain(`model:${DEFAULT_WORKERS_AI_MODEL_SPEC}`);
  });

  test('the catalog default tier is the model a new workspace starts on, and the one its turns resolve', async () => {
    // ONE default, read from one place. The settings page once had a second
    // "default model for new workspaces" beside the tier catalog's `default`,
    // stored under its own config key; the two drifted (#6). A new workspace
    // now starts on the same model the resolver hands every turn.
    const envelope = envelopeWithDefault(CATALOG_DEFAULT);
    const created = await postCreate({ name: AGENT, purpose: 'Review the checkout flow.' }, envelope);

    expect(created.status).toBe(201);
    expect(created.calls).toContain(`model:${CATALOG_DEFAULT}`);
    const turn = resolveTurnProfile({
      envelope,
      provider: { revision: 'r1', availableModels: [CATALOG_DEFAULT] },
      roleId: 'general',
      workMode: 'build',
      availableTools: [],
      activeSkills: [],
    });
    expect(turn.tier.model).toBe(CATALOG_DEFAULT);
  });

  test('effort reaches the new workspace, before its first turn runs', async () => {
    const created = await postCreate({ name: AGENT, purpose: 'Review the checkout flow.', reasoningEffort: 'high' });

    expect(created.status).toBe(201);
    expect(created.calls).toContain('effort:high');
    expect(created.calls.indexOf('effort:high')).toBeLessThan(created.calls.indexOf('genesis'));
  });

  test('an unknown effort is a bad request, not a workspace', async () => {
    const created = await postCreate({ name: AGENT, purpose: 'Review the checkout flow.', reasoningEffort: 'ultra' });

    expect(created.status).toBe(400);
    expect(created.calls).not.toContain('genesis');
  });
});

describe('the name a create request asks for', () => {
  test('a name no preview hostname can carry is refused with the limit, before a workspace exists', async () => {
    const name = 'a'.repeat(32);
    const created = await postCreate({ name, purpose: 'Review the checkout flow.' });

    expect(created.status).toBe(400);
    expect(created.error).toContain('31');
    expect(created.calls).toEqual([]);
  });

  test('a generated address always fits', async () => {
    const created = await postCreate({ name: workspaceSlug(crypto.randomUUID()), purpose: 'Review the checkout flow.' });
    expect(created.status).toBe(201);
  });
});
