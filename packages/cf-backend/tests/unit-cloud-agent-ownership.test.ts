import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCloudAgentForUser } from '../src/user/agent-create.js';
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
      async hasAgent(name: string) {
        calls.push(`has:${name}`);
        return false;
      },
      async registerAgent(name: string, displayName?: string) {
        calls.push(`register:${name}:${displayName ?? ''}`);
        return { name, displayName: displayName ?? name, createdAt: 1, lastVisited: 1, archivedAt: null };
      },
      async removeAgent(name: string, ownerUserId: string) {
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
      const entry = await createCloudAgentForUser(env, USER_ID, userDO as unknown as DurableObjectStub<UserDO>, {
        purpose: 'Build a hello world app in react',
      }, {
        waitUntil: (promise) => background.push(promise),
        suggestDisplayName: async () => 'React Hello World',
      });

      expect(entry.name.startsWith('agent-')).toBe(true);
      expect(entry.displayName).toBe('Build a hello world app in react');
      expect(calls).toContain(`claim:${USER_ID}`);
      expect(calls).toContain('soul');
      expect(background).toHaveLength(1);
      await Promise.all(background);
      expect(calls).toContain('auto-title:React Hello World');
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
      async hasAgent(name: string) {
        calls.push(`has:${name}`);
        return false;
      },
      async registerAgent(name: string, displayName?: string) {
        calls.push(`register:${name}:${displayName ?? ''}`);
        return { name, displayName: displayName ?? name, createdAt: 1, lastVisited: 1, archivedAt: null };
      },
      async removeAgent(name: string, ownerUserId: string) {
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
      await expect(createCloudAgentForUser(env, USER_ID, userDO as unknown as DurableObjectStub<UserDO>, {
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

  test('delete route and teardown require owner-scoped destroy', () => {
    const userRoutes = source('src/user/routes.ts');
    const userDO = source('src/user/user-do.ts');
    const orchestrator = source('src/orchestrator.ts');

    expect(userRoutes).toContain('stub.removeAgent(decodeURIComponent(agentMatch[1]), identity.userId)');
    expect(userDO).toContain('async removeAgent(name: string, ownerUserId: string): Promise<void>');
    expect(userDO).toContain('await stub.destroyAgent(ownerUserId)');
    expect(orchestrator).toContain('async destroyAgent(expectedOwnerUserId: string): Promise<{ ok: true }>');
    expect(orchestrator).toContain('Agent owner mismatch; refusing to destroy.');
  });
});
