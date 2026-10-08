import { describe, test, expect } from 'bun:test';
import { userCredentialSource } from './helpers/user-credentials';
import { createMockFetch } from '@kinu.run/test-utils';
import { createAgentProviderRegistry } from '../src/providers/agent-registry';

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
    hasCredential: async (key: string) => Boolean(creds[key]),
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
    expect(reg.resolveModel('groq/llama-3.3-70b-versatile', { sessionAffinity: 'kinu-test', workspaceAffinity: 'kinu-test' })).toBeDefined();
  });
});
