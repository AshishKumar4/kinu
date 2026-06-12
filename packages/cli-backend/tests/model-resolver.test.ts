import { describe, expect, test } from 'bun:test';
import { generateText } from 'ai';
import { DEFAULT_WORKERS_AI_MODEL_SPEC } from '@proteus/core';
import type { LLMProviderConfig } from '@proteus/core';
import { cloudProxyBaseURL, createLocalModelResolver } from '../src/model-resolver.js';

describe('createLocalModelResolver', () => {
  test('normalizes Workers AI model ids to provider-style specs', async () => {
    const resolver = createLocalModelResolver({
      llm: {
        name: 'workers-ai',
        baseURL: 'https://gateway.example/v1',
        headers: { Authorization: 'Bearer cf-test' },
        model: '@cf/moonshotai/kimi-k2.6',
      },
      credentials: {},
      fetch: async () => Response.json({
        'cloudflare-workers-ai': {
          models: {
            '@cf/moonshotai/kimi-k2.6': {
              id: '@cf/moonshotai/kimi-k2.6',
              name: 'Kimi K2.6',
              tool_call: true,
              reasoning: true,
              limit: { context: 262_144 },
            },
          },
        },
      }),
    });

    expect(resolver.normalizeSpecSync(null)).toBe('workers-ai/@cf/moonshotai/kimi-k2.6');
    expect(resolver.normalizeSpecSync('@cf/meta/llama-4-scout-17b-16e-instruct'))
      .toBe('workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct');
    expect(resolver.normalizeSpecSync('minimax/m3')).toBe('workers-ai/minimax/m3');

    const providers = await resolver.listProviders();
    expect(providers.find((p) => p.id === 'workers-ai')?.available).toBe(true);
    expect(providers.find((p) => p.id === 'openai')?.available).toBe(false);

    const models = await resolver.listModels();
    expect(models.find((model) => model.provider === 'workers-ai' && model.id === '@cf/moonshotai/kimi-k2.6')?.contextWindow)
      .toBe(262_144);
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

  test('uses Anthropic as the default provider when the resolved local config is direct Anthropic', async () => {
    const resolver = createLocalModelResolver({
      llm: {
        name: 'anthropic',
        baseURL: 'https://api.anthropic.com/v1',
        headers: { 'x-api-key': 'sk-ant', 'anthropic-version': '2023-06-01' },
        model: 'claude-sonnet-4-5',
      },
      credentials: {},
      fetch: async () => new Response('{}'),
    });

    expect(resolver.normalizeSpecSync(null)).toBe('anthropic/claude-sonnet-4-5');
    const providers = await resolver.listProviders();
    expect(providers.find((p) => p.id === 'anthropic')?.available).toBe(true);
  });

  test('uses the direct OpenAI provider as default when configured from OpenAI credentials', () => {
    const resolver = createLocalModelResolver({
      llm: {
        name: 'openai',
        baseURL: 'https://api.openai.com/v1',
        headers: { Authorization: 'Bearer sk-openai' },
        model: 'gpt-4o-mini',
      },
      credentials: {},
      fetch: async () => new Response('{}'),
    });

    expect(resolver.normalizeSpecSync(null)).toBe('openai/gpt-4o-mini');
    expect(resolver.normalizeSpecSync('gpt-5')).toBe('openai/gpt-5');
  });
});

// ─── Signed-in cloud source — the worker's /api/user/ai/v1 proxy ───────────

const CLOUD_ORIGIN = 'https://proteus.example.com';
const CLOUD_TOKEN = 'ptc_0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz';

/** The llm config cli/config.ts derives for a signed-in user with no BYO keys. */
function proxyLLMConfig(origin = CLOUD_ORIGIN): LLMProviderConfig {
  return {
    name: 'workers-ai',
    baseURL: cloudProxyBaseURL(origin),
    headers: { Authorization: `Bearer ${CLOUD_TOKEN}` },
    model: '@cf/moonshotai/kimi-k2.6',
  };
}

function cloudMenuFetch(origin = CLOUD_ORIGIN): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${origin}/api/cli/models`) {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${CLOUD_TOKEN}`);
      return Response.json([
        {
          spec: 'workers-ai/@cf/moonshotai/kimi-k2.6', label: 'Kimi K2.6', provider: 'workers-ai',
          capabilities: ['tools', 'streaming'], contextWindow: 262144,
        },
        {
          spec: 'my-gateway/openai/gpt-4.1', label: 'GPT-4.1', provider: 'my-gateway',
          capabilities: ['tools'], contextWindow: 1047576,
        },
        { spec: 'codex/gpt-5.3-codex', label: 'Codex', provider: 'codex' },
      ]);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

describe('createLocalModelResolver — signed in (cloud proxy)', () => {
  test('lists workers-ai and my-gateway models from the server menu with metadata', async () => {
    const resolver = createLocalModelResolver({
      llm: proxyLLMConfig(),
      credentials: {},
      cloud: { origin: CLOUD_ORIGIN, token: CLOUD_TOKEN },
      fetch: cloudMenuFetch(),
    });

    const providers = await resolver.listProviders();
    expect(providers.find((p) => p.id === 'workers-ai')?.available).toBe(true);
    expect(providers.find((p) => p.id === 'my-gateway')?.available).toBe(true);

    const models = await resolver.listModels();
    const workersAI = models.find((m) => m.provider === 'workers-ai' && m.id === '@cf/moonshotai/kimi-k2.6');
    expect(workersAI?.contextWindow).toBe(262144);
    expect(workersAI?.capabilities).toEqual(['tools', 'streaming']);
    const gateway = models.find((m) => m.provider === 'my-gateway' && m.id === 'openai/gpt-4.1');
    expect(gateway?.label).toBe('GPT-4.1');
    expect(gateway?.contextWindow).toBe(1047576);
    // Other providers' menu rows never leak into the proxy providers.
    expect(models.some((m) => m.provider === 'workers-ai' && m.id.includes('codex'))).toBe(false);
  });

  test('defaults to the same Workers AI model cloud agents get', () => {
    const resolver = createLocalModelResolver({
      llm: proxyLLMConfig(),
      credentials: {},
      cloud: { origin: CLOUD_ORIGIN, token: CLOUD_TOKEN },
      fetch: cloudMenuFetch(),
    });
    expect(resolver.normalizeSpecSync(null)).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
    expect(resolver.normalizeSpecSync('my-gateway/openai/gpt-4.1')).toBe('my-gateway/openai/gpt-4.1');
  });

  test('resolved models call the proxy with the CLI bearer and the wire model id', async () => {
    const seen: Array<{ path: string; auth: string | null; affinity: string | null; model: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const body = await request.json() as { model?: unknown };
        seen.push({
          path: new URL(request.url).pathname,
          auth: request.headers.get('authorization'),
          affinity: request.headers.get('x-session-affinity'),
          model: body.model,
        });
        return Response.json({
          id: 'chatcmpl-1', object: 'chat.completion', created: 0, model: String(body.model),
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const resolver = createLocalModelResolver({
        llm: proxyLLMConfig(origin),
        credentials: {},
        cloud: { origin, token: CLOUD_TOKEN, sessionAffinity: 'proteus-jarvis' },
        fetch: cloudMenuFetch(origin),
      });

      const viaWorkersAI = await generateText({ model: resolver.resolveModel(null), prompt: 'ping' });
      expect(viaWorkersAI.text).toBe('ok');
      const viaGateway = await generateText({ model: resolver.resolveModel('my-gateway/openai/gpt-4.1'), prompt: 'ping' });
      expect(viaGateway.text).toBe('ok');

      expect(seen.map((s) => s.path)).toEqual(['/api/user/ai/v1/chat/completions', '/api/user/ai/v1/chat/completions']);
      expect(seen.map((s) => s.model)).toEqual(['@cf/moonshotai/kimi-k2.6', 'openai/gpt-4.1']);
      for (const request of seen) {
        expect(request.auth).toBe(`Bearer ${CLOUD_TOKEN}`);
        expect(request.affinity).toBe('proteus-jarvis');
      }
    } finally {
      server.stop(true);
    }
  });

  test('an explicit direct Workers AI endpoint keeps precedence over the proxy', async () => {
    const direct: LLMProviderConfig = {
      name: 'workers-ai',
      baseURL: 'https://gateway.example/v1',
      headers: { Authorization: 'Bearer cf-direct' },
      model: '@cf/moonshotai/kimi-k2.6',
    };
    const resolver = createLocalModelResolver({
      llm: direct,
      credentials: {},
      cloud: { origin: CLOUD_ORIGIN, token: CLOUD_TOKEN },
      fetch: cloudMenuFetch(),
    });
    const providers = await resolver.listProviders();
    // The workers-ai id is the BYO direct endpoint; the proxy still serves my-gateway.
    expect(providers.find((p) => p.id === 'workers-ai')?.label).toBe('Cloudflare Workers AI (local gateway)');
    expect(providers.find((p) => p.id === 'my-gateway')?.label).toBe('Your AI Gateway');
    expect(providers.find((p) => p.id === 'my-gateway')?.available).toBe(true);
  });
});

describe('createLocalModelResolver — signed out', () => {
  test('cloud providers stay visible but honestly unavailable with the auth hint', async () => {
    const resolver = createLocalModelResolver({
      llm: {
        name: 'openai',
        baseURL: 'https://api.openai.com/v1',
        headers: { Authorization: 'Bearer sk-openai' },
        model: 'gpt-4o-mini',
      },
      credentials: { openaiApiKey: 'sk-openai' },
      fetch: async () => new Response('{}'),
    });

    const providers = await resolver.listProviders();
    for (const id of ['workers-ai', 'my-gateway']) {
      const provider = providers.find((p) => p.id === id);
      expect(provider?.available).toBe(false);
      expect(provider?.unavailableReason).toContain('proteus auth');
    }
    expect(() => resolver.resolveModel('my-gateway/openai/gpt-4.1')).toThrow(/proteus auth/);
  });
});
