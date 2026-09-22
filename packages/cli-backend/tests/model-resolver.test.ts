import { describe, expect, test } from 'bun:test';
import { generateText } from 'ai';
import {
  DEFAULT_WORKERS_AI_MODEL_ID, DEFAULT_WORKERS_AI_MODEL_SPEC, JsonObjectSchema, KINU_USER_AGENT, usageTotal,
} from '@kinu.run/core';
import type { JsonObject, JsonValue, LLMProviderConfig, ModelCallReport } from '@kinu.run/core';
import { cloudProxyBaseURL, createLocalModelResolver, createLocalProviderLLM } from '../src/model-resolver';
import { asFetchFunction } from '@kinu.run/core';
import * as v from 'valibot';
import { createMockFetch, OPENCODE_GO_CATALOG, OPENAI_RESPONSES_BODY } from '@kinu.run/test-utils';

describe('createLocalModelResolver', () => {
  /** Neither lane may set an output cap, and a config object still carrying one must be inert. */
  test('neither lane this seam builds carries an output cap, whatever the config holds', async () => {
    const bodies: JsonObject[] = [];

    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const body = v.parse(JsonObjectSchema, await request.json());
        bodies.push(body);
        const model = v.parse(v.string(), body.model);

        if (body.stream === true) {
          const chunk = (delta: JsonObject, finish: JsonValue): string => `data: ${JSON.stringify({
            id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model,
            choices: [{ index: 0, delta, finish_reason: finish }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\n`;

          return new Response(
            `${chunk({ content: 'ok' }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }

        return Response.json({
          id: 'chatcmpl-1', object: 'chat.completion', created: 0, model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });

    const llm: LLMProviderConfig = {
      name: 'workers-ai',
      baseURL: `http://127.0.0.1:${server.port}/v1`,
      headers: { Authorization: 'Bearer test' },
      model: '@cf/test/model',
    };

    const staleCap = { maxTokens: 123 };

    try {
      await createLocalProviderLLM({ llm }).complete('uncapped');
      await createLocalProviderLLM({ llm: { ...llm, ...staleCap } }).complete('stale cap');
      let streamed = '';

      for await (const chunk of createLocalProviderLLM({ llm: { ...llm, ...staleCap } })
        .stream({ system: 'be brief', messages: [{ role: 'user', content: 'stream' }] })) {
        streamed += chunk;
      }

      expect(streamed).toBe('ok');
      expect(bodies).toHaveLength(3);

      for (const body of bodies) {
        expect(Object.hasOwn(body, 'max_tokens')).toBe(false);
        expect(Object.hasOwn(body, 'max_completion_tokens')).toBe(false);
      }
    } finally {
      await server.stop(true);
    }
  });

  // This seam alone sees judge / fast-tier / reflection spend; unmeasured spend must read as unmeasured, never free.
  test('reports every completed call, silent providers included', async () => {
    const reports: ModelCallReport[] = [];
    let quiet = false;

    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const body = v.parse(JsonObjectSchema, await request.json());

        const reply: JsonObject = {
          id: 'chatcmpl-1', object: 'chat.completion', created: 0, model: v.parse(v.string(), body.model),
          choices: [{ index: 0, message: { role: 'assistant', content: ' graded ' }, finish_reason: 'stop' }],
        };

        // No usage block (a real Workers AI shape): any `?? 0` here would call the judge free.
        if (!quiet) reply.usage = { prompt_tokens: 41, completion_tokens: 7, total_tokens: 48 };

        return Response.json(reply);
      },
    });

    const llm: LLMProviderConfig = {
      name: 'workers-ai',
      baseURL: `http://127.0.0.1:${server.port}/v1`,
      headers: { Authorization: 'Bearer test' },
      model: '@cf/test/model',
    };

    try {
      const judge = createLocalProviderLLM({
        llm, spend: { source: 'judge', report: (report) => { reports.push(report); } },
      });

      expect(await judge.complete('grade this')).toBe('graded');
      quiet = true;
      await judge.complete('grade this too');
    } finally {
      await server.stop(true);
    }

    expect(reports).toHaveLength(2);
    expect(reports[0]?.source).toBe('judge');
    expect(reports[0]?.spec).toBe('workers-ai/@cf/test/model');
    // `cacheRead` and `reasoning` arrive as the openai-compatible adapter's fabricated zeros; not this seam's to fix.
    expect(usageTotal(reports[0]?.usage ?? {})).toBe(48);
    expect(usageTotal(reports[1]?.usage ?? {})).toBeUndefined();
  });

  test('normalizes Workers AI model ids to provider-style specs', async () => {
    const resolver = createLocalModelResolver({
      llm: {
        name: 'workers-ai',
        baseURL: 'https://gateway.example/v1',
        headers: { Authorization: 'Bearer cf-test' },
        model: '@cf/moonshotai/kimi-k2.6',
      },
      credentials: {},
      fetch: asFetchFunction(async () => Response.json({
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
      })),
    });

    expect(resolver.normalizeSpecSync(null)).toBe('workers-ai/@cf/moonshotai/kimi-k2.6');
    expect(resolver.normalizeSpecSync('@cf/meta/llama-4-scout-17b-16e-instruct'))
      .toBe('workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct');
    expect(resolver.normalizeSpecSync('minimax/m3')).toBe('workers-ai/minimax/m3');

    const providers = await resolver.listProviders();
    expect(providers.find((p) => p.id === 'workers-ai')?.available).toBe(true);
    expect(providers.find((p) => p.id === 'openai')?.available).toBe(false);

    const { models } = await resolver.listModels();
    expect(models.find((model) => model.provider === 'workers-ai' && model.id === '@cf/moonshotai/kimi-k2.6')?.contextWindow)
      .toBe(262_144);
  });

  test('modelInfo resolves one spec to its catalog entry with input modalities', async () => {
    const resolver = createLocalModelResolver({
      llm: {
        name: 'workers-ai',
        baseURL: 'https://gateway.example/v1',
        headers: { Authorization: 'Bearer cf-test' },
        model: '@cf/zai-org/glm-5.2',
      },
      credentials: {},
      fetch: asFetchFunction(async () => Response.json({
        'cloudflare-workers-ai': {
          models: {
            '@cf/zai-org/glm-5.2': {
              id: '@cf/zai-org/glm-5.2',
              name: 'GLM 5.2',
              tool_call: true,
              modalities: { input: ['text'] },
              limit: { context: 200_000 },
            },
          },
        },
      })),
    });

    // A text-only model reports no media modalities, so the attachment sanitizer routes PDFs and images to the VFS.
    const info = await resolver.modelInfo('workers-ai/@cf/zai-org/glm-5.2');
    expect(info?.inputModalities).toEqual(['text']);
    expect(info?.contextWindow).toBe(200_000);
    expect(await resolver.modelInfo('workers-ai/@cf/unknown/model')).toBeNull();
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
      fetch: asFetchFunction(async () => new Response(JSON.stringify({ data: [] }))),
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
      fetch: asFetchFunction(async () => new Response('{}')),
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
      fetch: asFetchFunction(async () => new Response('{}')),
    });

    expect(resolver.normalizeSpecSync(null)).toBe('openai/gpt-4o-mini');
    expect(resolver.normalizeSpecSync('gpt-5')).toBe('openai/gpt-5');
  });
});

