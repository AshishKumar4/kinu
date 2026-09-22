import { createTestUserDO, TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { afterEach, describe, expect, test } from 'bun:test';
import { asFetchFunction, BUILTIN_PROFILE_CATALOG, profileCatalogDigest, type ProfileCatalogEnvelope } from '@kinu.run/core';
import { createRecordingLogger, setDiagnosticsSink } from '@kinu.run/core/obs';
import { testOwner } from './helpers/user-do';
import { handleUserRequest } from '../src/user/routes';
import { createCloudWorkspaceForUser } from '../src/user/workspace-create';
import { claimOwnedWorkspace } from '../src/user/workspace-ownership';
import { halfBornOrchestratorHarness, HarnessOrchestratorAgent, orchestratorHarness } from './helpers/actor-harness';
import type { UserCaller } from '@kinu.run/core';
import type { WorkspaceRegistrationSource } from '../src/user/user-do';
import type { PresentedCaller } from '@kinu.run/core/control-plane';
import type { AuthIdentity } from '../src/auth/session';

const USER_ID = '0123456789abcdef0123456789abcdef';

/** The account's catalog as a fresh account has it: the built-in default tier
 *  is where a create reads the model a new workspace starts on. */
const DEFAULT_ENVELOPE: ProfileCatalogEnvelope = {
  authority: { kind: 'account', accountId: USER_ID },
  version: 0,
  digest: profileCatalogDigest(BUILTIN_PROFILE_CATALOG),
  catalog: BUILTIN_PROFILE_CATALOG,
};

/** The registry write the fake user objects here share. `logged` is the call
 *  line the case reads back and `at` the timestamp its reservation carries. */
function registerWorkspaceStub(
  calls: string[],
  logged: (name: string, displayName?: string, from?: WorkspaceRegistrationSource) => string,
  at: number,
) {
  return async (
    _caller: UserCaller, name: string, displayName?: string, from?: WorkspaceRegistrationSource,
  ) => {
    calls.push(logged(name, displayName, from));

    return {
      entry: { name, displayName: displayName ?? name, createdAt: at, lastVisited: at, archivedAt: null },
      status: 'created' as const,
    };
  };
}

interface TestNamespace<Stub> {
  idFromName(name: string): string;
  get(): Stub;
}

interface OwnershipTestBindings<UserStub, AgentStub> {
  UserDO: TestNamespace<UserStub>;
  OrchestratorAgent: TestNamespace<AgentStub>;
  CREDENTIAL_ENCRYPTION_KEY: string;
  ControlPlaneDO?: TestNamespace<unknown>;
}

function testEnv<UserStub, AgentStub>(bindings: OwnershipTestBindings<UserStub, AgentStub>): Env {
  const env: Partial<Env> = {};
  Object.assign(env, bindings);

  // SAFETY: The ownership paths reach only the two constructed namespaces, the
  // credential key, and — where a test supplies one — the control-plane index
  // namespace the create feed writes through; each typed binding required by
  // those paths is present above.
  return env as Env;
}

/** What the control-plane index was told by a create, in order. Named because
 *  WHEN a create indexes is the property two tests below are about: a row
 *  published before the workspace's own object accepted this account survives a
 *  rollback that cannot destroy an object it does not own. */
interface IndexFeed {
  observed: string[];
  forgotten: string[];
  namespace: TestNamespace<unknown>;
}

function indexFeed(): IndexFeed {
  const observed: string[] = [];
  const forgotten: string[] = [];

  return {
    observed,
    forgotten,
    namespace: {
      idFromName: (name: string) => name,
      get: () => ({
        async observeWorkspace(_caller: PresentedCaller, row: { userId: string; name: string }) {
          observed.push(`${row.userId}/${row.name}`);
        },
        async forgetWorkspace(_caller: PresentedCaller, row: { userId: string; name: string }) {
          forgotten.push(`${row.userId}/${row.name}`);
        },
      }),
    },
  };
}

function userStub(env: Env) {
  return env.UserDO.get(env.UserDO.idFromName(USER_ID));
}

/**
 * The registry surface a create reaches when nothing about the roster is what
 * the test is asking about: it registers, it can be asked to undo, and it
 * answers the credential reads the model menu makes. Each rollback test below
 * overrides exactly the one method whose failure it is about, so the method that
 * failed is the only difference between them.
 */
function registryStub() {
  return {
    async getProfileCatalog(_caller: UserCaller) { return DEFAULT_ENVELOPE; },
    async getAuthHeaders(_caller: UserCaller) { return { authorization: 'Bearer token' }; },
    async getCredentialBaseURL(_caller: UserCaller) {
      return 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1';
    },
    async listCredentials(_caller: UserCaller) { return []; },
    async ensureWorkspaceCapability() {},
    async registerWorkspace(_caller: UserCaller, name: string, displayName?: string) {
      return {
        entry: { name, displayName: displayName ?? name, createdAt: 1, lastVisited: 1, archivedAt: null },
        status: 'created' as const,
      };
    },
    async releaseWorkspaceReservation() { return true; },
    async removeWorkspace() {},
  };
}

afterEach(() => { setDiagnosticsSink(createRecordingLogger()); });

describe('cloud agent ownership safety', () => {
  test('a mission-only create stores a PROVISIONAL title and leaves naming to the genesis turn', async () => {
    const calls: string[] = [];
    const background: Promise<unknown>[] = [];

    const userDO = {
      async getProfileCatalog(_caller: UserCaller) { return DEFAULT_ENVELOPE; },
      async getAuthHeaders(_caller: UserCaller) {
        return { authorization: 'Bearer token' };
      },
      async getCredentialBaseURL(_caller: UserCaller) {
        return 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1';
      },
      async listCredentials(_caller: UserCaller) {
        return [];
      },
      async ensureWorkspaceCapability() {},
      registerWorkspace: registerWorkspaceStub(calls, (name, displayName, from) => `register:${name}:${displayName ?? ''}:${from?.nameOrigin ?? ''}`, 1),
      async removeWorkspace(_caller: UserCaller, name: string, ownerUserId: string) {
        calls.push(`remove:${name}:${ownerUserId}`);
      },
    };

    const orchestrator = {
      async claimOwner(userId: string) {
        calls.push(`claim:${userId}`);

        return { owner: userId, capabilityHash: 'sha-existing' };
      },
      async setSoul() {
        calls.push('soul');
      },
      async setInitialDisplayName(displayName: string, origin: string) {
        calls.push(`initial-title:${displayName}:${origin}`);
      },
      async setModel(model: string) {
        calls.push(`model:${model}`);
      },
      async resetWorkspaceBaseline() {
        calls.push('baseline');

        return { ok: true as const };
      },
      async beginGenesisTurn() {
        calls.push('genesis');

        return { started: true };
      },
    };

    const env = testEnv({
      UserDO: {
        idFromName(name: string) { return name; },
        get() { return userDO; },
      },
      OrchestratorAgent: {
        idFromName(name: string) { return name; },
        get() { return orchestrator; },
      }, CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));

    try {
      const entry = await createCloudWorkspaceForUser({
        env,
        userId: USER_ID,
        userDO: userStub(env),
        caller: await testOwner(),
        input: {
          purpose: 'Build a hello world app in react',
        },
      });

      // The slug is a permanent URL and Durable Object name. It remains
      // neutral; mission text is confined to the editable display name.
      expect(entry.name).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{8}$/);
      expect(entry.name).not.toContain('hello');
      expect(entry.displayName).toBe('Build a hello world app in react');
      expect(calls).toContain(`claim:${USER_ID}`);
      // THE #18 CONTRACT at this boundary. The title this create stores is the
      // mission's first line, and it is recorded as the stand-in it is — in the
      // registry row AND in the actor's activation cache — so the genesis turn's
      // durable `auto_title` effect is still allowed to replace it. Recorded as
      // 'user' (which is what an empty-check on the display name produced) it
      // was the workspace's permanent name.
      expect(calls).toContain('register:' + entry.name + ':Build a hello world app in react:provisional');
      expect(calls).toContain('initial-title:Build a hello world app in react:provisional');
      expect(calls).toContain('soul');
      // The agent takes the first turn itself — after the soul, model and
      // effort are durable, and without the owner having to reprompt.
      expect(calls.indexOf('genesis')).toBeGreaterThan(calls.indexOf('soul'));
      expect(calls.indexOf('genesis')).toBeGreaterThan(calls.indexOf('model:@cf/zai-org/glm-5.3'));
      // NOTHING was detached to name it: the create used to fire a pre-turn
      // model call, but only for a caller that had a Worker request behind it,
      // so every other create was named by nothing at all. The genesis turn
      // owes the naming now, for every caller, with a durable retry.
      expect(background).toHaveLength(0);

      const purposeless = await createCloudWorkspaceForUser({
        env,
        userId: USER_ID,
        userDO: userStub(env),
        caller: await testOwner(),
        input: {},
      });

      // Nothing to name it after, so the memorable pair — its only remaining
      // job. The suffix is 8 hex, not 4: at 4 it shared digits with the two
      // words and the whole namespace held 65,536 addresses.
      expect(purposeless.name).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{8}$/);
      expect(purposeless.displayName).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
      expect(purposeless.displayName).not.toBe(purposeless.name);

      const explicitlyTitled = await createCloudWorkspaceForUser({
        env,
        userId: USER_ID,
        userDO: userStub(env),
        caller: await testOwner(),
        input: { displayName: 'Jarvis', purpose: 'My personal assistant' },
      });

      expect(explicitlyTitled.displayName).toBe('Jarvis');
      expect(calls).toContain('initial-title:Jarvis:user');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a create that loses the name releases its reservation and touches no other object', async () => {
    // The cross-user shape, and the reason `removeWorkspace` is the WRONG undo
    // here. A workspace name is unique inside one UserDO while
    // `OrchestratorAgent` is addressed globally, so two accounts can register
    // the same string and only one claim can win. A rollback through
    // `removeWorkspace` hits a `destroyAgent` that correctly refuses against
    // somebody else's workspace — and the refusal leaves the loser's roster row
    // in place, pointing at an object it does not own, for every later
    // ownership check to catch. `releaseWorkspaceReservation` drops exactly the
    // row this create inserted and never contacts the target at all.
    const calls: string[] = [];
    const index = indexFeed();

    const userDO = {
      async getProfileCatalog(_caller: UserCaller) { return DEFAULT_ENVELOPE; },
      async getAuthHeaders(_caller: UserCaller) {
        return { authorization: 'Bearer token' };
      },
      async getCredentialBaseURL(_caller: UserCaller) {
        return 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1';
      },
      async listCredentials(_caller: UserCaller) {
        return [];
      },
      async ensureWorkspaceCapability() {},
      registerWorkspace: registerWorkspaceStub(calls, (name, displayName) => `register:${name}:${displayName ?? ''}`, 1),
      async releaseWorkspaceReservation(_caller: UserCaller, name: string, createdAt: number) {
        calls.push(`release:${name}:${String(createdAt)}`);

        return true;
      },
      async removeWorkspace(_caller: UserCaller, name: string, ownerUserId: string) {
        calls.push(`remove:${name}:${ownerUserId}`);
      },
    };

    const orchestrator = {
      async claimOwner(userId: string) {
        calls.push(`claim:${userId}`);
        throw new Error('Agent owned by a different user');
      },
      async destroyAgent(ownerUserId: string) {
        calls.push(`destroy:${ownerUserId}`);
        throw new Error('Agent owner mismatch; refusing to destroy.');
      },
      async setSoul() {
        calls.push('soul');
      },
      async setModel(model: string) {
        calls.push(`model:${model}`);
      },
    };

    const env = testEnv({
      UserDO: {
        idFromName(name: string) { return name; },
        get() { return userDO; },
      },
      OrchestratorAgent: {
        idFromName(name: string) { return name; },
        get() { return orchestrator; },
      },
      ControlPlaneDO: index.namespace,
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));

    try {
      await expect(createCloudWorkspaceForUser({
        env,
        userId: USER_ID,
        userDO: userStub(env),
        caller: await testOwner(),
        input: {
          name: 'jarvis',
          displayName: 'Jarvis',
          purpose: 'Help with software projects',
        },
      })).rejects.toThrow('Agent owned by a different user');
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toContain('register:jarvis:Jarvis');
    expect(calls).toContain(`claim:${USER_ID}`);
    // The one roster row this create inserted, dropped by its own `createdAt`.
    expect(calls).toContain('release:jarvis:1');
    // And nothing that reaches the workspace the other account owns.
    expect(calls).not.toContain(`remove:jarvis:${USER_ID}`);
    expect(calls.some((call) => call.startsWith('destroy:'))).toBe(false);
    expect(calls).not.toContain('soul');
    // The index never learned this account owns that name. Published at
    // registration, the row would have survived — the rollback cannot destroy an
    // object it does not own, so nothing would have removed it.
    expect(index.observed).toEqual([]);
    expect(index.forgotten).toEqual([`${USER_ID}/jarvis`]);
  });

  test('a release the roster refuses propagates, and the create still answers with its OWN failure', async () => {
    // The rollback's two failures are not one failure. `releaseWorkspaceReservation`
    // touches nothing but this account's own roster, so a refusal there is a
    // fault rather than a state the undo knows how to leave behind — and it must
    // not become the answer, because the caller asked to create a workspace and
    // why THAT failed is what it needs. Swallowed, both facts read as one line.
    const recording = createRecordingLogger();
    setDiagnosticsSink(recording);
    const index = indexFeed();

    const userDO = {
      ...registryStub(),
      async releaseWorkspaceReservation() {
        throw new Error('the roster row is not this session’s to release');
      },
    };

    const orchestrator = {
      async claimOwner() { throw new Error('Agent owned by a different user'); },
    };

    const env = testEnv({
      UserDO: { idFromName(name: string) { return name; }, get() { return userDO; } },
      OrchestratorAgent: { idFromName(name: string) { return name; }, get() { return orchestrator; } },
      ControlPlaneDO: index.namespace,
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));

    try {
      await expect(createCloudWorkspaceForUser({
        env,
        userId: USER_ID,
        userDO: userStub(env),
        caller: await testOwner(),
        input: {
          name: 'jarvis', displayName: 'Jarvis', purpose: 'Help with software projects',
        },
      })).rejects.toThrow('Agent owned by a different user');
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Recorded as the undo's own fault, under its own name, with both frames of
    // the chain — not filed as the tolerated fail-closed teardown, which is a
    // decision this rollback did not make.
    const unexpected = recording.emitted.find(
      (line) => line.event === 'workspace.create_rollback_unexpected',
    );

    expect(unexpected).toBeDefined();
    expect(unexpected?.cause).toContain('undoing a failed workspace create');
    expect(unexpected?.cause).toContain('releasing the roster row a failed create reserved');
    expect(unexpected?.cause).toContain('not this session’s to release');
    expect(unexpected?.fields).toMatchObject({ workspace: 'jarvis' });
    expect(recording.emitted.some((line) => line.event === 'workspace.create_rollback_failed'))
      .toBe(false);
    // The roster row survived the failed release, so its index copy must too.
    expect(index.forgotten).toEqual([]);
  });

  test('a teardown that fails closed is tolerated, and the index keeps the row it left standing', async () => {
    // The ONE rollback failure that is a state. `removeWorkspace` tears the
    // Durable Object down before dropping the row and fails closed when the
    // teardown does not happen, so the row standing is deliberate: a same-name
    // recreate must not reconnect to resources nothing destroyed. Propagating
    // this would replace the create's own error with a cleanup's, and
    // tombstoning the index would tell an operator the opposite of the truth.
    const recording = createRecordingLogger();
    setDiagnosticsSink(recording);
    const index = indexFeed();

    const userDO = {
      ...registryStub(),
      async removeWorkspace() {
        throw new Error('destroyAgent did not complete; refusing to drop the row');
      },
    };

    const orchestrator = {
      async claimOwner(userId: string) { return { owner: userId, capabilityHash: null }; },
      async setInitialDisplayName() {},
      async setSoul() { throw new Error('the workspace could not seed its soul'); },
    };

    const env = testEnv({
      UserDO: { idFromName(name: string) { return name; }, get() { return userDO; } },
      OrchestratorAgent: { idFromName(name: string) { return name; }, get() { return orchestrator; } },
      ControlPlaneDO: index.namespace,
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));

    try {
      await expect(createCloudWorkspaceForUser({
        env,
        userId: USER_ID,
        userDO: userStub(env),
        caller: await testOwner(),
        input: {
          name: 'jarvis', displayName: 'Jarvis', purpose: 'Help with software projects',
        },
      })).rejects.toThrow('the workspace could not seed its soul');
    } finally {
      globalThis.fetch = originalFetch;
    }

    const tolerated = recording.emitted.find(
      (line) => line.event === 'workspace.create_rollback_failed',
    );

    expect(tolerated).toBeDefined();
    expect(tolerated?.code).toBe('unavailable');
    expect(tolerated?.cause).toContain('tearing down the workspace a failed create registered');
    expect(tolerated?.fields).toMatchObject({ workspace: 'jarvis', contested: false });
    expect(recording.emitted.some((line) => line.event === 'workspace.create_rollback_unexpected'))
      .toBe(false);
    expect(index.forgotten).toEqual([]);
  });

  test('a create indexes only after the workspace accepts this account as its owner', async () => {
    const calls: string[] = [];
    const index = indexFeed();

    const userDO = {
      async getProfileCatalog(_caller: UserCaller) { return DEFAULT_ENVELOPE; },
      async getAuthHeaders(_caller: UserCaller) { return { authorization: 'Bearer token' }; },
      async getCredentialBaseURL(_caller: UserCaller) {
        return 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1';
      },
      async listCredentials(_caller: UserCaller) { return []; },
      async ensureWorkspaceCapability() { calls.push('capability'); },
      registerWorkspace: registerWorkspaceStub(calls, (name) => `register:${name}`, 5),
      async releaseWorkspaceReservation() { calls.push('release');

 return true; },
      async removeWorkspace() { calls.push('remove'); },
    };

    const orchestrator = {
      async claimOwner(userId: string) {
        calls.push(`claim:${userId}`);

        return { owner: userId, capabilityHash: null };
      },
      async setInitialDisplayName() { calls.push('initial-title'); },
      async setSoul() { calls.push('soul'); },
      async resetWorkspaceBaseline() { calls.push('baseline'); },
      async setModel() { calls.push('model'); },
      async beginGenesisTurn() { calls.push('genesis'); },
    };

    const env = testEnv({
      UserDO: { idFromName(name: string) { return name; }, get() { return userDO; } },
      OrchestratorAgent: { idFromName(name: string) { return name; }, get() { return orchestrator; } },
      ControlPlaneDO: index.namespace,
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));

    try {
      await createCloudWorkspaceForUser({
        env,
        userId: USER_ID,
        userDO: userStub(env),
        caller: await testOwner(),
        input: {
          name: 'jarvis', displayName: 'Jarvis', purpose: 'Help with software projects',
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(index.observed).toEqual([`${USER_ID}/jarvis`]);
    expect(index.forgotten).toEqual([]);
    // Ordering, not just presence: the claim is what makes the index row true.
    expect(calls.indexOf('genesis')).toBeGreaterThan(calls.indexOf(`claim:${USER_ID}`));
  });

  test('a create over a name this owner already has returns it and touches nothing', async () => {
    const calls: string[] = [];

    const userDO = {
      async getProfileCatalog(_caller: UserCaller) { return DEFAULT_ENVELOPE; },
      async getAuthHeaders(_caller: UserCaller) { return { authorization: 'Bearer token' }; },
      async getCredentialBaseURL(_caller: UserCaller) {
        return 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1';
      },
      async listCredentials(_caller: UserCaller) { return []; },
      // The name is already a live workspace of this owner's, so the registry
      // answers `active` with the row it holds — its OWN title and timestamp,
      // not this request's.
      async ensureWorkspaceCapability() { calls.push('capability'); },
      async registerWorkspace(_caller: UserCaller, name: string) {
        calls.push(`register:${name}`);

        return {
          entry: { name, displayName: 'Jarvis as it stands', createdAt: 1, lastVisited: 2, archivedAt: null },
          status: 'active' as const,
        };
      },
      async removeWorkspace(_caller: UserCaller, name: string, ownerUserId: string) {
        calls.push(`remove:${name}:${ownerUserId}`);
      },
    };

    // Every method a birth sequence would reach records itself and then fails,
    // so "the create did not re-initialize" cannot pass by a double that
    // silently accepted the call.
    const orchestrator = {
      async claimOwner() { calls.push('claim'); throw new Error('claimOwner must not be reached'); },
      async setInitialDisplayName() { calls.push('initial-title'); throw new Error('unreachable'); },
      async setSoul() { calls.push('soul'); throw new Error('unreachable'); },
      async resetWorkspaceBaseline() { calls.push('baseline'); throw new Error('unreachable'); },
      async beginGenesisTurn() { calls.push('genesis'); throw new Error('unreachable'); },
    };

    const index = indexFeed();

    const env = testEnv({
      UserDO: { idFromName(name: string) { return name; }, get() { return userDO; } },
      OrchestratorAgent: { idFromName(name: string) { return name; }, get() { return orchestrator; } },
      ControlPlaneDO: index.namespace,
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));
    let first;
    let second;

    try {
      first = await createCloudWorkspaceForUser({
        env,
        userId: USER_ID,
        userDO: userStub(env),
        caller: await testOwner(),
        input: {
          name: 'jarvis', displayName: 'A different title', purpose: 'a different mission',
        },
      });
      // The same request again: an idempotent create is a STABLE answer, not
      // merely a non-destructive one.
      second = await createCloudWorkspaceForUser({
        env,
        userId: USER_ID,
        userDO: userStub(env),
        caller: await testOwner(),
        input: {
          name: 'jarvis', displayName: 'A different title', purpose: 'a different mission',
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(first).toEqual({
      name: 'jarvis', displayName: 'Jarvis as it stands', createdAt: 1, lastVisited: 2, archivedAt: null,
    });
    expect(second).toEqual(first);
    // The register is the whole call: no claim, no soul, no baseline reset, no
    // second genesis turn on a workspace that is already somebody's — and no
    // rollback either, because nothing was inserted to roll back.
    expect(calls).toEqual(['register:jarvis', 'register:jarvis']);
    expect(index.observed).toEqual([]);
    expect(index.forgotten).toEqual([]);
  });

  test('a newly created workspace is given its identity before anything else touches it', async () => {
    const calls: string[] = [];

    const userDO = {
      async getProfileCatalog() { return DEFAULT_ENVELOPE; },
      async getAuthHeaders() { return { authorization: 'Bearer token' }; },
      async getCredentialBaseURL() {
        return 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1';
      },
      async listCredentials() { return []; },
      registerWorkspace: registerWorkspaceStub(calls, (name) => `register:${name}`, 1),
      async ensureWorkspaceCapability(name: string, presentedHash: string | null) {
        calls.push(`ensure:${name}:${presentedHash ?? 'none'}`);
      },
      async removeWorkspace() {},
    };

    const orchestrator = {
      // A freshly materialized workspace DO holds nothing yet.
      async claimOwner(userId: string) { calls.push(`claim:${userId}`);

 return { owner: userId, capabilityHash: null }; },
      async setInitialDisplayName(_displayName: string, origin: 'user' | 'auto') { calls.push(`initial-title:${origin}`); },
      async setSoul() { calls.push('soul'); },
      async setModel() { calls.push('model'); },
      async resetWorkspaceBaseline() { calls.push('baseline');

 return { ok: true as const }; },
      // Named, no mission: the DO's own gate (workspaceGenesisSignal) declines a
      // first turn on a placeholder mission. The call still happens — the wire
      // is unconditional and the decision is not the worker's to make.
      async beginGenesisTurn() { calls.push('genesis');

 return { started: false }; },
    };

    const env = testEnv({
      UserDO: { idFromName: (n: string) => n, get: () => userDO },
      OrchestratorAgent: { idFromName: (n: string) => n, get: () => orchestrator },
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));

    try {
      await createCloudWorkspaceForUser({
        env,
        userId: USER_ID,
        userDO: userStub(env),
        caller: await testOwner(),
        input: {
          name: 'jarvis',
          displayName: 'Jarvis',
          purpose: 'My personal assistant Jarvis',
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    // A new workspace runs its first turn — an auto-title, a peer's task, an
    // inbound email — without ever being opened, so its identity must exist
    // before any of that, not on first visit.
    expect(calls).toEqual([
      'register:jarvis', `claim:${USER_ID}`, 'ensure:jarvis:none',
      'initial-title:user', 'soul', 'baseline', 'model', 'genesis',
    ]);
  });

  describe('capability reconciliation at claim time', () => {
    function setupClaim(options: { capabilityHash: string | null; ensureThrows?: string }) {
      const calls: string[] = [];

      const workspace = {
        async claimOwner(userId: string) {
          calls.push(`claim:${userId}`);

          return { owner: userId, capabilityHash: options.capabilityHash };
        },
      };

      const userDO = {
        async hasWorkspace() { return true; },
        async ensureWorkspaceCapability(name: string, presentedHash: string | null) {
          calls.push(`ensure:${name}:${presentedHash ?? 'none'}`);

          if (options.ensureThrows) throw new Error(options.ensureThrows);
        },
      };

      const env = testEnv({
        UserDO: { idFromName: (n: string) => n, get: () => userDO },
        OrchestratorAgent: { idFromName: (n: string) => n, get: () => workspace },
        CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
      });

      return { env, calls };
    }

    test('the workspace reports what it holds and the UserDO decides', async () => {
      // The Worker deliberately does NOT decide: it cannot see both sides, and
      // two concurrent first-touches each deciding is what splits a workspace's
      // identity in half. It forwards the hash and lets the UserDO reconcile.
      const { env, calls } = setupClaim({ capabilityHash: null });

      expect((await claimOwnedWorkspace(env, USER_ID, 'jarvis')).ok).toBe(true);

      expect(calls).toEqual([`claim:${USER_ID}`, 'ensure:jarvis:none']);
    });

    test('an already-provisioned workspace still reconciles, carrying its hash', async () => {
      const { env, calls } = setupClaim({ capabilityHash: 'sha-existing' });

      expect((await claimOwnedWorkspace(env, USER_ID, 'jarvis')).ok).toBe(true);

      expect(calls).toEqual([`claim:${USER_ID}`, 'ensure:jarvis:sha-existing']);
    });

    test('a workspace whose reconciliation fails is not handed to the caller', async () => {
      const { env } = setupClaim({ capabilityHash: null, ensureThrows: 'storage unavailable' });

      const result = await claimOwnedWorkspace(env, USER_ID, 'jarvis');

      expect(result).toMatchObject({ ok: false, status: 500 });

      if (!result.ok) expect(result.error).toContain('storage unavailable');
    });
  });

  describe('claimOwner — the scaffold probe and the connect path', () => {
    // Production telemetry over 48h (#222): claimOwner median 6ms but p90
    // 1170ms / max 2456ms. The tail is ensureOwnedScaffold's Nimbus network
    // probe (`vfs.exists`) running whenever `_scaffoldReady` is false — every
    // cold activation — inside the RPC every authenticated request calls.
    // The owned branch must not probe: beforeTurn awaits the same latch
    // before anything reads the workspace files, so an interrupted first
    function spyScaffoldExists(agent: HarnessOrchestratorAgent) {
      const scaffold = agent.observeRuntime().identity.scaffold;
      let seen = 0;
      const real = scaffold.exists.bind(scaffold);
      scaffold.exists = async () => {
        seen += 1;

        return real();
      };

      return { calls: () => seen };
    }

    test('an already-owned claim does not touch the Nimbus filesystem', async () => {
      const harness = orchestratorHarness();
      harness.agent.forgetActivationLatches();
      const probe = spyScaffoldExists(harness.agent);

      const claim = await harness.agent.claimOwner('harness-owner');

      expect(claim.owner).toBe('harness-owner');
      expect(probe.calls()).toBe(0);
    });

    test('the first claim still bootstraps the scaffold through Nimbus', async () => {
      const harness = orchestratorHarness();
      harness.db.prepare(
        "UPDATE workspace_identity SET owner_user_id = '' WHERE id = 'harness-actor'",
      ).run();
      // Same cold activation as production: nothing has latched the scaffold.
      harness.agent.forgetActivationLatches();
      const probe = spyScaffoldExists(harness.agent);

      const claim = await harness.agent.claimOwner('first-claim-user');

      expect(claim.owner).toBe('first-claim-user');
      expect(probe.calls()).toBeGreaterThan(0);
      expect(await harness.agent.observeRuntime().identity.scaffold.exists()).toBe(true);
    });
  });

  test('the delete route destroys only as the signed-in owner, and the agent refuses anyone else', async () => {
    const OWNER = 'a'.repeat(32);
    const removed: Array<{ name: string; ownerUserId: string }> = [];

    const env = testEnv({
      UserDO: {
        idFromName: (name: string) => name,
        get: () => ({
          async ensureProfile() {},
          async removeWorkspace(_caller: UserCaller, name: string, ownerUserId: string) {
            removed.push({ name, ownerUserId });
          },
        }),
      },
      OrchestratorAgent: { idFromName: (name: string) => name, get: () => ({}) },
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    });

    const identity: AuthIdentity = {
      userId: OWNER, email: 'owner@example.com', sub: 'sub', provider: 'test', authTime: Date.now(),
    };

    const del = (body?: { ownerUserId?: string }): Promise<Response | null> => handleUserRequest(new Request(
      'https://kinu.example.com/api/user/workspaces/jarvis',
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    ), env, identity);

    // The session's own id is the destroy authority. A forged body cannot
    // retarget the destroy at another account.
    expect((await del())?.status).toBe(200);
    expect((await del({ ownerUserId: 'f'.repeat(32) }))?.status).toBe(200);
    expect(removed).toEqual([
      { name: 'jarvis', ownerUserId: OWNER },
      { name: 'jarvis', ownerUserId: OWNER },
    ]);

    // And the workspace's own object refuses a destroy authorized by anyone
    // else — the check the forwarded id meets on a real agent.
    const harness = orchestratorHarness();
    await expect(harness.agent.destroyAgent('b'.repeat(32)))
      .rejects.toThrow('Agent owner mismatch; refusing to destroy.');
  });

  test('a workspace whose schema never initialized is deleted: roster row and object storage go together', async () => {
    // The half-born shape: a create that died between the DO name being minted
    // and `ensureSchema` leaves a named object with NO `workspace_identity`
    // table — so the owner read inside `destroyAgent` throws on the object,
    // and the roster row a healthy workspace would have released stays.
    const halfBorn = halfBornOrchestratorHarness({ workspace: 'jarvis' });
    expect(halfBorn.tableNames()).not.toContain('workspace_identity');
    // Its constructor ran, so the storage the delete owes is real.
    expect(halfBorn.tableNames()).toContain('workspace_capability');

    const userDO = createTestUserDO({
      durableObjectId: USER_ID,
      // The real workspace object behind the namespace stub: the destroy the
      // UserDO orders reaches the production `destroyAgent`, owner id intact.
      destroyWorkspaceGate: async (_name, ownerUserId) => {
        await halfBorn.agent.destroyAgent(ownerUserId);
      },
    });

    const env = testEnv({
      UserDO: { idFromName: (name: string) => name, get: () => userDO.userDO },
      OrchestratorAgent: { idFromName: (name: string) => name, get: () => ({}) },
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    });

    const owner = await testOwner();
    await userDO.userDO.registerWorkspace(owner, 'jarvis');

    const identity: AuthIdentity = {
      userId: USER_ID, email: 'owner@example.com', sub: 'sub', provider: 'test', authTime: Date.now(),
    };

    const response = await handleUserRequest(new Request(
      'https://kinu.example.com/api/user/workspaces/jarvis', { method: 'DELETE' },
    ), env, identity);

    expect(response?.status).toBe(200);
    expect(userDO.destroyedWorkspaces).toEqual(['jarvis']);
    // Storage gone — every table the object held, dropped by `deleteAll`.
    expect(halfBorn.tableNames().filter((name) => name !== 'sqlite_sequence')).toEqual([]);
    // And the row is out of the owner's registry, not parked delete_pending.
    expect(userDO.sql.exec(`SELECT name FROM user_workspaces`).toArray()).toEqual([]);
  });

  test('a healthy workspace whose owner does not match is still refused, row and storage intact', async () => {
    // The guard the half-born skip must not widen: a workspace that DID
    // initialize keeps its owner row, and a roster entry pointing at somebody
    // else's object cannot destroy it.
    const OTHER = 'b'.repeat(32);
    const healthy = orchestratorHarness(undefined, { workspace: 'jarvis', ownerUserId: OTHER });

    const userDO = createTestUserDO({
      durableObjectId: USER_ID,
      destroyWorkspaceGate: async (_name, ownerUserId) => {
        await healthy.agent.destroyAgent(ownerUserId);
      },
    });

    const env = testEnv({
      UserDO: { idFromName: (name: string) => name, get: () => userDO.userDO },
      OrchestratorAgent: { idFromName: (name: string) => name, get: () => ({}) },
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    });

    const owner = await testOwner();
    await userDO.userDO.registerWorkspace(owner, 'jarvis');

    const response = await handleUserRequest(new Request(
      'https://kinu.example.com/api/user/workspaces/jarvis', { method: 'DELETE' },
    ), env, {
      userId: USER_ID, email: 'owner@example.com', sub: 'sub', provider: 'test', authTime: Date.now(),
    });

    expect(response?.status).toBe(400);
    // Fail-closed: the row stays, and the workspace's storage is untouched.
    expect(healthy.tableNames()).toContain('workspace_identity');
  });
});
