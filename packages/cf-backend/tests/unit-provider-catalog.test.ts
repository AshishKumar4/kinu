// Connectable-provider catalog + models.dev catalog wiring through the
// per-agent registry composition.
import { describe, test, expect } from 'bun:test';
import { userCredentialSource } from './helpers/user-credentials.js';
import { createMockFetch } from '@proteus/test-utils';
import type { ModelsDevProviderInfo } from '@proteus/core';
import { createAgentProviderRegistry } from '../src/providers/agent-registry.ts';
import { buildProviderCatalog } from '../src/user/available-models.ts';

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

describe('buildProviderCatalog', () => {
  const providers: ModelsDevProviderInfo[] = [
    { id: 'groq', name: 'Groq', doc: 'https://console.groq.com/docs/models', env: ['GROQ_API_KEY'], npm: '@ai-sdk/openai-compatible', api: 'https://api.groq.com/openai/v1' },
    { id: 'anthropic', name: 'Anthropic', doc: 'https://docs.anthropic.com', env: ['ANTHROPIC_API_KEY'], npm: '@ai-sdk/anthropic' },
    { id: 'mistral', name: 'Mistral', doc: 'https://docs.mistral.ai', env: ['MISTRAL_API_KEY'], npm: '@ai-sdk/mistral' },
    { id: 'sap-ai-core', name: 'SAP AI Core', doc: 'https://help.sap.com', env: ['SAP_AI_CORE_KEY'], npm: '@jerome-benoit/sap-ai-provider-v2' },
    { id: 'cloudflare-workers-ai', name: 'Cloudflare Workers AI', env: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_KEY'], npm: '@ai-sdk/openai-compatible', api: 'https://api.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/v1' },
  ];
  const staticIds = new Set(['workers-ai', 'ai-gateway', 'codex', 'openai', 'anthropic', 'openrouter', 'openai-compat']);

  test('includes compat-path providers (catalog api or pinned endpoint) and bespoke-served ids only', () => {
    const entries = buildProviderCatalog(providers, staticIds, new Set());
    expect(entries.map((e) => e.id).sort()).toEqual(['anthropic', 'groq', 'mistral']);
  });

  test('entries carry credKey, docs, env var, and connected state; connected sort first', () => {
    const entries = buildProviderCatalog(providers, staticIds, new Set(['groq.bearer']));
    expect(entries[0]).toEqual({
      id: 'groq', credKey: 'groq.bearer', name: 'Groq',
      doc: 'https://console.groq.com/docs/models', envVar: 'GROQ_API_KEY', connected: true,
    });
    expect(entries[1]).toMatchObject({ id: 'anthropic', credKey: 'anthropic.bearer', connected: false });
  });
});