const CLOUD_ORIGIN = 'https://kinu.example.com';

const CLOUD_TOKEN = ['ptc_', '0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz'].join('');

function proxyLLMConfig(origin = CLOUD_ORIGIN): LLMProviderConfig {
  return {
    name: 'workers-ai',
    baseURL: cloudProxyBaseURL(origin),
    headers: { Authorization: `Bearer ${CLOUD_TOKEN}` },
    model: DEFAULT_WORKERS_AI_MODEL_ID,
  };
}

function cloudMenuFetch(origin = CLOUD_ORIGIN): typeof fetch {
  return asFetchFunction(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();

    if (url === `${origin}/api/cli/models`) {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${CLOUD_TOKEN}`);

      return Response.json({
        models: [
          {
            spec: DEFAULT_WORKERS_AI_MODEL_SPEC, label: 'DeepSeek V4 Pro 0813', provider: 'workers-ai',
            capabilities: ['tools', 'streaming', 'reasoning'], contextWindow: 1048576,
          },
          {
            spec: 'my-gateway/openai/gpt-4.1', label: 'GPT-4.1', provider: 'my-gateway',
            capabilities: ['tools'], contextWindow: 1047576,
          },
          { spec: 'codex/gpt-5.3-codex', label: 'Codex', provider: 'codex' },
        ],
        failures: [],
      });
    }

    return fetch(input, init);
  });
}

describe('createLocalModelResolver — signed in (cloud proxy)', () => {
  test('OpenCode Go preserves conversation identity and Responses through the credential proxy', async () => {
    const mock = createMockFetch([
      { match: 'models.dev/api.json', respond: { body: OPENCODE_GO_CATALOG } },
      { match: '/api/user/ai/proxy/credentials', respond: { body: {
        credentials: [{ key: 'opencode-go.bearer', baseURL: 'https://opencode.ai/zen/go/v1' }],
      } } },
      { match: '/api/cli/models', respond: { body: { models: [], failures: [] } } },
      { match: '/api/user/ai/proxy/forward', respond: { body: OPENAI_RESPONSES_BODY } },
    ]);

    const resolver = createLocalModelResolver({
      llm: proxyLLMConfig(), cloud: { origin: CLOUD_ORIGIN, token: CLOUD_TOKEN },
      fetch: mock.fetch, sessionAffinity: 'kinu-local-conversation',
    });

    await resolver.listModels();
    await generateText({ model: resolver.resolveModel('opencode-go/muse-spark-1.3-contributor'), prompt: 'hello' });
    const call = mock.requests.find((request) => request.url.endsWith('/api/user/ai/proxy/forward'));

    expect(call?.headers['x-kinu-proxy-target']).toBe('https://opencode.ai/zen/go/v1/responses');
    expect(call?.headers['x-opencode-session']).toBe('kinu-local-conversation');
    expect(call?.headers['user-agent']).toBe(KINU_USER_AGENT);
    expect(call?.headers.authorization).toBe(`Bearer ${CLOUD_TOKEN}`);
  });

  test('shares menu row admission, capability union and provider failure preservation', async () => {
    const resolver = createLocalModelResolver({
      llm: proxyLLMConfig(),
      credentials: {},
      cloud: { origin: CLOUD_ORIGIN, token: CLOUD_TOKEN },
      fetch: asFetchFunction(async (input) => (input instanceof Request ? input.url : input.toString()).endsWith('/api/cli/models')
        ? Response.json({
          models: [
            { spec: DEFAULT_WORKERS_AI_MODEL_SPEC, provider: 'workers-ai', capabilities: ['tools', 'invented'], reasoningEfforts: ['low'] },
            null,
            { spec: DEFAULT_WORKERS_AI_MODEL_SPEC, provider: 'workers-ai', capabilities: ['vision', 'tools'] },
          ],
          failures: [{ provider: ' my-gateway ', reason: ' account unavailable ' }, null],
        })
        : Response.json({ credentials: [] })),
    });

    const { models } = await resolver.listModels();
    const workersAI = models.filter((model) => model.provider === 'workers-ai');
    expect(workersAI).toHaveLength(1);
    expect(workersAI[0]?.capabilities).toEqual(['tools', 'vision']);
    expect(workersAI[0]?.reasoningEfforts).toEqual(['low']);
    const providers = await resolver.listProviders();
    expect(providers.find((provider) => provider.id === 'my-gateway')?.unavailableReason).toBe('account unavailable');
  });

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

    const { models } = await resolver.listModels();
    const workersAI = models.find((m) => m.provider === 'workers-ai' && m.id === DEFAULT_WORKERS_AI_MODEL_ID);
    expect(workersAI?.contextWindow).toBe(1048576);
    expect(workersAI?.capabilities).toEqual(['tools', 'reasoning', 'streaming']);
    const gateway = models.find((m) => m.provider === 'my-gateway' && m.id === 'openai/gpt-4.1');
    expect(gateway?.label).toBe('GPT-4.1');
    expect(gateway?.contextWindow).toBe(1047576);
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
    const seen: Array<{ path: string; auth: string | null; affinity: string | null; model: JsonValue | undefined }> = [];
    let wireCalls = 0;

    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        wireCalls++;
        const body = v.parse(JsonObjectSchema, await request.json());

        if (wireCalls === 1) {
          return new Response('limited', { status: 429, headers: { 'Retry-After': '0' } });
        }

        seen.push({
          path: new URL(request.url).pathname,
          auth: request.headers.get('authorization'),
          affinity: request.headers.get('x-session-affinity'),
          model: body.model,
        });

        return Response.json({
          id: 'chatcmpl-1', object: 'chat.completion', created: 0, model: v.parse(v.string(), body.model),
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
        cloud: { origin, token: CLOUD_TOKEN },
        sessionAffinity: 'kinu-jarvis',
        fetch: cloudMenuFetch(origin),
      });

      const viaWorkersAI = await generateText({
        model: resolver.resolveModel(null),
        prompt: 'ping',
        maxRetries: 0,
      });

      expect(viaWorkersAI.text).toBe('ok');
      const viaGateway = await generateText({ model: resolver.resolveModel('my-gateway/openai/gpt-4.1'), prompt: 'ping' });
      expect(viaGateway.text).toBe('ok');

      expect(seen.map((s) => s.path)).toEqual(['/api/user/ai/v1/chat/completions', '/api/user/ai/v1/chat/completions']);
      expect(wireCalls).toBe(3);
      expect(seen.map((s) => s.model)).toEqual([DEFAULT_WORKERS_AI_MODEL_ID, 'openai/gpt-4.1']);

      for (const request of seen) {
        expect(request.auth).toBe(`Bearer ${CLOUD_TOKEN}`);
        expect(request.affinity).toBe('kinu-jarvis');
      }
    } finally {
      await server.stop(true);
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
    expect(providers.find((p) => p.id === 'workers-ai')?.label).toBe('Cloudflare Workers AI (local gateway)');
    expect(providers.find((p) => p.id === 'my-gateway')?.label).toBe('Your AI Gateway');
    expect(providers.find((p) => p.id === 'my-gateway')?.available).toBe(true);
  });

  test('the explicit Workers AI endpoint carries the agent replica pin without a signed-in session', async () => {
    // Benchmark adapters run this way: KINU_BASE_URL + KINU_AUTH in a container with no `kinu auth`.
    const seen: Array<{ affinity: string | null; auth: string | null }> = [];

    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        await request.json();
        seen.push({ affinity: request.headers.get('x-session-affinity'), auth: request.headers.get('authorization') });

        return Response.json({
          id: 'chatcmpl-1', object: 'chat.completion', created: 0, model: 'echo',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });

    try {
      const endpoint = (name: 'workers-ai' | 'openai-compat', model: string): LLMProviderConfig => ({
        name, baseURL: `http://127.0.0.1:${server.port}/v1`, headers: { Authorization: 'Bearer cf-direct' }, model,
      });

      const pinned = createLocalModelResolver({
        llm: endpoint('workers-ai', '@cf/moonshotai/kimi-k2.6'), credentials: {}, sessionAffinity: 'kinu-harbor',
      });

      await generateText({ model: pinned.resolveModel(null), prompt: 'ping', maxRetries: 0 });

      const elsewhere = createLocalModelResolver({
        llm: endpoint('openai-compat', 'gpt-4o-mini'), credentials: {}, sessionAffinity: 'kinu-harbor',
      });

      await generateText({ model: elsewhere.resolveModel(null), prompt: 'ping', maxRetries: 0 });

      const explicit = createLocalModelResolver({
        llm: { ...endpoint('workers-ai', '@cf/moonshotai/kimi-k2.6'),
          headers: { Authorization: 'Bearer cf-direct', 'X-Session-Affinity': 'caller-pin' } },
        sessionAffinity: 'kinu-harbor',
      });

      await generateText({ model: explicit.resolveModel(null), prompt: 'ping', maxRetries: 0 });
      expect(seen).toEqual([
        { affinity: 'kinu-harbor', auth: 'Bearer cf-direct' },
        { affinity: null, auth: 'Bearer cf-direct' },
        { affinity: 'caller-pin', auth: 'Bearer cf-direct' },
      ]);
    } finally {
      await server.stop(true);
    }
  });
});

