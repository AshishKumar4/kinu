import { describe, test, expect, mock } from 'bun:test';
import { generateText } from 'ai';
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  createOpenCodeProvider,
  OPENCODE_PROVIDER_ID,
  rewriteOpenCodeResponsesBody,
} from '../src/opencode-provider';
import type { OpenCodeSpawn, SpawnedOpenCode, OpenCodeProviderOptions } from '../src/opencode-provider';

// ─── Helpers: fake spawn + fake fetch ────────────────────────────────────────

function makeSpawn(output: string, exitCode = 0): OpenCodeSpawn {
  return (_args: string[], _opts: { signal?: AbortSignal }) => {
    const encoder = new TextEncoder();
    const chunks = output.match(/[\s\S]{1,1024}/g) ?? [output];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const errStream = new ReadableStream<Uint8Array>({
      start(controller) { controller.close(); },
    });
    const spawned: SpawnedOpenCode = {
      stdout: stream,
      stderr: errStream,
      stdin: { end() {} },
      kill() {},
      exit: Promise.resolve(exitCode),
    };
    return spawned;
  };
}

function makeAuthFile(origin: string, token: string): string {
  const dir = `/tmp/proteus-test-${Date.now()}`;
  const path = `${dir}/auth.json`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ [origin]: { type: 'wellknown', key: 'TOKEN', token } }));
  return path;
}

const FAKE_WELLKNOWN = JSON.stringify({
  remote_config: {
    url: 'https://opencode.example.com/config/opencode.json',
    headers: { 'cf-access-token': '{env:TOKEN}' },
  },
});

const FAKE_CONFIG = JSON.stringify({
  model: 'openai/gpt-5.6-sol',
  provider: {
    openai: {
      options: {
        baseURL: 'https://opencode.example.com/openai/v1',
        headers: { 'Authorization': 'Bearer {env:TOKEN}' },
      },
    },
  },
});

const FAKE_MODELS_OUTPUT = [
  'openai/gpt-5.6-sol',
  JSON.stringify({
    name: 'GPT 5.6 Sol',
    limit: { context: 1050000 },
    capabilities: { output: { text: true }, toolcall: true, reasoning: true },
    api: { id: 'gpt-5.6-sol' },
  }),
  '',
  'openai/gpt-5.4-nano',
  JSON.stringify({
    name: 'GPT 5.4 Nano',
    limit: { context: 200000 },
    capabilities: { output: { text: true }, toolcall: true, reasoning: false },
    api: { id: 'gpt-5.4-nano', npm: '@ai-sdk/openai-compatible' },
  }),
  '',
].join('\n');

function makeFakeFetch(configJson = FAKE_CONFIG, wellKnown = FAKE_WELLKNOWN): typeof fetch {
  return mock(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith('/.well-known/opencode')) {
      return new Response(wellKnown, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/config/opencode.json')) {
      return new Response(configJson, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('Not Found', { status: 404 });
  }) as unknown as typeof fetch;
}

function makeProviderOpts(overrides: Partial<OpenCodeProviderOptions> = {}): OpenCodeProviderOptions {
  const authPath = makeAuthFile('https://opencode.example.com', 'test-token-123');
  return {
    authPath,
    fetch: makeFakeFetch(),
    spawn: makeSpawn(FAKE_MODELS_OUTPUT),
    probe: undefined, // use real probe
    ...overrides,
  };
}

function makeRoutingFetch() {
  const requests: string[] = [];
  const requestBodies: string[] = [];
  const fetchImpl = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith('/.well-known/opencode')) {
      return new Response(FAKE_WELLKNOWN, { status: 200 });
    }
    if (url.includes('/config/opencode.json')) {
      return new Response(FAKE_CONFIG, { status: 200 });
    }
    requests.push(url);
    if (typeof init?.body === 'string') requestBodies.push(init.body);
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests, requestBodies };
}

