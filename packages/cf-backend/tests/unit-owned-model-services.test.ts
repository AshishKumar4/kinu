import { afterEach, describe, expect, test } from 'bun:test';
import { generateText } from 'ai';
import { createMockFetch } from '@proteus/test-utils';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OwnedModelServices } from '../src/owned-model-services.ts';

interface FakeUserDO {
  getAuthHeaders(key: string): Promise<Record<string, string> | null>;
  getCredentialBaseURL(key: string): Promise<string | null>;
  listCredentials(): Promise<Array<{ key: string; kind: 'bearer'; createdAt: number; updatedAt: number }>>;
}

function fakeUserDO(credentials: Record<string, Record<string, string>> = {}): FakeUserDO {
  return {
    async getAuthHeaders(key) { return credentials[key] ?? null; },
    async getCredentialBaseURL() { return null; },
    async listCredentials() {
      return Object.keys(credentials).map((key) => ({ key, kind: 'bearer' as const, createdAt: 0, updatedAt: 0 }));
    },
  };
}

function fakeEnv(stub: FakeUserDO = fakeUserDO()): Env {
  return {
    UserDO: {
      idFromName: (name: string) => name,
      get: () => stub,
    },
  } as unknown as Env;
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('OwnedModelServices', () => {
  test('ActorAgent and ExplorationAgent wire their distinct settled policies', () => {
    const source = (file: string) => readFileSync(join(import.meta.dir, '..', 'src', file), 'utf8');
    const actor = source('actor-agent.ts');
    const exploration = source('exploration.ts');

    expect(actor).toContain("appTitle: 'Proteus',\n    ownerRequired: true,");
    expect(exploration).toContain("appTitle: 'Proteus (exploration)',\n    ownerRequired: false,");
    expect(actor).toContain('return this.ownedModelServices.providerRegistry();');
    expect(actor).toContain('return this.ownedModelServices.getWebSearchProvider();');
    expect(actor).toContain('this.ownedModelServices.invalidate();');
    expect(exploration).not.toContain('createAgentProviderRegistry');
    expect(exploration).not.toMatch(/\n  getModel\(/);
  });

  test('required owners fail with ActorAgent\'s established error', () => {
    const services = new OwnedModelServices({
      env: fakeEnv(),
      agentName: () => 'actor',
      appTitle: 'Proteus',
      ownerRequired: true,
      getOwnerUserId: () => null,
    });

    expect(() => services.providerRegistry()).toThrow(
      'Agent has no owner_user_id yet — Worker must call claimOwner before any model use.',
    );
  });

  test('optional owners retain env-only registry behavior and provider order', () => {
    const services = new OwnedModelServices({
      env: {
        ...fakeEnv(),
        AI_GATEWAY_URL: 'https://gateway.example.test',
        AI_GATEWAY_AUTH: 'Bearer gateway-token',
      },
      agentName: () => 'head',
      appTitle: 'Proteus (exploration)',
      ownerRequired: false,
      getOwnerUserId: () => null,
    });

    expect(services.providerRegistry().registry.list().map((provider) => provider.id)).toEqual([
      'workers-ai', 'my-gateway', 'ai-gateway', 'codex', 'openai',
      'anthropic', 'openrouter', 'openai-compat',
    ]);
    const model = services.resolveModel();
    expect(model.provider).toBe('ai-gateway.chat');
    expect(model.modelId).toBe('workers-ai/@cf/moonshotai/kimi-k2.6');
  });

  test('resolves explicit specs and supplies the stable per-agent affinity key', () => {
    const services = new OwnedModelServices({
      env: fakeEnv(),
      agentName: () => 'research-head',
      appTitle: 'Proteus (exploration)',
      ownerRequired: false,
      getOwnerUserId: () => 'owner-1',
    });

    const model = services.resolveModel('openrouter/anthropic/claude-sonnet-4');
    expect(model.provider).toBe('openrouter.chat');
    expect(model.modelId).toBe('anthropic/claude-sonnet-4');
    expect(services.affinityKey).toBe('proteus-research-head');
  });

  test.each([
    ['Proteus', 'actor'],
    ['Proteus (exploration)', 'head'],
  ])('preserves OpenRouter X-Title %s', async (appTitle, agentName) => {
    const mock = createMockFetch([
      { match: 'openrouter.ai', respond: { status: 200, body: { choices: [] } } },
    ]);
    globalThis.fetch = mock.fetch;
    const services = new OwnedModelServices({
      env: fakeEnv(fakeUserDO({
        'openrouter.bearer': { Authorization: 'Bearer openrouter-token' },
      })),
      agentName: () => agentName,
      appTitle,
      ownerRequired: true,
      getOwnerUserId: () => 'owner-1',
    });

    try {
      await generateText({
        model: services.resolveModel('openrouter/anthropic/claude-sonnet-4'),
        prompt: 'hello',
        maxOutputTokens: 16,
      });
    } catch { /* Minimal mock response need not satisfy the AI SDK decoder. */ }

    expect(mock.requests[0]?.headers['x-title']).toBe(appTitle);
  });

  test('invalidate rebuilds owner-bound registry while the cached web provider resolves auth per call', async () => {
    const mock = createMockFetch([
      { match: 'duckduckgo.com', respond: { status: 200, body: '<html></html>', headers: { 'content-type': 'text/html' } } },
      {
        match: 'tavily.com',
        respond: {
          status: 200,
          body: { answer: 'owner result', results: [] },
          headers: { 'content-type': 'application/json' },
        },
      },
    ]);
    globalThis.fetch = mock.fetch;
    let owner: string | null = null;
    const services = new OwnedModelServices({
      env: fakeEnv(fakeUserDO({ 'tavily': { Authorization: 'Bearer tavily-token' } })),
      agentName: () => 'head',
      appTitle: 'Proteus (exploration)',
      ownerRequired: false,
      getOwnerUserId: () => owner,
    });
    const web = services.getWebSearchProvider();
    const beforeRegistry = services.providerRegistry();

    expect((await web.search('before claim')).source).toBe('duckduckgo');
    owner = 'owner-1';
    services.invalidate();
    expect(services.providerRegistry()).not.toBe(beforeRegistry);
    expect(services.getWebSearchProvider()).toBe(web);
    expect((await web.search('after claim')).source).toBe('tavily');
  });
});
