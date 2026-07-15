import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCloudWorkspaceForUser } from '../src/user/workspace-create.js';
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
      async getConfig(key: string) {
        calls.push(`config:${key}`);
        return null;
      },
      async getAuthHeaders() {
        return { authorization: 'Bearer token' };
      },
      async getCredentialBaseURL() {
        return 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1';
      },
      async listCredentials() {
        return [];
      },
      async registerWorkspace(name: string, displayName?: string) {
        calls.push(`register:${name}:${displayName ?? ''}`);
        return {
          entry: { name, displayName: displayName ?? name, createdAt: 1, lastVisited: 1, archivedAt: null },
          existed: false,
        };
      },
      async removeWorkspace(name: string, ownerUserId: string) {
        calls.push(`remove:${name}:${ownerUserId}`);
      },
    };
    const orchestrator = {
      async claimOwner(userId: string) {
        calls.push(`claim:${userId}`);
        return { owner: userId };
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
      },
    } as unknown as Env;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('{}', { status: 503 });
    try {
      const entry = await createCloudWorkspaceForUser(env, USER_ID, userDO as unknown as DurableObjectStub<UserDO>, {
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
      async getConfig(key: string) {
        calls.push(`config:${key}`);
        return null;
      },
      async getAuthHeaders() {
        return { authorization: 'Bearer token' };
      },
      async getCredentialBaseURL() {
        return 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1';
      },
      async listCredentials() {
        return [];
      },
      async registerWorkspace(name: string, displayName?: string) {
        calls.push(`register:${name}:${displayName ?? ''}`);
        return {
          entry: { name, displayName: displayName ?? name, createdAt: 1, lastVisited: 1, archivedAt: null },
          existed: false,
        };
      },
      async removeWorkspace(name: string, ownerUserId: string) {
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
      },
    } as unknown as Env;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('{}', { status: 503 });
    try {
      await expect(createCloudWorkspaceForUser(env, USER_ID, userDO as unknown as DurableObjectStub<UserDO>, {
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
      async getConfig() { return null; },
      async getAuthHeaders() { return { authorization: 'Bearer token' }; },
      async getCredentialBaseURL() {
        return 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1';
      },
      async listCredentials() { return []; },
      // The roster row exists but is ARCHIVED — registerWorkspace resurrects it
      // on name conflict and reports existed: true.
      async registerWorkspace(name: string, displayName?: string) {
        calls.push(`register:${name}`);
        return {
          entry: { name, displayName: displayName ?? name, createdAt: 1, lastVisited: 1, archivedAt: null },
          existed: true,
        };
      },
      async removeWorkspace(name: string, ownerUserId: string) {
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
      OrchestratorAgent: { idFromName(name: string) { return name; }, get() { return orchestrator; } },
    } as unknown as Env;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('{}', { status: 503 });
    try {
      await expect(createCloudWorkspaceForUser(env, USER_ID, userDO as unknown as DurableObjectStub<UserDO>, {
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

  test('delete route and teardown require owner-scoped destroy', () => {
    const userRoutes = source('src/user/routes.ts');
    const userDO = source('src/user/user-do.ts');
    const orchestrator = source('src/orchestrator.ts');

    expect(userRoutes).toContain('stub.removeWorkspace(decodeURIComponent(agentMatch[1]), identity.userId)');
    expect(userDO).toContain('async removeWorkspace(name: string, ownerUserId: string): Promise<void>');
    expect(userDO).toContain('await stub.destroyAgent(ownerUserId)');
    expect(orchestrator).toContain('async destroyAgent(expectedOwnerUserId: string): Promise<{ ok: true }>');
    expect(orchestrator).toContain('Agent owner mismatch; refusing to destroy.');
  });
});
