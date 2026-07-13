import { describe, expect, test } from 'bun:test';
import {
  CODEX_CRED_KEY,
  OPENAI_CRED_KEY,
  createCodexProvider,
  createOpenAIProvider,
  type AuthResolution,
  type ProviderDeps,
} from '../src/index.ts';

function deps(creds: Record<string, AuthResolution>, fetchFn: typeof fetch): ProviderDeps {
  const store = new Map(Object.entries(creds));
  return {
    env: {},
    fetch: fetchFn,
    async getAuth(key) { return store.get(key) ?? null; },
    async hasCredential(key) { return store.has(key); },
  };
}

describe('provider model catalogs', () => {
  test('OpenAI model menu comes from models.dev when available', async () => {
    const provider = createOpenAIProvider();
    const fetchFn = async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://models.dev/api.json');
      return Response.json({
        openai: {
          models: {
            'gpt-5.5': {
              id: 'gpt-5.5',
              name: 'GPT-5.5',
              tool_call: true,
              reasoning: true,
              modalities: { input: ['text', 'image'] },
              limit: { context: 1_050_000 },
            },
            'text-only': {
              id: 'text-only',
              name: 'Text only',
              tool_call: false,
              limit: { context: 64_000 },
            },
            deprecated: {
              id: 'deprecated',
              name: 'Deprecated',
              status: 'deprecated',
              tool_call: true,
              limit: { context: 64_000 },
            },
          },
        },
      });
    };

    const models = await provider.listModels(deps({
      [OPENAI_CRED_KEY]: { headers: { Authorization: 'Bearer sk-test' } },
    }, fetchFn as typeof fetch));

    expect(models).toEqual([{
      id: 'gpt-5.5',
      label: 'GPT-5.5',
      capabilities: ['streaming', 'tools', 'reasoning', 'vision'],
      contextWindow: 1_050_000,
      inputModalities: ['text', 'image'],
    }]);
  });

  test('Codex model menu uses the ChatGPT Codex model endpoint', async () => {
    const provider = createCodexProvider({ baseURL: 'https://chatgpt.test/backend-api/codex' });
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://chatgpt.test/backend-api/codex/models?client_version=1.0.0');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer codex-token');
      return Response.json({
        models: [
          {
            slug: 'gpt-5.5',
            display_name: 'GPT-5.5',
            visibility: 'list',
            priority: 20,
            context_window: 272_000,
            supported_reasoning_levels: ['low', 'medium'],
            input_modalities: ['text', 'image'],
          },
        ],
      });
    };

    const models = await provider.listModels(deps({
      [CODEX_CRED_KEY]: { headers: { Authorization: 'Bearer codex-token' } },
    }, fetchFn as typeof fetch));

    expect(models).toEqual([{
      id: 'gpt-5.5',
      label: 'GPT-5.5',
      capabilities: ['tools', 'streaming', 'reasoning', 'vision'],
      contextWindow: 272_000,
      inputModalities: ['text', 'image'],
    }]);
  });
});
