// Connectable-provider catalog + models.dev catalog wiring through the
// per-agent registry composition.
import { describe, test, expect } from 'bun:test';
import { asFetchFunction } from '@kinu.run/core';
import { userCredentialSource } from './helpers/user-credentials';
import { createMockFetch } from '@kinu.run/test-utils';
import { createAgentProviderRegistry } from '../src/providers/agent-registry';
import { listProviderCatalog } from '../src/user/available-models';

const CATALOG = {
  groq: {
    id: 'groq', name: 'Groq', doc: 'https://console.groq.com/docs/models',
    env: ['GROQ_API_KEY'], npm: '@ai-sdk/openai-compatible',
    api: 'https://api.groq.com/openai/v1',
    models: {
      'llama-3.3-70b-versatile': { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', tool_call: true, limit: { context: 131072 } },
    },
  },
};

function fakeUserDOStub(creds: Record<string, Record<string, string>> = {}) {
  const list = Object.entries(creds).map(([key]) => ({
    key, kind: 'bearer' as const, createdAt: 0, updatedAt: 0,
  }));
  return userCredentialSource({
    getAuthHeaders: async (key: string) => creds[key] ?? null,
    hasCredential: async (key: string) => !!creds[key],
    listCredentials: async () => list,
    getCredentialBaseURL: async () => null,
  });
}

describe('agent registry × models.dev catalog', () => {
  test('a stored <id>.bearer key surfaces the catalog provider models', async () => {
    const mock = createMockFetch([
      { match: 'models.dev/api.json', respond: { status: 200, body: CATALOG } },
    ]);
    const reg = createAgentProviderRegistry({
      env: {},
      userDO: fakeUserDOStub({ 'groq.bearer': { Authorization: 'Bearer gsk' } }),
      fetch: mock.fetch,
    });
    const { models } = await reg.registry.listAllModels(reg.deps);
    expect(models.map((m) => `${m.provider}/${m.id}`)).toContain('groq/llama-3.3-70b-versatile');
  });

  test('normalizeSpecSync accepts a catalog provider spec', () => {
    const mock = createMockFetch([
      { match: 'models.dev/api.json', respond: { status: 200, body: CATALOG } },
    ]);
    const reg = createAgentProviderRegistry({
      env: {},
      userDO: fakeUserDOStub({ 'groq.bearer': { Authorization: 'Bearer gsk' } }),
      fetch: mock.fetch,
    });
    expect(reg.normalizeSpecSync('groq/llama-3.3-70b-versatile')).toBe('groq/llama-3.3-70b-versatile');
    expect(reg.resolveModel('groq/llama-3.3-70b-versatile')).toBeDefined();
  });
});

describe('listProviderCatalog', () => {
  const MODELS_DEV_API = {
    groq: {
      id: 'groq', name: 'Groq', doc: 'https://console.groq.com/docs/models',
      env: ['GROQ_API_KEY'], npm: '@ai-sdk/openai-compatible', api: 'https://api.groq.com/openai/v1',
      models: {},
    },
    anthropic: {
      id: 'anthropic', name: 'Anthropic', doc: 'https://docs.anthropic.com',
      env: ['ANTHROPIC_API_KEY'], npm: '@ai-sdk/anthropic', models: {},
    },
    mistral: {
      id: 'mistral', name: 'Mistral', doc: 'https://docs.mistral.ai',
      env: ['MISTRAL_API_KEY'], npm: '@ai-sdk/mistral', models: {},
    },
    'sap-ai-core': {
      id: 'sap-ai-core', name: 'SAP AI Core', doc: 'https://help.sap.com',
      env: ['SAP_AI_CORE_KEY'], npm: '@jerome-benoit/sap-ai-provider-v2', models: {},
    },
    'cloudflare-workers-ai': {
      id: 'cloudflare-workers-ai', name: 'Cloudflare Workers AI',
      env: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_KEY'], npm: '@ai-sdk/openai-compatible',
      api: 'https://api.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/v1', models: {},
    },
  };

  /** The catalog over a stubbed models.dev and the given stored keys. */
  async function listCatalog(storedKeys: string[] = []) {
    const list = storedKeys.map((key) => ({
      key, kind: 'bearer' as const, createdAt: 0, updatedAt: 0,
    }));
    const partialEnv: Partial<Env> = {};
    Object.assign(partialEnv, {
      UserDO: {
        idFromName: (name: string) => name,
        get: () => ({ listCredentials: async () => list }),
      },
    });
    // SAFETY: listProviderCatalog reaches env.UserDO alone. The constructed
    // namespace answers listCredentials, and no other Env binding is reachable
    // in this call.
    const env = partialEnv as Env;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response(JSON.stringify(MODELS_DEV_API), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    try {
      return await listProviderCatalog(env, 'user-1', { ownerToken: 'test-owner' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
  test('includes compat-path providers and bespoke-served ids only', async () => {
    const entries = await listCatalog();
    expect(entries.map((e) => e.id).sort()).toEqual(['anthropic', 'groq', 'mistral']);
  });

  test('entries carry credKey, docs, env var, and connected state; connected sort first', async () => {
    const entries = await listCatalog(['groq.bearer']);
    expect(entries[0]).toEqual({
      id: 'groq', credKey: 'groq.bearer', name: 'Groq',
      doc: 'https://console.groq.com/docs/models', envVar: 'GROQ_API_KEY', connected: true,
    });
    expect(entries[1]).toMatchObject({ id: 'anthropic', credKey: 'anthropic.bearer', connected: false });
  });
});
