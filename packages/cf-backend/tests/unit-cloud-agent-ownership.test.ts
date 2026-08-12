import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do.js';
import { describe, expect, test } from 'bun:test';
import { asFetchFunction } from '@proteus/core';
import { testOwner } from './helpers/user-do.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCloudWorkspaceForUser } from '../src/user/workspace-create.js';
import { claimOwnedWorkspace } from '../src/user/workspace-access.js';
import type { UserDO } from '../src/user/user-do.js';

const USER_ID = '0123456789abcdef0123456789abcdef';
const ROOT = join(import.meta.dir, '..');

function source(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

describe('cloud agent ownership safety', () => {
  test('mission-only create does not block on generated cloud naming', async () => {
    const calls: string[] = [];
    const background: Promise<unknown>[] = [];
    const userDO = {
      async getConfig(_caller: unknown, key: string) {
        calls.push(`config:${key}`);
        return null;
      },
      async getAuthHeaders(_caller: unknown) {
        return { authorization: 'Bearer token' };
      },
      async getCredentialBaseURL(_caller: unknown) {
        return 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1';
      },
      async listCredentials(_caller: unknown) {
        return [];
      },
      async ensureWorkspaceCapability() {},
      async registerWorkspace(_caller: unknown, name: string, displayName?: string) {
        calls.push(`register:${name}:${displayName ?? ''}`);
        return {
          entry: { name, displayName: displayName ?? name, createdAt: 1, lastVisited: 1, archivedAt: null },
          existed: false,
        };
      },
      async removeWorkspace(_caller: unknown, name: string, ownerUserId: string) {
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
      async setProvisionalDisplayName(displayName: string) {
        calls.push(`provisional-title:${displayName}`);
      },
      async setModel(model: string) {
        calls.push(`model:${model}`);
      },
      async setAutoDisplayName(displayName: string) {
        calls.push(`auto-title:${displayName}`);
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
      }, CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY } as unknown as Env;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));
    try {
      const entry = await createCloudWorkspaceForUser(env, USER_ID, userDO as unknown as DurableObjectStub<UserDO>, await testOwner(), {
        purpose: 'Build a hello world app in react',
      }, {
        waitUntil: (promise) => background.push(promise),
        suggestDisplayName: async () => 'React Hello World',
      });

      expect(entry.name).toMatch(/^build-a-hello-world-app-[0-9a-f]{6}$/);
      expect(entry.displayName).toBe('Build a hello world app in react');
      expect(calls).toContain(`claim:${USER_ID}`);
      expect(calls).toContain('provisional-title:Build a hello world app in react');
      expect(calls).toContain('soul');
      expect(background).toHaveLength(1);
      await Promise.all(background);
      expect(calls).toContain('auto-title:React Hello World');

      const purposeless = await createCloudWorkspaceForUser(
        env,
        USER_ID,
        userDO as unknown as DurableObjectStub<UserDO>,
        await testOwner(),
        {},
        { waitUntil: (promise) => background.push(promise) },
      );
      expect(purposeless.name).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
      expect(purposeless.displayName).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
      expect(purposeless.displayName).not.toBe(purposeless.name);
      expect(background).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rolls back the local roster row when orchestrator owner claim fails', async () => {
    const calls: string[] = [];
    const userDO = {
      async getConfig(_caller: unknown, key: string) {
        calls.push(`config:${key}`);
        return null;
      },
      async getAuthHeaders(_caller: unknown) {
        return { authorization: 'Bearer token' };
      },
      async getCredentialBaseURL(_caller: unknown) {
        return 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1';
      },
      async listCredentials(_caller: unknown) {
        return [];
      },
      async ensureWorkspaceCapability() {},
      async registerWorkspace(_caller: unknown, name: string, displayName?: string) {
        calls.push(`register:${name}:${displayName ?? ''}`);
        return {
          entry: { name, displayName: displayName ?? name, createdAt: 1, lastVisited: 1, archivedAt: null },
          existed: false,
        };
      },
      async removeWorkspace(_caller: unknown, name: string, ownerUserId: string) {
        calls.push(`remove:${name}:${ownerUserId}`);
      },
    };
    const orchestrator = {
      async claimOwner(userId: string) {
        calls.push(`claim:${userId}`);
        throw new Error('Agent owned by a different user');
      },
      async setSoul() {
        calls.push('soul');
      },
      async setModel(model: string) {
        calls.push(`model:${model}`);
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
      }, CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY } as unknown as Env;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));
    try {
      await expect(createCloudWorkspaceForUser(env, USER_ID, userDO as unknown as DurableObjectStub<UserDO>, await testOwner(), {
        name: 'jarvis',
        displayName: 'Jarvis',
        purpose: 'Help with software projects',
      })).rejects.toThrow('Agent owned by a different user');
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toContain('register:jarvis:Jarvis');
    expect(calls).toContain(`claim:${USER_ID}`);
    expect(calls).toContain(`remove:jarvis:${USER_ID}`);
    expect(calls).not.toContain('soul');
  });

  test('a failed create never destroys a pre-existing (archived) same-name agent', async () => {
    const calls: string[] = [];
    const userDO = {
      async getConfig(_caller: unknown) { return null; },
      async getAuthHeaders(_caller: unknown) { return { authorization: 'Bearer token' }; },
      async getCredentialBaseURL(_caller: unknown) {
        return 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1';
      },
      async listCredentials(_caller: unknown) { return []; },
      // The roster row exists but is ARCHIVED — registerWorkspace resurrects it
      // on name conflict and reports existed: true.
      async ensureWorkspaceCapability() {},
      async registerWorkspace(_caller: unknown, name: string, displayName?: string) {
        calls.push(`register:${name}`);
        return {
          entry: { name, displayName: displayName ?? name, createdAt: 1, lastVisited: 1, archivedAt: null },
          existed: true,
        };
      },
      async removeWorkspace(_caller: unknown, name: string, ownerUserId: string) {
        calls.push(`remove:${name}:${ownerUserId}`);
      },
    };
    const orchestrator = {
      async claimOwner() {
        calls.push('claim');
        throw new Error('boot failure');
      },
    };
    const env = {
      UserDO: { idFromName(name: string) { return name; }, get() { return userDO; } },
      OrchestratorAgent: { idFromName(name: string) { return name; }, get() { return orchestrator; } }, CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY } as unknown as Env;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));
    try {
      await expect(createCloudWorkspaceForUser(env, USER_ID, userDO as unknown as DurableObjectStub<UserDO>, await testOwner(), {
        name: 'jarvis',
      })).rejects.toThrow('boot failure');
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toContain('register:jarvis');
    expect(calls).toContain('claim');
    // Pre-fix this destroyed the archived agent's entire DO storage.
    expect(calls.some((c) => c.startsWith('remove:'))).toBe(false);
  });

  test('a newly created workspace is given its identity before anything else touches it', async () => {
    const calls: string[] = [];
    const userDO = {
      async getConfig() { return null; },
      async getAuthHeaders() { return { authorization: 'Bearer token' }; },
      async getCredentialBaseURL() {
        return 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1';
      },
      async listCredentials() { return []; },
      async registerWorkspace(_caller: unknown, name: string, displayName?: string) {
        calls.push(`register:${name}`);
        return {
          entry: { name, displayName: displayName ?? name, createdAt: 1, lastVisited: 1, archivedAt: null },
          existed: false,
        };
      },
      async ensureWorkspaceCapability(name: string, presentedHash: string | null) {
        calls.push(`ensure:${name}:${presentedHash ?? 'none'}`);
      },
      async removeWorkspace() {},
    };
    const orchestrator = {
      // A freshly materialized workspace DO holds nothing yet.
      async claimOwner(userId: string) { calls.push(`claim:${userId}`); return { owner: userId, capabilityHash: null }; },
      async setProvisionalDisplayName() { calls.push('provisional-title'); },
      async setSoul() { calls.push('soul'); },
      async setModel() { calls.push('model'); },
    };
    const env = {
      UserDO: { idFromName: (n: string) => n, get: () => userDO },
      OrchestratorAgent: { idFromName: (n: string) => n, get: () => orchestrator }, CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY } as unknown as Env;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response('{}', { status: 503 }));
    try {
      await createCloudWorkspaceForUser(env, USER_ID, userDO as unknown as DurableObjectStub<UserDO>, await testOwner(), {
        name: 'jarvis',
        displayName: 'Jarvis',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    // A new workspace runs its first turn — an auto-title, a peer's task, an
    // inbound email — without ever being opened, so its identity must exist
    // before any of that, not on first visit.
    expect(calls).toEqual([
      'register:jarvis', `claim:${USER_ID}`, 'ensure:jarvis:none',
      'provisional-title', 'soul', 'model',
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
        OrchestratorAgent: { idFromName: (n: string) => n, get: () => workspace }, CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY } as unknown as Env;
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

  test('delete route and teardown require owner-scoped destroy', () => {
    const userRoutes = source('src/user/routes.ts');
    const userDO = source('src/user/user-do.ts');
    const orchestrator = source('src/orchestrator.ts');

    expect(userRoutes).toContain('stub.removeWorkspace(await ownerCaller(env), decodeURIComponent(agentMatch[1]), identity.userId)');
    expect(userDO).toContain('async removeWorkspace(caller: UserCaller, name: string, ownerUserId: string): Promise<void>');
    expect(userDO).toContain('await stub.destroyAgent(ownerUserId)');
    expect(orchestrator).toContain('async destroyAgent(expectedOwnerUserId: string): Promise<{ ok: true }>');
    expect(orchestrator).toContain('Agent owner mismatch; refusing to destroy.');
  });
});
