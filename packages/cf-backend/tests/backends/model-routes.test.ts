/** A model reached through a gateway speaks its own provider's API on both backends: the CLI through the worker's proxy. */
import { describe, expect, test } from 'bun:test';
import { generateText, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import * as v from 'valibot';
import { asFetchFunction, requestUrl, type AuthResolution } from '@kinu.run/core';
import { createAgentProviderRegistry } from '../../src/providers/agent-registry';
import { aiProxyRoutes } from '../../src/user/ai-proxy';
import type { CliRoutesEnv } from '../../src/cli/routes';
import { createLocalModelResolver } from '../../../cli-backend/src/model-resolver';
import { NO_RELAY_MACHINE } from '../helpers/user-credentials';
import { testOwner, TEST_CREDENTIAL_ENCRYPTION_KEY } from '../helpers/user-do';
import { serveFamily } from '../helpers/api';
import { cliAccount, unreachableAssets, unreachableKv, unreachableNamespace } from '../helpers/bindings';

describe('a gateway model on both backends', () => {
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

      const body = v.parse(v.object({ model: v.string(), tools: v.optional(v.array(v.unknown())), system: v.optional(v.unknown()) }), JSON.parse(await new Request(input, init).text()));
      const endpoint = url.slice(`${ACCOUNT_AI}/`.length);
      wire.push(`${endpoint} ${body.model}`);

      // The gateway's `/messages` refuses Anthropic's system blocks: it takes one string (measured 2026-10-06).
      if (endpoint === 'messages') {
        if (body.system !== undefined && !v.is(v.string(), body.system)) return Response.json({ error: { type: 'invalid_request_error', message: 'Invalid value at system' } }, { status: 400 });

        return Response.json({
          id: 'msg_1', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', stop_sequence: null,
          content: [{ type: 'text', text: 'served' }], usage: { input_tokens: 1, output_tokens: 1 },
        });
      }

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

    const menu = ['my-gateway/openai/gpt-6.1-sol', 'my-gateway/google/gemini-2.5-flash', 'my-gateway/anthropic/claude-sonnet-4.5'];

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
        answered: ['served', 'served', 'served', 'served', 'served', 'served'],
        wire: [
          'responses openai/gpt-6.1-sol', 'responses openai/gpt-6.1-sol', 'chat/completions google/gemini-2.5-flash',
          'chat/completions google/gemini-2.5-flash', 'messages anthropic/claude-sonnet-4.5', 'messages anthropic/claude-sonnet-4.5',
        ],
      });
    } finally {
      globalThis.fetch = workerFetch;
    }
  });
});