describe('createLocalModelResolver — claude subscription provider', () => {
  const openaiLlm: LLMProviderConfig = {
    name: 'openai',
    baseURL: 'https://api.openai.com/v1',
    headers: { Authorization: 'Bearer sk-openai' },
    model: 'gpt-4o-mini',
  };

  test('lists claude/* models when the binary is present and logged in', async () => {
    const resolver = createLocalModelResolver({
      llm: openaiLlm,
      credentials: {},
      fetch: asFetchFunction(async () => new Response('{}')),
      claudeCli: { probe: async () => ({ binary: true, loggedIn: true }) },
    });

    const providers = await resolver.listProviders();
    expect(providers.find((p) => p.id === 'claude')?.available).toBe(true);

    const { models } = await resolver.listModels();
    const opus = models.find((m) => m.provider === 'claude' && m.id === 'claude-opus-4-x');
    expect(opus).toBeDefined();
    expect(resolver.normalizeSpecSync('claude/claude-opus-4-x')).toBe('claude/claude-opus-4-x');
  });

  const loggedOut = [
    { name: 'stays visible but unavailable with the install hint when the binary is absent', binary: false, hint: /Install Claude Code/i },
    { name: 'unavailable with a sign-in hint when the binary is present but logged out', binary: true, hint: /sign in to your Claude subscription/i },
  ];

  for (const c of loggedOut) {
    test(c.name, async () => {
      const resolver = createLocalModelResolver({
        llm: openaiLlm,
        credentials: {},
        fetch: asFetchFunction(async () => new Response('{}')),
        claudeCli: { probe: async () => ({ binary: c.binary, loggedIn: false }) },
      });

      const providers = await resolver.listProviders();
      const claude = providers.find((p) => p.id === 'claude');
      expect(claude?.available).toBe(false);
      expect(claude?.unavailableReason).toMatch(c.hint);
    });
  }
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
      fetch: asFetchFunction(async () => new Response('{}')),
    });

    const providers = await resolver.listProviders();

    for (const id of ['workers-ai', 'my-gateway']) {
      const provider = providers.find((p) => p.id === id);
      expect(provider?.available).toBe(false);
      expect(provider?.unavailableReason).toContain('kinu auth');
    }

    expect(() => resolver.resolveModel('my-gateway/openai/gpt-4.1')).toThrow(/kinu auth/);
  });
});
