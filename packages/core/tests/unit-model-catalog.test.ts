import { describe, expect, test } from 'bun:test';
import { generateText } from 'ai';
import {
  CODEX_CRED_KEY,
  PROVIDER_SDK_RETRIES,
  OPENAI_CRED_KEY,
  catalogModelInfo,
  codexEgressAllowed,
  createCodexProvider,
  createOpenAIProvider,
  createProviderRegistry,
  toProviderError,
  type AuthResolution,
  type ProviderDeps,
} from '../src/index';

function deps(creds: Record<string, AuthResolution>, fetchFn: typeof fetch): ProviderDeps {
  const store = new Map(Object.entries(creds));

  return {
    env: {},
    fetch: fetchFn,
    async getAuth(key) { return store.get(key) ?? null; },
    async hasCredential(key) { return store.has(key); },
  };
}

function fetchStub(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, { preconnect: fetch.preconnect });
}

function requestedUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

describe('provider model catalogs', () => {
  test('OpenAI model menu comes from models.dev when available', async () => {
    const provider = createOpenAIProvider();

    const fetchFn = fetchStub(async (input) => {
      expect(requestedUrl(input)).toBe('https://models.dev/api.json');

      return Response.json({
        openai: {
          models: {
            'gpt-5.5': {
              id: 'gpt-5.5',
              name: 'GPT-5.5',
              tool_call: true,
              reasoning: true,
              reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] }],
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
    });

    const models = await provider.listModels(deps({
      [OPENAI_CRED_KEY]: { headers: { Authorization: 'Bearer sk-test' } },
    }, fetchFn));

    expect(models).toEqual([{
      id: 'gpt-5.5',
      label: 'GPT-5.5',
      capabilities: ['streaming', 'tools', 'reasoning', 'vision'],
      contextWindow: 1_050_000,
      inputModalities: ['text', 'image'],
      reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    }]);
  });

  test('the levels are the effort row models.dev records; a toggle, a budget or nothing offers none', async () => {
    // Only an `effort` row names levels, in the provider's order; an unknown spelling drops without emptying the rest.
    const provider = createOpenAIProvider();

    const fetchFn = fetchStub(async () => Response.json({
      openai: {
        models: {
          'gpt-next': { id: 'gpt-next', tool_call: true, reasoning: true, reasoning_options: [{ type: 'effort', values: ['high', 'ultra', 'low'] }] },
          'gpt-toggle': { id: 'gpt-toggle', tool_call: true, reasoning: true, reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens', min: 1024 }] },
          'gpt-bare': { id: 'gpt-bare', tool_call: true, reasoning: true },
          'gpt-plain': { id: 'gpt-plain', tool_call: true, reasoning: false, reasoning_options: [] },
        },
      },
    }));

    const byId = new Map((await provider.listModels(deps({
      [OPENAI_CRED_KEY]: { headers: { Authorization: 'Bearer sk-test' } },
    }, fetchFn))).map((model) => [model.id, model]));

    expect(byId.get('gpt-next')?.reasoningEfforts).toEqual(['high', 'low']);
    expect(byId.get('gpt-toggle')?.reasoningEfforts).toEqual([]);
    expect(byId.get('gpt-bare')?.reasoningEfforts).toEqual([]);
    expect(byId.get('gpt-plain')?.reasoningEfforts).toEqual([]);
  });

  test('models.dev per-model prices reach ModelInfo, and half-priced entries do not', async () => {
    const provider = createOpenAIProvider();

    const fetchFn = fetchStub(async () => Response.json({
      openai: {
        models: {
          priced: {
            id: 'priced', name: 'Priced', tool_call: true, limit: { context: 1000 },
            cost: { input: 5, output: 30, cache_read: 1.25 },
          },
          free: {
            id: 'free', name: 'Free', tool_call: true, limit: { context: 1000 },
            cost: { input: 0, output: 0 },
          },
          'output-only': {
            id: 'output-only', name: 'Half', tool_call: true, limit: { context: 1000 },
            cost: { output: 30 },
          },
        },
      },
    }));

    const models = await provider.listModels(deps({
      [OPENAI_CRED_KEY]: { headers: { Authorization: 'Bearer sk-test' } },
    }, fetchFn));

    const byId = new Map(models.map((m) => [m.id, m]));

    expect(byId.get('priced')?.cost).toEqual({ input: 5, output: 30, cacheRead: 1.25 });
    expect(byId.get('free')?.cost).toEqual({ input: 0, output: 0 });
    expect(byId.get('output-only')?.cost).toBeUndefined();
  });

  test('Codex model menu uses the ChatGPT Codex model endpoint', async () => {
    const provider = createCodexProvider({ baseURL: 'https://chatgpt.test/backend-api/codex' });

    const fetchFn = fetchStub(async (input, init) => {
      expect(requestedUrl(input)).toBe('https://chatgpt.test/backend-api/codex/models?client_version=1.0.0');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer codex-token');

      return Response.json({
        models: [
          {
            slug: 'gpt-5.5',
            display_name: 'GPT-5.5',
            visibility: 'list',
            priority: 20,
            context_window: 272_000,
            supported_reasoning_levels: [{ effort: 'low', description: 'fast' }, 'high', 'ultra'],
            input_modalities: ['text', 'image'],
          },
        ],
      });
    });

    const models = await provider.listModels(deps({
      [CODEX_CRED_KEY]: { headers: { Authorization: 'Bearer codex-token' } },
    }, fetchFn));

    expect(models).toEqual([{
      id: 'gpt-5.5',
      label: 'GPT-5.5',
      capabilities: ['tools', 'streaming', 'reasoning', 'vision'],
      contextWindow: 272_000,
      inputModalities: ['text', 'image'],
      reasoningEfforts: ['low', 'high'],
    }]);
  });

  const blockPage = (): Response => new Response(
    '<html><body><p>Unable to load site</p><p>If you are using a VPN, try turning it off.</p></body></html>',
    { status: 403, headers: { 'content-type': 'text/html; charset=UTF-8', server: 'cloudflare' } },
  );

  const codexDeps = (fetchFn: typeof fetch) => deps({ [CODEX_CRED_KEY]: { headers: { Authorization: 'Bearer codex-token' } } }, fetchFn);

  test('a refused Codex model list is a named failure beside the built-in list, never a silent stale list', async () => {
    const registry = createProviderRegistry();
    registry.register(createCodexProvider({ baseURL: 'https://chatgpt.test/backend-api/codex' }));

    const menu = await registry.listAllModels(codexDeps(fetchStub(async () => blockPage())));

    expect(menu.failures.map((failure) => failure.provider)).toEqual(['codex']);
    expect(menu.failures[0]?.reason).toContain('HTTP 403');
    expect(menu.models.some((model) => model.provider === 'codex' && model.id === 'gpt-5.5')).toBe(true);
  });

  test('an unreadable models.dev list is a named failure beside the built-in list', async () => {
    const registry = createProviderRegistry();
    registry.register(createOpenAIProvider());

    const menu = await registry.listAllModels(deps(
      { [OPENAI_CRED_KEY]: { headers: { Authorization: 'Bearer sk-test' } } },
      fetchStub(async () => new Response('upstream down', { status: 503 })),
    ));

    expect(menu.failures.map((failure) => failure.provider)).toEqual(['openai']);
    expect(menu.models.some((model) => model.provider === 'openai')).toBe(true);
  });

  test('a turn keeps the built-in entry for its model when the live list is refused', async () => {
    const info = await catalogModelInfo(createCodexProvider(), codexDeps(fetchStub(async () => blockPage())), 'gpt-5.5');

    expect(info?.contextWindow).toBe(272_000);
  });

  test('a Codex call refused by the block page fails once, as an unreachable network, not a login problem', async () => {
    let requests = 0;

    const model = createCodexProvider({ baseURL: 'https://chatgpt.test/backend-api/codex' })
      .createModel('gpt-5.5', codexDeps(fetchStub(async () => {
        requests++;

        return blockPage();
      })));

    let classified = toProviderError({ doing: 'calling the model', cause: new Error('a blocked call succeeded') });

    try {
      await generateText({ model, prompt: 'hi', maxRetries: PROVIDER_SDK_RETRIES });
    } catch (error) {
      classified = toProviderError({ doing: 'calling the model', cause: error });
    }

    expect({ requests, code: classified.code }).toEqual({ requests: 1, code: 'unavailable' });
    expect(classified.message + String(classified.cause)).toMatch(/refused this server's network/);
  });

  test('the Codex egress route carries the Codex API and plan usage, nothing else', () => {
    const carried = [
      ['GET', 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0'],
      ['POST', 'https://chatgpt.com/backend-api/codex/responses'],
      ['GET', 'https://chatgpt.com/backend-api/wham/usage'],
      ['GET', 'https://chatgpt.com/backend-api/conversation'],
      ['POST', 'https://chatgpt.com/backend-api/codex/models'],
      ['DELETE', 'https://chatgpt.com/backend-api/codex/responses'],
      ['POST', 'http://chatgpt.com/backend-api/codex/responses'],
      ['POST', 'https://chatgpt.com:8443/backend-api/codex/responses'],
      ['POST', 'https://chatgpt.com.example.com/backend-api/codex/responses'],
      ['POST', 'https://example.com/backend-api/codex/responses'],
      ['POST', 'https://chatgpt.com/backend-api/codex/responses/../../conversation'],
    ].map(([method, url]) => [method, url, codexEgressAllowed({ method: method ?? '', url: url ?? '' })]);

    expect(carried.filter(([, , allowed]) => allowed).map(([method, url]) => `${String(method)} ${String(url)}`)).toEqual([
      'GET https://chatgpt.com/backend-api/codex/models?client_version=1.0.0',
      'POST https://chatgpt.com/backend-api/codex/responses',
      'GET https://chatgpt.com/backend-api/wham/usage',
    ]);
  });
});