async function tryCall(
  model: Parameters<typeof generateText>[0]['model'],
  providerOptions?: Parameters<typeof generateText>[0]['providerOptions'],
): Promise<void> {
  try {
    await generateText({ model, prompt: 'hello', maxOutputTokens: 16, providerOptions });
  } catch { /* minimal mock bodies may not parse — endpoint routing is the assertion */ }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('OpenCode provider', () => {
  test('provider id and label', () => {
    const provider = createOpenCodeProvider(makeProviderOpts());
    expect(provider.id).toBe(OPENCODE_PROVIDER_ID);
    expect(provider.label).toBe('OpenCode (shared auth)');
  });

  test('isAvailable returns true when binary + auth present', async () => {
    const provider = createOpenCodeProvider(makeProviderOpts({
      spawn: makeSpawn('opencode 1.17.13\n'),
    }));
    expect(await provider.isAvailable({
      env: {},
      getAuth: async () => null,
      hasCredential: async () => false,
    })).toBe(true);
  });

  test('isAvailable returns false when opencode binary missing', async () => {
    const provider = createOpenCodeProvider(makeProviderOpts({
      spawn: makeSpawn('', 1), // exit code 1 = not found
    }));
    expect(await provider.isAvailable({
      env: {},
      getAuth: async () => null,
      hasCredential: async () => false,
    })).toBe(false);
  });

  test('isAvailable returns false when auth.json missing', async () => {
    const provider = createOpenCodeProvider({
      authPath: '/nonexistent/path/auth.json',
      fetch: makeFakeFetch(),
      spawn: makeSpawn('opencode 1.17.13\n'),
    });
    expect(await provider.isAvailable({
      env: {},
      getAuth: async () => null,
      hasCredential: async () => false,
    })).toBe(false);
  });

  test('listModels discovers models from opencode models --verbose', async () => {
    const provider = createOpenCodeProvider(makeProviderOpts({
      spawn: makeSpawn(FAKE_MODELS_OUTPUT),
    }));
    const models = await provider.listModels({
      env: {},
      getAuth: async () => null,
      hasCredential: async () => false,
    });
    expect(models.length).toBe(2);
    expect(models[0].id).toBe('openai/gpt-5.6-sol');
    expect(models[0].label).toBe('GPT 5.6 Sol');
    expect(models[0].contextWindow).toBe(1050000);
    expect(models[1].id).toBe('openai/gpt-5.4-nano');
    expect(models[1].label).toBe('GPT 5.4 Nano');
  });

  test('listModels skips models without text or toolcall capability', async () => {
    const output = [
      'openai/text-only-model',
      JSON.stringify({
        name: 'Text Only',
        capabilities: { output: { text: true }, toolcall: false },
      }),
      '',
      'openai/good-model',
      JSON.stringify({
        name: 'Good Model',
        capabilities: { output: { text: true }, toolcall: true },
      }),
      '',
    ].join('\n');
    const provider = createOpenCodeProvider(makeProviderOpts({
      spawn: makeSpawn(output),
    }));
    const models = await provider.listModels({
      env: {},
      getAuth: async () => null,
      hasCredential: async () => false,
    });
    expect(models.length).toBe(1);
    expect(models[0].id).toBe('openai/good-model');
  });

  test('unavailableReason gives install hint when binary missing', async () => {
    const provider = createOpenCodeProvider(makeProviderOpts({
      spawn: makeSpawn('', 1),
    }));
    const reason = await provider.unavailableReason?.({
      env: {},
      getAuth: async () => null,
      hasCredential: async () => false,
    });
    expect(reason).toContain('Install opencode');
  });

  test('unavailableReason gives login hint when not authenticated', async () => {
    const provider = createOpenCodeProvider({
      authPath: '/nonexistent/path/auth.json',
      fetch: makeFakeFetch(),
      spawn: makeSpawn('opencode 1.17.13\n'),
    });
    const reason = await provider.unavailableReason?.({
      env: {},
      getAuth: async () => null,
      hasCredential: async () => false,
    });
    expect(reason).toContain('opencode auth login');
  });

  test('createModel returns a LanguageModel', async () => {
    const provider = createOpenCodeProvider(makeProviderOpts());
    const model = provider.createModel('openai/gpt-5.6-sol', {
      env: {},
      getAuth: async () => null,
      hasCredential: async () => false,
    });
    expect(model).toBeDefined();
    expect(model.modelId).toBe('openai/gpt-5.6-sol');
  });

  test('reasoning models use the Responses API route', async () => {
    const { fetchImpl, requests } = makeRoutingFetch();
    const provider = createOpenCodeProvider(makeProviderOpts({ fetch: fetchImpl }));

    await provider.listModels({ env: {}, getAuth: async () => null, hasCredential: async () => false });
    const model = provider.createModel('openai/gpt-5.6-sol', {
      env: {}, getAuth: async () => null, hasCredential: async () => false,
    });
    await tryCall(model);

    expect(requests).toEqual(['https://opencode.example.com/openai/v1/responses']);
  });

  test('routes model requests through the patient rate-limit fetch', async () => {
    let modelCalls = 0;
    const fetchImpl = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/.well-known/opencode')) return new Response(FAKE_WELLKNOWN);
      if (url.includes('/config/opencode.json')) return new Response(FAKE_CONFIG);
      modelCalls++;
      return modelCalls === 1
        ? new Response('limited', { status: 429, headers: { 'Retry-After': '0' } })
        : Response.json({ id: 'r', output: [] });
    }) as unknown as typeof fetch;
    const provider = createOpenCodeProvider(makeProviderOpts({ fetch: fetchImpl }));
    await provider.listModels({ env: {}, getAuth: async () => null, hasCredential: async () => false });
    const model = provider.createModel('openai/gpt-5.6-sol', {
      env: {}, getAuth: async () => null, hasCredential: async () => false,
    });

    try {
      await generateText({ model, prompt: 'hello', maxOutputTokens: 16, maxRetries: 0 });
    } catch { /* minimal success body may not parse; the fetch route is the assertion */ }

    expect(modelCalls).toBe(2);
  });

  test('Responses requests disable storage and request encrypted reasoning', async () => {
    const { fetchImpl, requestBodies } = makeRoutingFetch();
    const provider = createOpenCodeProvider(makeProviderOpts({ fetch: fetchImpl }));

    await provider.listModels({ env: {}, getAuth: async () => null, hasCredential: async () => false });
    const model = provider.createModel('openai/gpt-5.6-sol', {
      env: {}, getAuth: async () => null, hasCredential: async () => false,
    });
    await tryCall(model, {
      openai: {
        include: [
          'file_search_call.results',
          'reasoning.encrypted_content',
          'reasoning.encrypted_content',
        ],
      },
    });

    const body = JSON.parse(requestBodies[0]) as Record<string, unknown>;
    expect(body.store).toBe(false);
    expect(body.include).toEqual([
      'file_search_call.results',
      'reasoning.encrypted_content',
    ]);
  });

  test('Responses requests remove persisted references and unsafe reasoning ids', () => {
    const reasoningWithoutEncryptedContent = {
      type: 'reasoning',
      id: 'rs_missing',
      summary: [{ type: 'summary_text', text: 'summary' }],
    };
    const reasoningWithEncryptedContent = {
      type: 'reasoning',
      id: 'rs_encrypted',
      encrypted_content: 'encrypted-payload',
      summary: [],
    };
    const nonReasoningItem = {
      type: 'message',
      id: 'msg_inline',
      role: 'assistant',
      content: [],
    };
    const nonPersistedReference = { type: 'item_reference', id: 'call_local' };

    const body: Record<string, unknown> = {
      model: 'openai/gpt-5.6-sol',
      input: [
        reasoningWithoutEncryptedContent,
        reasoningWithEncryptedContent,
        { type: 'item_reference', id: 'rs_reference' },
        { type: 'item_reference', id: 'msg_reference' },
        nonReasoningItem,
        nonPersistedReference,
      ],
    };
    rewriteOpenCodeResponsesBody(body);

    // With store:false NOTHING is persisted server-side, so every
    // server-assigned id (rs_, msg_, fc_) must be stripped and the item passed
    // by value — an id-bearing item 404s ("Items are not persisted when
    // `store` is set to false"), which is exactly the bug this regressed on.
    expect(body.input).toEqual([
      {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'summary' }],
      },
      {
        type: 'reasoning',
        encrypted_content: 'encrypted-payload',
        summary: [],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [],
      },
      nonPersistedReference,
    ]);
  });

  test('Responses requests strip tool-call server ids but keep call_id', () => {
    const body: Record<string, unknown> = {
      model: 'openai/gpt-5.6-sol',
      input: [
        { type: 'function_call', id: 'fc_server', call_id: 'call_abc', name: 'run', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_abc', output: 'ok' },
      ],
    };
    rewriteOpenCodeResponsesBody(body);

    expect(body.input).toEqual([
      { type: 'function_call', call_id: 'call_abc', name: 'run', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_abc', output: 'ok' },
    ]);
  });

  test('non-reasoning models use the Chat Completions API route', async () => {
    const { fetchImpl, requests, requestBodies } = makeRoutingFetch();
    const provider = createOpenCodeProvider(makeProviderOpts({ fetch: fetchImpl }));

    await provider.listModels({ env: {}, getAuth: async () => null, hasCredential: async () => false });
    const model = provider.createModel('openai/gpt-5.4-nano', {
      env: {}, getAuth: async () => null, hasCredential: async () => false,
    });
    await tryCall(model);

    expect(requests).toEqual(['https://opencode.example.com/openai/v1/chat/completions']);
    const body = JSON.parse(requestBodies[0]) as Record<string, unknown>;
    expect(body.model).toBe('gpt-5.4-nano');
    expect(body.max_completion_tokens).toBe(16);
    expect(Object.hasOwn(body, 'max_tokens')).toBe(false);
    expect(Object.hasOwn(body, 'store')).toBe(false);
    expect(Object.hasOwn(body, 'include')).toBe(false);
  });

  test('@ai-sdk/openai model metadata selects the Responses API route', async () => {
    const output = [
      'openai/sdk-routed-model',
      JSON.stringify({
        name: 'SDK-routed model',
        capabilities: { output: { text: true }, toolcall: true, reasoning: false },
        api: { id: 'sdk-routed-model', npm: '@ai-sdk/openai' },
      }),
      '',
    ].join('\n');
    const { fetchImpl, requests } = makeRoutingFetch();
    const provider = createOpenCodeProvider(makeProviderOpts({ fetch: fetchImpl, spawn: makeSpawn(output) }));

    await provider.listModels({ env: {}, getAuth: async () => null, hasCredential: async () => false });
    const model = provider.createModel('openai/sdk-routed-model', {
      env: {}, getAuth: async () => null, hasCredential: async () => false,
    });
    await tryCall(model);

    expect(requests).toEqual(['https://opencode.example.com/openai/v1/responses']);
  });

  test('cold metadata routes OpenAI reasoning families to Responses (resumed sessions)', async () => {
    // A resumed session resolves its stored model BEFORE any listModels call,
    // so the metadata map is cold. Defaulting gpt-5.x to Chat Completions
    // breaks it outright ("use /v1/responses") — the family fallback must win.
    const { fetchImpl, requests } = makeRoutingFetch();
    const provider = createOpenCodeProvider(makeProviderOpts({ fetch: fetchImpl }));

    const model = provider.createModel('openai/gpt-5.6-sol', {
      env: {}, getAuth: async () => null, hasCredential: async () => false,
    });
    await tryCall(model);

    expect(requests).toEqual(['https://opencode.example.com/openai/v1/responses']);
  });

  test('cold metadata keeps non-reasoning families on Chat Completions', async () => {
    const { fetchImpl, requests } = makeRoutingFetch();
    const provider = createOpenCodeProvider(makeProviderOpts({ fetch: fetchImpl }));

    const model = provider.createModel('openai/gpt-4.1-mini', {
      env: {}, getAuth: async () => null, hasCredential: async () => false,
    });
    await tryCall(model);

    expect(requests).toEqual(['https://opencode.example.com/openai/v1/chat/completions']);
  });

  test('createModel throws on invalid model id (no slash)', () => {
    const provider = createOpenCodeProvider(makeProviderOpts());
    expect(() => provider.createModel('invalid-no-slash', {
      env: {},
      getAuth: async () => null,
      hasCredential: async () => false,
    })).toThrow();
  });

  test('config is cached and not re-fetched within TTL', async () => {
    let fetchCount = 0;
    const countingFetch = mock(async (input: RequestInfo | URL, _init?: RequestInit) => {
      fetchCount++;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/.well-known/opencode')) {
        return new Response(FAKE_WELLKNOWN, { status: 200 });
      }
      return new Response(FAKE_CONFIG, { status: 200 });
    }) as unknown as typeof fetch;

    const provider = createOpenCodeProvider(makeProviderOpts({
      fetch: countingFetch,
    }));

    // First call fetches
    await provider.listModels({ env: {}, getAuth: async () => null, hasCredential: async () => false });
    const countAfterFirst = fetchCount;

    // Second call within TTL should reuse cache
    await provider.listModels({ env: {}, getAuth: async () => null, hasCredential: async () => false });

    expect(fetchCount).toBe(countAfterFirst); // no additional fetches
  });
});
