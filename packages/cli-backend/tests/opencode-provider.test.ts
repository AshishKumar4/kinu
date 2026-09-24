import { describe, test, expect, mock } from 'bun:test';
import { generateText } from 'ai';
import { writeFileSync } from 'node:fs';
import { scratchPath } from '@kinu.run/test-utils';
import { asFetchFunction, JsonObjectSchema } from '@kinu.run/core';
import * as v from 'valibot';
import { createOpenCodeProvider, OPENCODE_PROVIDER_ID } from '../src/opencode-provider';
import type { OpenCodeSpawn, SpawnedOpenCode, OpenCodeProviderOptions } from '../src/opencode-provider';

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
  const path = scratchPath('opencode-provider-auth', 'auth.json');
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
  return asFetchFunction(mock(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new Request(input).url;

    if (url.endsWith('/.well-known/opencode')) {
      return new Response(wellKnown, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (url.includes('/config/opencode.json')) {
      return new Response(configJson, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('Not Found', { status: 404 });
  }));
}

/** A minimal valid reply per route, so a provider that reached the right URL but produced garbage still fails. */
const FAKE_RESPONSES_REPLY = {
  id: 'resp_1',
  created_at: 1_700_000_000,
  model: 'gpt-test',
  status: 'completed',
  output: [{
    type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'ok', annotations: [] }],
  }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};

const FAKE_CHAT_REPLY = {
  id: 'chatcmpl_1',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'gpt-test',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

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

  const fetchImpl = asFetchFunction(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input).url;

    if (url.endsWith('/.well-known/opencode')) {
      return new Response(FAKE_WELLKNOWN, { status: 200 });
    }

    if (url.includes('/config/opencode.json')) {
      return new Response(FAKE_CONFIG, { status: 200 });
    }

    requests.push(url);
    const body = v.safeParse(v.string(), init?.body);

    if (body.success) requestBodies.push(body.output);

    return Response.json(url.endsWith('/responses') ? FAKE_RESPONSES_REPLY : FAKE_CHAT_REPLY);
  }));

  return { fetchImpl, requests, requestBodies };
}

async function tryCall(
  model: Parameters<typeof generateText>[0]['model'],
  providerOptions?: Parameters<typeof generateText>[0]['providerOptions'],
): Promise<void> {
  await generateText({ model, prompt: 'hello', maxOutputTokens: 16, providerOptions });
}

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
    const resolved = v.parse(v.object({ modelId: v.string() }), model);
    expect(resolved.modelId).toBe('openai/gpt-5.6-sol');
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

    const fetchImpl = asFetchFunction(mock(async (input: RequestInfo | URL) => {
      const url = new Request(input).url;

      if (url.endsWith('/.well-known/opencode')) return new Response(FAKE_WELLKNOWN);

      if (url.includes('/config/opencode.json')) return new Response(FAKE_CONFIG);
      modelCalls++;

      return modelCalls === 1
        ? new Response('limited', { status: 429, headers: { 'Retry-After': '0' } })
        : Response.json(FAKE_RESPONSES_REPLY);
    }));

    const provider = createOpenCodeProvider(makeProviderOpts({ fetch: fetchImpl }));
    await provider.listModels({ env: {}, getAuth: async () => null, hasCredential: async () => false });

    const model = provider.createModel('openai/gpt-5.6-sol', {
      env: {}, getAuth: async () => null, hasCredential: async () => false,
    });

    await generateText({ model, prompt: 'hello', maxOutputTokens: 16, maxRetries: 0 });

    expect(modelCalls).toBe(2);
  });

  test('a Responses model sends an earlier step whole, with storage off', async () => {
    const { fetchImpl, requestBodies } = makeRoutingFetch();
    const provider = createOpenCodeProvider(makeProviderOpts({ fetch: fetchImpl }));

    await provider.listModels({ env: {}, getAuth: async () => null, hasCredential: async () => false });

    const model = provider.createModel('openai/gpt-5.6-sol', {
      env: {}, getAuth: async () => null, hasCredential: async () => false,
    });

    // An endpoint with storage off resolves no item id, so a step sent by reference reaches the model as nothing.
    await generateText({
      model, maxOutputTokens: 16,
      messages: [
        { role: 'user', content: 'What is in notes.md?' },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '', providerOptions: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'ENCRYPTED-1' } } },
            { type: 'text', text: 'Reading notes.md now.', providerOptions: { openai: { itemId: 'msg_1' } } },
            { type: 'tool-call', toolCallId: 'call_1', toolName: 'file', input: { path: 'notes.md' }, providerOptions: { openai: { itemId: 'fc_1' } } },
          ],
        },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'file', output: { type: 'text', value: 'hello' } }] },
      ],
    });

    const body = v.parse(JsonObjectSchema, JSON.parse(requestBodies[0]));
    expect(body).toMatchObject({ store: false, include: ['reasoning.encrypted_content'] });
    expect(JSON.stringify(body.input)).not.toContain('item_reference');
    expect(body.input).toEqual(expect.arrayContaining([
      { type: 'reasoning', encrypted_content: 'ENCRYPTED-1', summary: [] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Reading notes.md now.' }] },
      { type: 'function_call', call_id: 'call_1', name: 'file', arguments: '{"path":"notes.md"}' },
    ]));
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
    const body = v.parse(JsonObjectSchema, JSON.parse(requestBodies[0]));
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

  // A resumed session resolves its model before listModels, so the metadata map is cold: the gpt-5.x family
  // fallback must pick Responses without dragging non-reasoning families along.
  const cold = [
    {
      name: 'cold metadata routes OpenAI reasoning families to Responses (resumed sessions)',
      id: 'openai/gpt-5.6-sol', endpoint: 'https://opencode.example.com/openai/v1/responses',
    },
    {
      name: 'cold metadata keeps non-reasoning families on Chat Completions',
      id: 'openai/gpt-4.1-mini', endpoint: 'https://opencode.example.com/openai/v1/chat/completions',
    },
  ];

  for (const c of cold) {
    test(c.name, async () => {
      const { fetchImpl, requests } = makeRoutingFetch();
      const provider = createOpenCodeProvider(makeProviderOpts({ fetch: fetchImpl }));

      const model = provider.createModel(c.id, {
        env: {}, getAuth: async () => null, hasCredential: async () => false,
      });

      await tryCall(model);

      expect(requests).toEqual([c.endpoint]);
    });
  }

  test('createModel throws on invalid model id (no slash)', () => {
    const provider = createOpenCodeProvider(makeProviderOpts());
    expect(() => provider.createModel('invalid-no-slash', {
      env: {},
      getAuth: async () => null,
      hasCredential: async () => false,
    })).toThrow('Invalid opencode model id: invalid-no-slash');
  });

  test('config is cached and not re-fetched within TTL', async () => {
    let fetchCount = 0;

    const countingFetch = asFetchFunction(mock(async (input: RequestInfo | URL, _init?: RequestInit) => {
      fetchCount++;
      const url = new Request(input).url;

      if (url.endsWith('/.well-known/opencode')) {
        return new Response(FAKE_WELLKNOWN, { status: 200 });
      }

      return new Response(FAKE_CONFIG, { status: 200 });
    }));

    const provider = createOpenCodeProvider(makeProviderOpts({
      fetch: countingFetch,
    }));

    await provider.listModels({ env: {}, getAuth: async () => null, hasCredential: async () => false });
    const countAfterFirst = fetchCount;

    await provider.listModels({ env: {}, getAuth: async () => null, hasCredential: async () => false });

    expect(fetchCount).toBe(countAfterFirst);
  });
});
