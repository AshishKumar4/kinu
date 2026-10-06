/** One spelling, one route: a model spec normalises and lists alike on the cf registry and the CLI resolver. */
import { describe, expect, test } from 'bun:test';
import { generateText, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import * as v from 'valibot';
import { DEFAULT_WORKERS_AI_MODEL_ID, asFetchFunction, requestUrl, specModelInfo, type AuthResolution, type OpenAICompatCredential } from '@kinu.run/core';
import { createAgentProviderRegistry } from '../../src/providers/agent-registry';
import { aiProxyRoutes } from '../../src/user/ai-proxy';
import type { CliRoutesEnv } from '../../src/cli/routes';
import { createLocalModelResolver } from '../../../cli-backend/src/model-resolver';
import { NO_RELAY_MACHINE, userCredentialSource } from '../helpers/user-credentials';
import { createTestUserDO, testOwner, TEST_CREDENTIAL_ENCRYPTION_KEY } from '../helpers/user-do';
import { serveFamily } from '../helpers/api';
import { cliAccount, unreachableAssets, unreachableKv, unreachableNamespace } from '../helpers/bindings';

const cf = createAgentProviderRegistry({
  env: {},
  userDO: userCredentialSource({
    getAuthHeaders: async () => null, listCredentials: async () => [], getCredentialBaseURL: async () => null,
  }),
});

/** A shell command a message would send the reader to run. */
const COMMAND = /\b(?:kinu|opencode|wrangler) (?:auth|setup|provider|login|create)\b/;

/** A machine whose default is Workers AI behind its own gateway endpoint. */
const cli = createLocalModelResolver({
  llm: { name: 'workers-ai', baseURL: 'http://127.0.0.1:9/v1', headers: { Authorization: 'Bearer t' }, model: DEFAULT_WORKERS_AI_MODEL_ID },
  credentials: {},
});

describe('a model spec on both backends', () => {
  test('normalises to the same route', () => {
    for (const named of ['@cf/meta/llama-4-scout', 'minimax/m3', 'openai/gpt-5', 'claude/claude-opus-4-7']) {
      expect({ named, spec: cli.normalizeSpecSync(named) }).toEqual({ named, spec: cf.normalizeSpecSync(named) });
    }
  });

  test('refuses a head no provider claims instead of reading it as a model id', () => {
    expect(() => cf.normalizeSpecSync('Qwen/Qwen3-8B')).toThrow('Unknown provider in model spec "Qwen/Qwen3-8B"');
    expect(() => cli.normalizeSpecSync('Qwen/Qwen3-8B')).toThrow('Unknown provider in model spec "Qwen/Qwen3-8B"');
  });

  test('lists the providers both register in one order, the preference judge selection reads', async () => {
    const cfOrder = (await cf.registry.listProviders(cf.deps)).map((provider) => provider.id);
    const cliOrder = (await cli.listProviders()).map((provider) => provider.id);

    expect(cliOrder.filter((id) => cfOrder.includes(id))).toEqual(cfOrder.filter((id) => cliOrder.includes(id)));
  });

  // The owner's word on a custom endpoint's window counts as its catalog row: the same credential, the same window.
  test('a custom endpoint\'s declared window is the window of every model it lists', async () => {
    const credential: OpenAICompatCredential = { kind: 'openai-compat', baseURL: 'https://llm.example.test/v1', apiKey: 'k', contextWindow: 180_000 };

    const fetch = asFetchFunction(async (input) => (new Request(input).url.endsWith('/models')
      ? Response.json({ data: [{ id: 'qwen-3' }] })
      : new Response('', { status: 404 })));

    const harness = createTestUserDO();
    await harness.userDO.setCredential(await testOwner(), 'openai-compat.default', credential);

    const hosted = createAgentProviderRegistry({ env: {}, fetch, userDO: { caller: testOwner, stub: {
      ...NO_RELAY_MACHINE,
      getAuth: (caller, key, opts) => harness.userDO.getAuth(caller, key, opts),
      listCredentials: (caller) => harness.userDO.listCredentials(caller),
    } } });

    const local = createLocalModelResolver({ llm: null, credentials: { openaiCompat: { default: credential } }, fetch });
    const spec = 'openai-compat/qwen-3';

    try {
      expect([(await specModelInfo(hosted.registry, hosted.deps, spec))?.contextWindow, (await local.modelInfo(spec))?.contextWindow])
        .toEqual([180_000, 180_000]);
    } finally {
      harness.close();
    }
  });

  // A named endpoint the web form saves (`openai-compat.<name>`) is served alike: listed, resolved and answered.
  test('a named custom endpoint lists and answers on both backends', async () => {
    const credential: OpenAICompatCredential = { kind: 'openai-compat', baseURL: 'https://llm.example.test/v1', apiKey: 'k' };

    const fetch = asFetchFunction(async (input) => (new Request(input).url.endsWith('/models')
      ? Response.json({ data: [{ id: 'qwen-3' }] })
      : Response.json({ id: 'c', object: 'chat.completion', created: 1, model: 'qwen-3',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'served' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })));

    const harness = createTestUserDO();
    await harness.userDO.setCredential(await testOwner(), 'openai-compat.house', credential);

    const hosted = createAgentProviderRegistry({ env: {}, fetch, userDO: { caller: testOwner, stub: {
      ...NO_RELAY_MACHINE,
      getAuth: (caller, key, opts) => harness.userDO.getAuth(caller, key, opts),
      listCredentials: (caller) => harness.userDO.listCredentials(caller),
    } } });

    const local = createLocalModelResolver({ llm: null, credentials: { openaiCompat: { house: credential } }, fetch });
    const spec = 'openai-compat:house/qwen-3';
    const answer = async (model: LanguageModel) => (await generateText({ model, prompt: 'hi' })).text;

    try {
      expect({
        listed: [(await specModelInfo(hosted.registry, hosted.deps, spec))?.id, (await local.modelInfo(spec))?.id],
        answered: [await answer(hosted.resolveModel(spec, 'kinu-test')), await answer(local.resolveModel(spec, 'kinu-test'))],
      }).toEqual({ listed: ['qwen-3', 'qwen-3'], answered: ['served', 'served'] });
    } finally {
      harness.close();
    }
  });

  // The owner's default, GPT 6.1 Sol through their own gateway, was sent on Chat Completions with the turn's tools and
  // refused in these words (measured 2026-10-06); OpenAI's own provider speaks Responses, and so must every route to it.
  test('a gateway model speaks its author\'s own API on both backends, the CLI through the signed-in proxy', async () => {
    const ACCOUNT_AI = 'https://api.cloudflare.com/client/v4/accounts/abc123abc123abc1/ai/v1';
    const ORIGIN = 'https://kinu.example.test';
    const CLI_TOKEN = `ptc_${'0'.repeat(32)}_abcdefghijklmnopqrstuvwxyz`;
    const wire: string[] = [];

    const upstream = asFetchFunction(async (input, init) => {
      const url = requestUrl(input);

      if (url === 'https://models.dev/api.json') {
        return Response.json({
          openai: { id: 'openai', npm: '@ai-sdk/openai', models: { 'gpt-6.1-sol': { id: 'gpt-6.1-sol', reasoning: true, tool_call: true } } },
          google: { id: 'google', npm: '@ai-sdk/google', models: { 'gemini-2.5-flash': { id: 'gemini-2.5-flash', tool_call: true } } },
        });
      }

      const body = v.parse(v.object({ model: v.string(), tools: v.optional(v.array(v.unknown())) }), JSON.parse(await new Request(input, init).text()));
      const endpoint = url.slice(`${ACCOUNT_AI}/`.length);
      wire.push(`${endpoint} ${body.model}`);

      if (endpoint === 'responses') {
        return Response.json({
          id: 'resp_1', object: 'response', created_at: 1, model: body.model, status: 'completed', error: null, incomplete_details: null,
          output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'served', annotations: [] }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        });
      }

      if (body.model.startsWith('openai/') && body.tools !== undefined) {
        return Response.json({ errors: [{ message: 'Model execution failed (User Input Error): Function tools with reasoning_effort are not supported for gpt-6.1-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to \'none\'.', code: 7003 }], success: false, result: {}, messages: [] }, { status: 400 });
      }

      return Response.json({ id: 'c', object: 'chat.completion', created: 1, model: body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'served' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });

    const gatewayAuth = async (key: string): Promise<AuthResolution | null> => (key === 'cloudflare.ai-gateway'
      ? { baseURL: ACCOUNT_AI, headers: { authorization: 'Bearer cf-user', 'cf-aig-gateway-id': 'default' } }
      : null);

    const hosted = createAgentProviderRegistry({ env: {}, fetch: upstream, userDO: { caller: testOwner, stub: {
      ...NO_RELAY_MACHINE, getAuth: async (_caller, key) => await gatewayAuth(key), listCredentials: async () => [],
    } } });

    // The worker's own signed-in proxy route answers the CLI, as it does in production.
    const proxy = serveFamily(aiProxyRoutes);

    const proxyEnv: CliRoutesEnv<string> = {
      UserDO: { idFromName: (name) => name, get: () => cliAccount({
        verifyCliToken: async (_caller, bearer: string) => ({ ok: bearer === CLI_TOKEN, tokenHash: 'h', user: { id: '0'.repeat(32), email: 'owner@example.test', displayName: 'Owner' } }),
        getAuth: async (_caller, key: string) => await gatewayAuth(key),
      }) },
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
      OrchestratorAgent: unreachableNamespace('OrchestratorAgent'),
      AUTH_KV: unreachableKv('AUTH_KV'),
      ASSETS: unreachableAssets(),
    };

    const menu = ['my-gateway/openai/gpt-6.1-sol', 'my-gateway/google/gemini-2.5-flash'];

    const local = createLocalModelResolver({ llm: null, credentials: {}, cloud: { origin: ORIGIN, token: CLI_TOKEN }, fetch: asFetchFunction(async (input, init) => {
      const url = requestUrl(input);

      if (url === `${ORIGIN}/api/cli/models`) return Response.json({ models: menu.map((spec) => ({ spec, label: spec, provider: 'my-gateway' })), failures: [] });

      if (!url.startsWith(ORIGIN)) return await upstream(input, init);
      const answered = await proxy(new Request(input, init), proxyEnv);

      if (answered === null) throw new Error(`no proxy route for ${url}`);

      return answered;
    }) });

    const answer = async (model: LanguageModel) => (await generateText({
      model, prompt: 'Look at a.txt.', tools: { look: tool({ description: 'Read a file.', inputSchema: z.object({ path: z.string() }) }) },
    })).text;

    // The proxy forwards with the worker's own fetch, as the account endpoint is reached in production.
    const workerFetch = globalThis.fetch;
    globalThis.fetch = upstream;

    try {
      const answered: string[] = [];

      for (const spec of menu) answered.push(await answer(hosted.resolveModel(spec, 'kinu-test')), await answer(local.resolveModel(spec, 'kinu-test')));

      expect({ answered, wire }).toEqual({
        answered: ['served', 'served', 'served', 'served'],
        wire: ['responses openai/gpt-6.1-sol', 'responses openai/gpt-6.1-sol', 'chat/completions google/gemini-2.5-flash', 'chat/completions google/gemini-2.5-flash'],
      });
    } finally {
      globalThis.fetch = workerFetch;
    }
  });

  test('says what is missing when a provider is unavailable, never a command to run', async () => {
    // A cf workspace with no relayed machine, and a machine signed out of Kinu with nothing connected.
    const signedOut = createLocalModelResolver({ llm: null, credentials: {} });

    const reasons = [...await cf.registry.listProviders(cf.deps), ...await signedOut.listProviders()]
      .flatMap((provider) => (provider.unavailableReason === undefined ? [] : [`${provider.id}: ${provider.unavailableReason}`]));

    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.filter((reason) => COMMAND.test(reason))).toEqual([]);
    expect(() => signedOut.normalizeSpecSync(null)).toThrow(expect.objectContaining({ message: expect.not.stringMatching(COMMAND) }));
  });
});
