import { createTestUserDO, TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { serveFamily } from './helpers/api';
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  actorScaffoldPath, asFetchFunction, BUILTIN_PROFILE_CATALOG, MAIN_AGENT, profileCatalogDigest, type ProfileCatalogEnvelope,
} from '@kinu.run/core';
import { createRecordingLogger, setDiagnosticsSink } from '@kinu.run/core/obs';
import { testOwner } from './helpers/user-do';
import { userRoutes } from '../src/user/routes';
import { handleCreateWorkspaceRequest } from '../src/user/workspace-access';
import { createCloudWorkspaceForUser, type CloudWorkspaceRegistry } from '../src/user/workspace-create';
import { claimOwnedWorkspace } from '../src/user/workspace-ownership';
import {
  halfBornOrchestratorHarness, orchestratorHarness, reactivateOrchestratorHarness, workspaceFiles,
} from './helpers/actor-harness';
import type { UserCaller } from '@kinu.run/core';
import type { NameOrigin } from '@kinu.run/core';
import type { WorkspaceRegistrationSource } from '../src/user/user-do';
import type { PresentedCaller } from '@kinu.run/core/control-plane';
import type { AuthIdentity } from '../src/auth/session';
import type { IndexFeedSink } from '../src/control-plane/index-feed';
import { bootstrappedProfile, userAccount, workspaceObject, workerContext } from './helpers/bindings';

const USER_ID = '0123456789abcdef0123456789abcdef';

/** A fresh account's catalog; a create reads the new workspace's model from its default tier. */
const DEFAULT_ENVELOPE: ProfileCatalogEnvelope = {
  authority: { kind: 'account', accountId: USER_ID },
  version: 0,
  digest: profileCatalogDigest(BUILTIN_PROFILE_CATALOG),
  catalog: BUILTIN_PROFILE_CATALOG,
};

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

