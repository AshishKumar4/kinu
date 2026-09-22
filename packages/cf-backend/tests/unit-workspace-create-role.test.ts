// The requested `role` must cross the named request-to-input mapping and be selected before the first turn;
// crossing by structural accident is what `gate:wired` reported.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  asFetchFunction, BUILTIN_PROFILE_CATALOG, DEFAULT_WORKERS_AI_MODEL_SPEC, profileCatalogDigest,
  resolveTurnProfile, workspaceSlug, type ProfileCatalog, type ProfileCatalogEnvelope,
} from '@kinu.run/core';
import { handleCreateWorkspaceRequest, type CreateWorkspaceEnv } from '../src/user/workspace-access';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { userAccount, workspaceObject } from './helpers/bindings';
import type { NameOrigin, ReasoningEffort, UserCaller } from '@kinu.run/core';

const USER_ID = '0123456789abcdef0123456789abcdef';

const AGENT = 'jarvis';

/** Not the native default, so a create landing on it must have read the catalog. */
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

/** The whole route is driven because the request-body-to-input mapping is under test. */
async function postCreate(
  body: CreateBody,
  envelope: ProfileCatalogEnvelope = envelopeWithDefault(DEFAULT_WORKERS_AI_MODEL_SPEC),
): Promise<{ status: number; calls: string[]; error: string | null }> {
  const calls: string[] = [];

  const userDO = userAccount({
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
  });

  const orchestrator = workspaceObject({
    async claimOwner(userId: string) { return { owner: userId, capabilityHash: null }; },
    async setInitialDisplayName(displayName: string, nameOrigin: NameOrigin) { return { displayName, nameOrigin }; },
    async setSoul(soul: string) { return { soul, purpose: '' }; },
    async resetWorkspaceBaseline() { return { ok: true as const, files: 0 }; },
    async setModel(spec: string) {
      calls.push(`model:${spec}`);

      return { ok: true, spec };
    },
    async setReasoningEffort(effort: ReasoningEffort | null) {
      calls.push(`effort:${String(effort)}`);

      if (effort === null) throw new Error('setReasoningEffort(null): a create never clears the effort');

      return { ok: true as const, effort };
    },
    async setRole(roleId: string) {
      calls.push(`role:${roleId}`);

      return { role: roleId };
    },
    async beginGenesisTurn() {
      calls.push('genesis');

      return { started: true };
    },
  });

  const env: CreateWorkspaceEnv<string> = {
    UserDO: { idFromName: (name) => name, get: () => userDO },
    OrchestratorAgent: { idFromName: (name) => name, get: () => orchestrator },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  };

  const originalFetch = globalThis.fetch;
  // No reachable provider: the menu falls back to the native Workers AI default, as production creates do.
  globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));

  try {
    const response = await handleCreateWorkspaceRequest({
      request: new Request('https://kinu.run/api/user/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
      userId: USER_ID,
      userDO,
    });

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
    // Ordering: the genesis turn must run under the chosen role.
    expect(created.calls.indexOf('role:auditor')).toBeLessThan(created.calls.indexOf('genesis'));
  });

  test('is left alone when the request names none', async () => {
    const created = await postCreate({ name: AGENT, purpose: 'Review the checkout flow.' });

    expect(created.status).toBe(201);
    expect(created.calls).toEqual([`model:${DEFAULT_WORKERS_AI_MODEL_SPEC}`, 'genesis']);
  });

  test('selects nothing when the request names the default role', async () => {
    // 'task' is the starting role, so asking for it must not spend an RPC.
    const created = await postCreate({ name: AGENT, purpose: 'Review the checkout flow.', role: 'task' });

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
    // One default, read from one place (#6): a new workspace starts on the model the resolver hands every turn.
    const envelope = envelopeWithDefault(CATALOG_DEFAULT);
    const created = await postCreate({ name: AGENT, purpose: 'Review the checkout flow.' }, envelope);

    expect(created.status).toBe(201);
    expect(created.calls).toContain(`model:${CATALOG_DEFAULT}`);

    const turn = resolveTurnProfile({
      envelope,
      provider: { revision: 'r1', availableModels: [CATALOG_DEFAULT] },
      roleId: 'task',
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
