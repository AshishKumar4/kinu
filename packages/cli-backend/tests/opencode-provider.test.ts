import { describe, test, expect, mock } from 'bun:test';
import { generateText } from 'ai';
import { writeFileSync } from 'node:fs';
import { scratchPath } from '@kinu.run/test-utils';
import { asFetchFunction, createProviderRegistry, JsonObjectSchema, type ModelCallDeps } from '@kinu.run/core';
import * as v from 'valibot';
import { createOpenCodeProvider, OPENCODE_PROVIDER_ID } from '../src/opencode-provider';
import type { OpenCodeSpawn, SpawnedOpenCode, OpenCodeProviderOptions } from '../src/opencode-provider';

/** A model as the registry resolves it: the provider's, inside the one stack, on the provider's own lane. */
function throughStack(provider: ReturnType<typeof createOpenCodeProvider>, modelId: string, deps: ModelCallDeps) {
  const registry = createProviderRegistry();

  registry.register(provider);

  return registry.resolve(`${OPENCODE_PROVIDER_ID}/${modelId}`, deps);
}

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

// OpenCode names every model's SDK (`api.npm`, its provider's when the model names none: opencode provider.ts).
const FAKE_MODELS_OUTPUT = [
  'openai/gpt-5.6-sol',
  JSON.stringify({
    name: 'GPT 5.6 Sol',
    limit: { context: 1050000 },
    capabilities: { output: { text: true }, toolcall: true, reasoning: true },
    api: { id: 'gpt-5.6-sol', npm: '@ai-sdk/openai' },
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

const FAKE_MESSAGES_REPLY = {
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', stop_reason: 'end_turn', stop_sequence: null,
  content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 },
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

    if (url.endsWith('/messages')) return Response.json(FAKE_MESSAGES_REPLY);

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

  test('reasoning models use the Responses API route', async () => {
    const { fetchImpl, requests } = makeRoutingFetch();
    const provider = createOpenCodeProvider(makeProviderOpts({ fetch: fetchImpl }));

    await provider.listModels({ env: {}, getAuth: async () => null, hasCredential: async () => false });

    const model = provider.createModel('openai/gpt-5.6-sol', {
      env: {},
      sessionAffinity: 'kinu-test', getAuth: async () => null, hasCredential: async () => false,
      workspaceAffinity: 'kinu-test',
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

    const model = throughStack(provider, 'openai/gpt-5.6-sol', {
      env: {},
      sessionAffinity: 'kinu-test', getAuth: async () => null, hasCredential: async () => false,
      workspaceAffinity: 'kinu-test',
    });

    await generateText({ model, prompt: 'hello', maxOutputTokens: 16, maxRetries: 0 });

    expect(modelCalls).toBe(2);
  });

  test('a spent OpenCode Go window leaves Zen on the same host serving', async () => {
    const zenConfig = JSON.stringify({
      provider: {
        'opencode-go': { options: { baseURL: 'https://opencode.example.com/zen/go/v1', headers: { Authorization: 'Bearer {env:TOKEN}' } } },
        opencode: { options: { baseURL: 'https://opencode.example.com/zen/v1', headers: { Authorization: 'Bearer {env:TOKEN}' } } },
      },
    });

    const served: string[] = [];

    const fetchImpl = asFetchFunction(mock(async (input: RequestInfo | URL) => {
      const url = new Request(input).url;

      if (url.endsWith('/.well-known/opencode')) return new Response(FAKE_WELLKNOWN);

      if (url.includes('/config/opencode.json')) return new Response(zenConfig);
      served.push(url);

      return url.includes('/zen/go/')
        ? new Response(JSON.stringify({ error: { message: 'Monthly usage limit reached.' } }), { status: 429, headers: { 'Retry-After': '729883' } })
        : Response.json(FAKE_CHAT_REPLY);
    }));

    const listed = ['opencode-go/glm-5', 'opencode/glm-5'].flatMap((id) => [id, JSON.stringify({
      name: id, capabilities: { output: { text: true }, toolcall: true, reasoning: false }, api: { id: 'glm-5', npm: '@ai-sdk/openai-compatible' },
    }), '']).join('\n');

    const provider = createOpenCodeProvider(makeProviderOpts({ fetch: fetchImpl, spawn: makeSpawn(listed) }));
    const deps = { env: {}, sessionAffinity: 'kinu-test', workspaceAffinity: 'kinu-test', getAuth: async () => null, hasCredential: async () => false };

    await expect(generateText({ model: throughStack(provider, 'opencode-go/glm-5', deps), prompt: 'hi', maxRetries: 0 })).rejects.toThrow();
    const zen = await generateText({ model: throughStack(provider, 'opencode/glm-5', deps), prompt: 'hi', maxRetries: 0 });

    expect({ text: zen.text, served }).toEqual({
      text: 'ok',
      served: ['https://opencode.example.com/zen/go/v1/chat/completions', 'https://opencode.example.com/zen/v1/chat/completions'],
    });
  });

  test('a Responses model sends an earlier step whole, with storage off', async () => {
    const { fetchImpl, requestBodies } = makeRoutingFetch();
    const provider = createOpenCodeProvider(makeProviderOpts({ fetch: fetchImpl }));

    await provider.listModels({ env: {}, getAuth: async () => null, hasCredential: async () => false });

    const model = provider.createModel('openai/gpt-5.6-sol', {
      env: {},
      sessionAffinity: 'kinu-test', getAuth: async () => null, hasCredential: async () => false,
      workspaceAffinity: 'kinu-test',
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
      { role: 'assistant', content: 'Reading notes.md now.' },
      { type: 'function_call', call_id: 'call_1', name: 'file', arguments: '{"path":"notes.md"}' },
    ]));
  });

  test('non-reasoning models use the Chat Completions API route', async () => {
    const { fetchImpl, requests, requestBodies } = makeRoutingFetch();
    const provider = createOpenCodeProvider(makeProviderOpts({ fetch: fetchImpl }));

    await provider.listModels({ env: {}, getAuth: async () => null, hasCredential: async () => false });

    const model = provider.createModel('openai/gpt-5.4-nano', {
      env: {},
      sessionAffinity: 'kinu-test', getAuth: async () => null, hasCredential: async () => false,
      workspaceAffinity: 'kinu-test',
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
      env: {},
      sessionAffinity: 'kinu-test', getAuth: async () => null, hasCredential: async () => false,
      workspaceAffinity: 'kinu-test',
    });

    await tryCall(model);

    expect(requests).toEqual(['https://opencode.example.com/openai/v1/responses']);
  });

  // A resumed session resolves its model before any listing; each model's API is its SDK's, read from OpenCode's
  // metadata before the first request, and a reasoning model on a Chat Completions SDK stays there.
  test('a resumed session reads each model\'s SDK before its first request: Responses, Messages or Chat Completions', async () => {
    const output = [
      FAKE_MODELS_OUTPUT,
      'openai/claude-routed',
      JSON.stringify({ name: 'Claude', capabilities: { output: { text: true }, toolcall: true, reasoning: true }, api: { id: 'claude-routed', npm: '@ai-sdk/anthropic' } }),
      '',
      'openai/reasoner',
      JSON.stringify({ name: 'Reasoner', capabilities: { output: { text: true }, toolcall: true, reasoning: true }, api: { id: 'reasoner', npm: '@ai-sdk/openai-compatible' } }),
      '',
    ].join('\n');

    const { fetchImpl, requests } = makeRoutingFetch();
    const provider = createOpenCodeProvider(makeProviderOpts({ fetch: fetchImpl, spawn: makeSpawn(output) }));

    for (const id of ['openai/gpt-5.6-sol', 'openai/claude-routed', 'openai/reasoner']) {
      await tryCall(provider.createModel(id, { env: {}, sessionAffinity: 'kinu-test', workspaceAffinity: 'kinu-test', getAuth: async () => null, hasCredential: async () => false }));
    }

    expect(requests).toEqual([
      'https://opencode.example.com/openai/v1/responses', 'https://opencode.example.com/openai/v1/messages',
      'https://opencode.example.com/openai/v1/chat/completions',
    ]);
  });

  test('an invalid model id refuses before discovery or any model request', async () => {
    let discoveries = 0;
    let requests = 0;
    const spawn = makeSpawn(FAKE_MODELS_OUTPUT);

    const provider = createOpenCodeProvider(makeProviderOpts({
      spawn: (args, options) => {
        discoveries++;

        return spawn(args, options);
      },
      fetch: asFetchFunction(async () => {
        requests++;

        return Response.json({});
      }),
    }));

    const deps = {
      env: {},
      sessionAffinity: 'kinu-test',
      workspaceAffinity: 'kinu-test',
      getAuth: async () => null,
      hasCredential: async () => false,
    };

    await expect((async () => await generateText({
      model: throughStack(provider, 'invalid-no-slash', deps), prompt: 'hello', maxRetries: 0,
    }))()).rejects.toThrow(Error);
    expect({ discoveries, requests }).toEqual({ discoveries: 0, requests: 0 });
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