/** The create's index writes in order: a row published before the owner claim would survive rollback. */
interface IndexFeed {
  observed: string[];
  forgotten: string[];
  namespace: TestNamespace<IndexFeedSink>;
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
        async observeUser() { throw new Error('ControlPlaneDO.observeUser: not reachable in this test'); },
        async touchWorkspace() { throw new Error('ControlPlaneDO.touchWorkspace: not reachable in this test'); },
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

/** A neutral registry; each rollback test overrides only the method whose failure it is about. */
function registryStub(): CloudWorkspaceRegistry {
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
  test('a mission-only create stores its stand-in title as the system\'s and leaves naming to the genesis turn', async () => {
    const calls: string[] = [];
    const background: Promise<unknown>[] = [];

    const userDO = {
      ...registryStub(),
      registerWorkspace: registerWorkspaceStub(calls, (name, displayName, from) => `register:${name}:${displayName ?? ''}:${from?.nameOrigin ?? ''}`, 1),
      async removeWorkspace(_caller: UserCaller, name: string, ownerUserId: string) {
        calls.push(`remove:${name}:${ownerUserId}`);
      },
    };

    const orchestrator = workspaceObject({
      async claimOwner(userId: string) {
        calls.push(`claim:${userId}`);

        return { owner: userId, capabilityHash: 'sha-existing' };
      },
      async setSoul(soul: string) {
        calls.push('soul');

        return { soul, purpose: '' };
      },
      async setInitialDisplayName(displayName: string, nameOrigin: NameOrigin) {
        calls.push(`initial-title:${displayName}:${nameOrigin}`);

        return { displayName, nameOrigin };
      },
      async setModel(spec: string) {
        calls.push(`model:${spec}`);

        return { ok: true, spec };
      },
      async resetWorkspaceBaseline() {
        calls.push('baseline');

        return { ok: true as const, files: 0 };
      },
      async beginGenesisTurn() {
        calls.push('genesis');

        return { started: true };
      },
    });

    const env = {
      UserDO: {
        idFromName(name: string) { return name; },
        get() { return userDO; },
      },
      OrchestratorAgent: {
        idFromName(name: string) { return name; },
        get() { return orchestrator; },
      },
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));

    try {
      const entry = await createCloudWorkspaceForUser({
        env,
        userId: USER_ID,
        userDO: env.UserDO.get(),
        caller: await testOwner(),
        input: {
          purpose: 'Build a hello world app in react',
        },
      });

      // The slug is a permanent URL and Durable Object name, so it stays neutral.
      expect(entry.name).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{8}$/);
      expect(entry.name).not.toContain('hello');
      expect(entry.displayName).toBe('Build a hello world app in react');
      expect(calls).toContain(`claim:${USER_ID}`);
      // #18: the stored title is the mission's first line as 'auto' (registry and activation cache),
      // so the genesis turn's `auto_title` may replace it.
      expect(calls).toContain('register:' + entry.name + ':Build a hello world app in react:auto');
      expect(calls).toContain('initial-title:Build a hello world app in react:auto');
      expect(calls).toContain('soul');
      // Genesis runs after soul, model and effort are durable.
      expect(calls.indexOf('genesis')).toBeGreaterThan(calls.indexOf('soul'));
      expect(calls.indexOf('genesis')).toBeGreaterThan(calls.indexOf('model:@cf/zai-org/glm-5.3'));
      // Nothing detached to name it: the genesis turn owns naming for every caller, with a durable retry.
      expect(background).toHaveLength(0);

      const purposeless = await createCloudWorkspaceForUser({
        env,
        userId: USER_ID,
        userDO: env.UserDO.get(),
        caller: await testOwner(),
        input: {},
      });

      // No mission, so the memorable pair; the suffix is 8 hex so it cannot collide with the words.
      expect(purposeless.name).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{8}$/);
      expect(purposeless.displayName).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
      expect(purposeless.displayName).not.toBe(purposeless.name);

      const explicitlyTitled = await createCloudWorkspaceForUser({
        env,
        userId: USER_ID,
        userDO: env.UserDO.get(),
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
    // Names are unique per UserDO but `OrchestratorAgent` is global, so a losing create must not undo via
    // `removeWorkspace` (its `destroyAgent` refuses and leaves the row); release drops only its own row.
    const calls: string[] = [];
    const index = indexFeed();

    const userDO = {
      ...registryStub(),
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
      ...workspaceObject({}),
      async claimOwner(userId: string) {
        calls.push(`claim:${userId}`);
        throw new Error('Agent owned by a different user');
      },
      async destroyAgent(ownerUserId: string) {
        calls.push(`destroy:${ownerUserId}`);
        throw new Error('Agent owner mismatch; refusing to destroy.');
      },
      async setSoul(soul: string) {
        calls.push('soul');

        return { soul, purpose: '' };
      },
      async setModel(spec: string) {
        calls.push(`model:${spec}`);

        return { ok: true, spec };
      },
    };

    const env = {
      UserDO: {
        idFromName(name: string) { return name; },
        get() { return userDO; },
      },
      OrchestratorAgent: {
        idFromName(name: string) { return name; },
        get() { return orchestrator; },
      },
      ControlPlaneDO: index.namespace,
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));

    try {
      await expect(createCloudWorkspaceForUser({
        env,
        userId: USER_ID,
        userDO: env.UserDO.get(),
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
    expect(calls).not.toContain(`remove:jarvis:${USER_ID}`);
    expect(calls.some((call) => call.startsWith('destroy:'))).toBe(false);
    expect(calls).not.toContain('soul');
    // Indexing after the claim means the rollback leaves no index row it cannot remove.
    expect(index.observed).toEqual([]);
    expect(index.forgotten).toEqual([`${USER_ID}/jarvis`]);
  });

  test('a release the roster refuses propagates, and the create still answers with its OWN failure', async () => {
    // A refused release is a fault, propagated, but the create's own failure stays the answer.
    const recording = createRecordingLogger();
    setDiagnosticsSink(recording);
    const index = indexFeed();

    const userDO = {
      ...registryStub(),
      async releaseWorkspaceReservation() {
        throw new Error('the roster row is not this session’s to release');
      },
    };

    const orchestrator = workspaceObject({
      async claimOwner() { throw new Error('Agent owned by a different user'); },
    });

    const env = {
      UserDO: { idFromName(name: string) { return name; }, get() { return userDO; } },
      OrchestratorAgent: { idFromName(name: string) { return name; }, get() { return orchestrator; } },
      ControlPlaneDO: index.namespace,
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));

    try {
      await expect(createCloudWorkspaceForUser({
        env,
        userId: USER_ID,
        userDO: env.UserDO.get(),
        caller: await testOwner(),
        input: {
          name: 'jarvis', displayName: 'Jarvis', purpose: 'Help with software projects',
        },
      })).rejects.toThrow('Agent owned by a different user');
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Filed as the undo's own fault, not as the tolerated fail-closed teardown.
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
    // A fail-closed `removeWorkspace` leaves the row on purpose (a recreate must not reconnect to
    // undestroyed resources), so the create's error stands and the index keeps the row.
    const recording = createRecordingLogger();
    setDiagnosticsSink(recording);
    const index = indexFeed();

    const userDO = {
      ...registryStub(),
      async removeWorkspace() {
        throw new Error('destroyAgent did not complete; refusing to drop the row');
      },
    };

    const orchestrator = workspaceObject({
      async claimOwner(userId: string) { return { owner: userId, capabilityHash: null }; },
      async setInitialDisplayName(displayName: string, nameOrigin: NameOrigin) { return { displayName, nameOrigin }; },
      async setSoul() { throw new Error('the workspace could not seed its soul'); },
    });

    const env = {
      UserDO: { idFromName(name: string) { return name; }, get() { return userDO; } },
      OrchestratorAgent: { idFromName(name: string) { return name; }, get() { return orchestrator; } },
      ControlPlaneDO: index.namespace,
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));

    try {
      await expect(createCloudWorkspaceForUser({
        env,
        userId: USER_ID,
        userDO: env.UserDO.get(),
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
      ...registryStub(),
      async ensureWorkspaceCapability() { calls.push('capability'); },
      registerWorkspace: registerWorkspaceStub(calls, (name) => `register:${name}`, 5),
      async releaseWorkspaceReservation() {
        calls.push('release');

        return true;
      },
      async removeWorkspace() { calls.push('remove'); },
    };

    const orchestrator = workspaceObject({
      async claimOwner(userId: string) {
        calls.push(`claim:${userId}`);

        return { owner: userId, capabilityHash: null };
      },
      async setInitialDisplayName(displayName: string, nameOrigin: NameOrigin) {
        calls.push('initial-title');

        return { displayName, nameOrigin };
      },
      async setSoul(soul: string) {
        calls.push('soul');

        return { soul, purpose: '' };
      },
      async resetWorkspaceBaseline() {
        calls.push('baseline');

        return { ok: true as const, files: 0 };
      },
      async setModel(spec: string) {
        calls.push('model');

        return { ok: true, spec };
      },
      async beginGenesisTurn() {
        calls.push('genesis');

        return { started: true };
      },
    });

    const env = {
      UserDO: { idFromName(name: string) { return name; }, get() { return userDO; } },
      OrchestratorAgent: { idFromName(name: string) { return name; }, get() { return orchestrator; } },
      ControlPlaneDO: index.namespace,
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));

    try {
      await createCloudWorkspaceForUser({
        env,
        userId: USER_ID,
        userDO: env.UserDO.get(),
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
      ...registryStub(),
      // An existing live workspace: the registry answers `active` with its own row, not this request's.
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

    // Birth-sequence methods record then fail, so a silently accepting double cannot pass.
    const orchestrator = workspaceObject({
      async claimOwner() { calls.push('claim'); throw new Error('claimOwner must not be reached'); },
      async setInitialDisplayName() { calls.push('initial-title'); throw new Error('unreachable'); },
      async setSoul() { calls.push('soul'); throw new Error('unreachable'); },
      async resetWorkspaceBaseline() { calls.push('baseline'); throw new Error('unreachable'); },
      async beginGenesisTurn() { calls.push('genesis'); throw new Error('unreachable'); },
    });

    const index = indexFeed();

    const env = {
      UserDO: { idFromName(name: string) { return name; }, get() { return userDO; } },
      OrchestratorAgent: { idFromName(name: string) { return name; }, get() { return orchestrator; } },
      ControlPlaneDO: index.namespace,
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));
    let first;
    let second;

    try {
      first = await createCloudWorkspaceForUser({
        env,
        userId: USER_ID,
        userDO: env.UserDO.get(),
        caller: await testOwner(),
        input: {
          name: 'jarvis', displayName: 'A different title', purpose: 'a different mission',
        },
      });
      // An idempotent create is a stable answer, not merely a non-destructive one.
      second = await createCloudWorkspaceForUser({
        env,
        userId: USER_ID,
        userDO: env.UserDO.get(),
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
    // The register is the whole call: no claim, soul, reset, genesis, or rollback.
    expect(calls).toEqual(['register:jarvis', 'register:jarvis']);
    expect(index.observed).toEqual([]);
    expect(index.forgotten).toEqual([]);
  });

  test('a newly created workspace is given its identity before anything else touches it', async () => {
    const calls: string[] = [];

    const userDO = {
      ...registryStub(),
      registerWorkspace: registerWorkspaceStub(calls, (name) => `register:${name}`, 1),
      async ensureWorkspaceCapability(name: string, presentedHash: string | null) {
        calls.push(`ensure:${name}:${presentedHash ?? 'none'}`);
      },
    };

    const orchestrator = workspaceObject({
      async claimOwner(userId: string) {
        calls.push(`claim:${userId}`);

        return { owner: userId, capabilityHash: null };
      },
      async setInitialDisplayName(displayName: string, nameOrigin: NameOrigin) {
        calls.push(`initial-title:${nameOrigin}`);

        return { displayName, nameOrigin };
      },
      async setSoul(soul: string) {
        calls.push('soul');

        return { soul, purpose: '' };
      },
      async setModel(spec: string) {
        calls.push('model');

        return { ok: true, spec };
      },
      async resetWorkspaceBaseline() {
        calls.push('baseline');

        return { ok: true as const, files: 0 };
      },
      // The DO's `workspaceGenesisSignal` declines a placeholder mission; the worker still calls it.
      async beginGenesisTurn() {
        calls.push('genesis');

        return { started: false };
      },
    });

    const env = {
      UserDO: { idFromName: (n: string) => n, get: () => userDO },
      OrchestratorAgent: { idFromName: (n: string) => n, get: () => orchestrator },
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));

    try {
      await createCloudWorkspaceForUser({
        env,
        userId: USER_ID,
        userDO: env.UserDO.get(),
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

    // A workspace can run turns without being opened, so its identity must exist before first visit.
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

      const env = {
        UserDO: { idFromName: (n: string) => n, get: () => userDO },
        OrchestratorAgent: { idFromName: (n: string) => n, get: () => workspace },
        CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
      };

      return { env, calls };
    }

    test('the workspace reports what it holds and the UserDO decides', async () => {
      // The Worker forwards the hash; deciding here would let two concurrent first-touches split the identity.
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
    // #222: the claimOwner latency tail was ensureOwnedScaffold's `vfs.exists` probe on every cold
    // activation; the owned branch must not probe (beforeTurn awaits the same latch).

    /** Every statement the storage engine ran while `during` ran. */
    async function statementsDuring(db: Database, during: () => Promise<void>): Promise<string[]> {
      const seen: string[] = [];
      const query = db.query.bind(db);
      const prepare = db.prepare.bind(db);
      Object.assign(db, {
        query: (sql: string) => { seen.push(sql);

 return query(sql); },
        prepare: (sql: string) => { seen.push(sql);

 return prepare(sql); },
      });

      try {
        await during();
      } finally {
        Object.assign(db, { query, prepare });
      }

      return seen;
    }

    /** A statement against the Nimbus filesystem's own inode table. */
    const touchesFilesystem = (sql: string): boolean => /\binodes\b/u.test(sql);

    test('an already-owned claim does not touch the Nimbus filesystem', async () => {
      const { db } = orchestratorHarness();
      // A cold activation over the same rows: no latch of the last one survives.
      const cold = await reactivateOrchestratorHarness(db, undefined, { world: { freshScaffold: true } });

      let owner: string | undefined;
      const statements = await statementsDuring(db, async () => { owner = (await cold.agent.claimOwner('harness-owner')).owner; });

      expect(owner).toBe('harness-owner');
      expect(statements.filter(touchesFilesystem)).toEqual([]);
    });

    test('the first claim still bootstraps the scaffold through Nimbus', async () => {
      const { db } = orchestratorHarness();
      db.prepare("UPDATE workspace_identity SET owner_user_id = '' WHERE id = 'harness-actor'").run();
      const cold = await reactivateOrchestratorHarness(db, undefined, { world: { freshScaffold: true } });

      let owner: string | undefined;
      const statements = await statementsDuring(db, async () => { owner = (await cold.agent.claimOwner('first-claim-user')).owner; });

      expect(owner).toBe('first-claim-user');
      expect(statements.filter(touchesFilesystem).length).toBeGreaterThan(0);
      expect(await workspaceFiles(cold.agent).stat(actorScaffoldPath({ kind: 'main', storageKey: MAIN_AGENT }))).not.toBeNull();
    });
  });

  test('the delete route destroys only as the signed-in owner, and the agent refuses anyone else', async () => {
    const OWNER = 'a'.repeat(32);
    const removed: Array<{ name: string; ownerUserId: string }> = [];

    const env = {
      UserDO: {
        idFromName: (name: string) => name,
        get: () => userAccount({
          async ensureProfile() { return bootstrappedProfile('owner@example.com'); },
          async removeWorkspace(_caller: UserCaller, name: string, ownerUserId: string) {
            removed.push({ name, ownerUserId });
          },
        }),
      },
      OrchestratorAgent: { idFromName: (name: string) => name, get: () => workspaceObject({}) },
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    };

    const identity: AuthIdentity = {
      userId: OWNER, email: 'owner@example.com', sub: 'sub', provider: 'test', authTime: Date.now(),
    };

    const del = (body?: { ownerUserId?: string }): Promise<Response | null> => serveFamily(userRoutes, { identity, ctx: workerContext() })(new Request(
      'https://kinu.example.com/api/user/workspaces/jarvis',
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    ), env);

    // The session's id is the destroy authority; a forged body cannot retarget it.
    expect((await del())?.status).toBe(200);
    expect((await del({ ownerUserId: 'f'.repeat(32) }))?.status).toBe(200);
    expect(removed).toEqual([
      { name: 'jarvis', ownerUserId: OWNER },
      { name: 'jarvis', ownerUserId: OWNER },
    ]);

    const harness = orchestratorHarness();
    await expect(harness.agent.destroyAgent('b'.repeat(32)))
      .rejects.toThrow('Agent owner mismatch; refusing to destroy.');
  });

  test('a workspace whose schema never initialized is deleted: roster row and object storage go together', async () => {
    // Half-born: a create that died before `ensureSchema` has no `workspace_identity`, so `destroyAgent`'s
    // owner read throws.
    const halfBorn = halfBornOrchestratorHarness({ workspace: 'jarvis' });
    expect(halfBorn.tableNames()).not.toContain('workspace_identity');
    expect(halfBorn.tableNames()).toContain('workspace_capability');

    const userDO = createTestUserDO({
      durableObjectId: USER_ID,
      destroyWorkspaceGate: async (_name, ownerUserId) => {
        await halfBorn.agent.destroyAgent(ownerUserId);
      },
    });

    const env = {
      UserDO: { idFromName: (name: string) => name, get: () => userDO.userDO },
      OrchestratorAgent: { idFromName: (name: string) => name, get: () => workspaceObject({}) },
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    };

    const owner = await testOwner();
    await userDO.userDO.registerWorkspace(owner, 'jarvis');

    const identity: AuthIdentity = {
      userId: USER_ID, email: 'owner@example.com', sub: 'sub', provider: 'test', authTime: Date.now(),
    };

    const response = await serveFamily(userRoutes, { identity, ctx: workerContext() })(new Request(
      'https://kinu.example.com/api/user/workspaces/jarvis', { method: 'DELETE' },
    ), env);

    expect(response?.status).toBe(200);
    expect(userDO.destroyedWorkspaces).toEqual(['jarvis']);
    expect(halfBorn.tableNames().filter((name) => name !== 'sqlite_sequence')).toEqual([]);
    // Out of the registry, not parked `delete_pending`.
    expect(userDO.sql.exec(`SELECT name FROM user_workspaces`).toArray()).toEqual([]);
  });

  test('a healthy workspace whose owner does not match is still refused, row and storage intact', async () => {
    // The half-born skip must not widen: an initialized workspace with another owner is not destroyed.
    const OTHER = 'b'.repeat(32);
    const healthy = orchestratorHarness(undefined, { workspace: 'jarvis', ownerUserId: OTHER });

    const userDO = createTestUserDO({
      durableObjectId: USER_ID,
      destroyWorkspaceGate: async (_name, ownerUserId) => {
        await healthy.agent.destroyAgent(ownerUserId);
      },
    });

    const env = {
      UserDO: { idFromName: (name: string) => name, get: () => userDO.userDO },
      OrchestratorAgent: { idFromName: (name: string) => name, get: () => workspaceObject({}) },
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    };

    const owner = await testOwner();
    await userDO.userDO.registerWorkspace(owner, 'jarvis');

    const response = await serveFamily(userRoutes, { identity: {
      userId: USER_ID, email: 'owner@example.com', sub: 'sub', provider: 'test', authTime: Date.now(),
    }, ctx: workerContext() })(new Request(
      'https://kinu.example.com/api/user/workspaces/jarvis', { method: 'DELETE' },
    ), env);

    expect(response?.status).toBe(400);
    expect(healthy.tableNames()).toContain('workspace_identity');
  });
});

/** `user_workspaces` as accounts created before the 2026-09-22 deploy hold it; `IF NOT EXISTS` keeps this CHECK live. */
const GENESIS_USER_WORKSPACES_DDL = `
  CREATE TABLE user_workspaces (
    name          TEXT PRIMARY KEY,
    display_name  TEXT NOT NULL,
    name_origin   TEXT NOT NULL DEFAULT 'user' CHECK (name_origin IN ('auto', 'user')),
    created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    last_visited  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    archived_at   INTEGER,
    delete_pending INTEGER NOT NULL DEFAULT 0,
    create_pending INTEGER NOT NULL DEFAULT 0,
    fork_lease_expires_at INTEGER
  )`;

describe('a create on an account whose registry predates the current build', () => {
  test('a mission-only create lands, and its stand-in title is the system\'s', async () => {
    // The live P0 of 2026-09-22: mission-only creates on older accounts failed
    // `CHECK constraint failed: name_origin IN ('auto', 'user')`.
    const storage = new Database(':memory:');
    storage.exec(GENESIS_USER_WORKSPACES_DDL);
    const user = createTestUserDO({ durableObjectId: USER_ID, storage });

    const registry: CloudWorkspaceRegistry = {
      ...registryStub(),
      registerWorkspace: (caller, name, displayName, from) => user.userDO.registerWorkspace(caller, name, displayName, from),
      ensureWorkspaceCapability: (name, presented) => user.userDO.ensureWorkspaceCapability(name, presented),
    };

    const orchestrator = workspaceObject({
      async claimOwner(userId: string) { return { owner: userId, capabilityHash: null }; },
      async setInitialDisplayName(displayName: string, nameOrigin: NameOrigin) { return { displayName, nameOrigin }; },
      async setSoul(soul: string) { return { soul, purpose: '' }; },
      async resetWorkspaceBaseline() { return { ok: true as const, files: 0 }; },
      async setModel(spec: string) { return { ok: true, spec }; },
      async beginGenesisTurn() { return { started: true }; },
    });

    const env = {
      UserDO: { idFromName: (name: string) => name, get: () => registry },
      OrchestratorAgent: { idFromName: (name: string) => name, get: () => orchestrator },
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));

    try {
      const response = await handleCreateWorkspaceRequest({
        request: new Request('https://kinu.run/api/user/workspaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ purpose: 'Build a hello world app in react' }),
        }),
        env,
        userId: USER_ID,
        userDO: registry,
      });

      expect({ status: response.status, body: await response.text() })
        .toMatchObject({ status: 201 });
      expect(storage.query('SELECT display_name, name_origin FROM user_workspaces').all()).toEqual([
        { display_name: 'Build a hello world app in react', name_origin: 'auto' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      user.close();
      storage.close();
    }
  });
});
