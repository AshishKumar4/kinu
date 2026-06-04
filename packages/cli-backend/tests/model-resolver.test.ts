import { describe, expect, test } from 'bun:test';
import { createLocalModelResolver } from '../src/model-resolver.js';

describe('createLocalModelResolver', () => {
  test('normalizes legacy Workers AI model ids to provider-style specs', async () => {
    const resolver = createLocalModelResolver({
      llm: {
        name: 'workers-ai',
        baseURL: 'https://gateway.example/v1',
        headers: { Authorization: 'Bearer cf-test' },
        model: '@cf/moonshotai/kimi-k2.6',
      },
      credentials: {},
      fetch: async () => new Response('{}'),
    });

    expect(resolver.normalizeSpecSync(null)).toBe('workers-ai/@cf/moonshotai/kimi-k2.6');
    expect(resolver.normalizeSpecSync('@cf/meta/llama-4-scout-17b-16e-instruct'))
      .toBe('workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct');
    expect(resolver.normalizeSpecSync('minimax/m3')).toBe('workers-ai/minimax/m3');

    const providers = await resolver.listProviders();
    expect(providers.find((p) => p.id === 'workers-ai')?.available).toBe(true);
    expect(providers.find((p) => p.id === 'openai')?.available).toBe(false);
  });

  test('exposes local direct-provider credentials through the shared provider registry', async () => {
    const resolver = createLocalModelResolver({
      llm: {
        name: 'openai-compat',
        baseURL: 'https://compat.example/v1',
        headers: { Authorization: 'Bearer compat-test' },
        model: 'default-model',
      },
      credentials: {
        openaiApiKey: 'sk-openai',
        anthropicApiKey: 'sk-ant',
        openrouterApiKey: 'sk-or',
        openaiCompat: {
          groq: { baseURL: 'https://api.groq.com/openai/v1', apiKey: 'gsk' },
        },
      },
      fetch: async () => new Response(JSON.stringify({ data: [] })),
    });

    expect(resolver.normalizeSpecSync('openai/gpt-5')).toBe('openai/gpt-5');
    expect(resolver.normalizeSpecSync('openai-compat:groq/llama-3')).toBe('openai-compat:groq/llama-3');

    const providers = await resolver.listProviders();
    for (const id of ['openai', 'anthropic', 'openrouter', 'openai-compat', 'openai-compat:groq']) {
      expect(providers.find((p) => p.id === id)?.available).toBe(true);
    }
  });
});
