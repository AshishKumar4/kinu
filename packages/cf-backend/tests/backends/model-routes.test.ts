/** A model reached through a gateway speaks its own provider's API on both backends: the CLI through the worker's proxy. */
import { describe, expect, test } from 'bun:test';
import { generateText, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import * as v from 'valibot';
import { asFetchFunction, requestUrl, runChat, type AuthResolution, type ChatEvent, type JsonObject } from '@kinu.run/core';
import { createAgentProviderRegistry } from '../../src/providers/agent-registry';
import { aiProxyRoutes } from '../../src/user/ai-proxy';
import type { CliRoutesEnv } from '../../src/cli/routes';
import { createLocalModelResolver } from '../../../cli-backend/src/model-resolver';
import { NO_RELAY_MACHINE } from '../helpers/user-credentials';
import { testOwner, TEST_CREDENTIAL_ENCRYPTION_KEY } from '../helpers/user-do';
import { serveFamily } from '../helpers/api';
import { cliAccount, unreachableAssets, unreachableKv, unreachableNamespace } from '../helpers/bindings';

const ACCOUNT_AI = 'https://api.cloudflare.com/client/v4/accounts/abc123abc123abc1/ai/v1';

const ORIGIN = 'https://kinu.example.test';

const CLI_TOKEN = `ptc_${'0'.repeat(32)}_abcdefghijklmnopqrstuvwxyz`;

/** The owner's gateway on the hosted registry, and on the CLI through the worker's own signed-in proxy. */
function gatewayRoutes(upstream: typeof fetch, menu: readonly string[]) {
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

  const local = createLocalModelResolver({ llm: null, credentials: {}, cloud: { origin: ORIGIN, token: CLI_TOKEN }, fetch: asFetchFunction(async (input, init) => {
    const url = requestUrl(input);

    if (url === `${ORIGIN}/api/cli/models`) return Response.json({ models: menu.map((spec) => ({ spec, label: spec, provider: 'my-gateway' })), failures: [] });

    if (!url.startsWith(ORIGIN)) return await upstream(input, init);
    const answered = await proxy(new Request(input, init), proxyEnv);

    if (answered === null) throw new Error(`no proxy route for ${url}`);

    return answered;
  }) });

  return { hosted, local };
}

type ClaudeBlock =
  | { readonly type: 'thinking'; readonly thinking: string; readonly signature: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: Record<string, string> }
  | { readonly type: 'text'; readonly text: string };

/** A Messages stream event: its type, and the rest of what the API sends with it. */
interface ClaudeEvent {
  readonly type: string;
  readonly [field: string]: JsonObject[string];
}

/** Anthropic's Messages stream of `blocks`, as the gateway relays it. */
function claudeStream(blocks: readonly ClaudeBlock[], stopReason: 'tool_use' | 'end_turn'): Response {
  const events: ClaudeEvent[] = [{ type: 'message_start', message: {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } }];

  for (const [index, block] of blocks.entries()) {
    if (block.type === 'thinking') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } },
        { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } },
        { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
    } else if (block.type === 'tool_use') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } },
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    } else {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    }

    events.push({ type: 'content_block_stop', index });
  }

  events.push({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' });

  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

const MessagesRequestSchema = v.object({
  messages: v.array(v.object({ role: v.string(), content: v.union([v.string(), v.array(v.looseObject({ type: v.string() }))]) })),
});

describe('a gateway model on both backends', () => {
  // The owner's default, GPT 6.1 Sol through their own gateway, was sent on Chat Completions with the turn's tools and
  // refused in these words (measured 2026-10-06); OpenAI's own provider speaks Responses, and so must every route to it.
  test('a gateway model speaks its author\'s own API on both backends, the CLI through the signed-in proxy', async () => {
    const wire: string[] = [];
    const menu = ['my-gateway/openai/gpt-6.1-sol', 'my-gateway/google/gemini-2.5-flash', 'my-gateway/anthropic/claude-sonnet-4.5'];

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

    const { hosted, local } = gatewayRoutes(upstream, menu);

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

  // Fable 5.1 and Opus 5.5 think by default, and Anthropic reads a tool result only after the signed thinking that
  // called it, unchanged. The gateway's `/messages` is Anthropic's own API, so the replay keeps the block whole and
  // caches as Anthropic does (both measured through Cloudflare's REST `/ai/v1/messages`, 2026-10-06).
  test('a gateway Claude turn that thinks, calls a tool and reads its result sends its signed thinking back whole', async () => {
    const spec = 'my-gateway/anthropic/claude-opus-5.5';
    const replayed: unknown[] = [];
    const cached: boolean[] = [];

    const upstream = asFetchFunction(async (input, init) => {
      if (requestUrl(input) === 'https://models.dev/api.json') return Response.json({});
      const text = await new Request(input, init).text();
      const { messages } = v.parse(MessagesRequestSchema, JSON.parse(text));
      const result = messages.at(-1)?.content;

      if (!Array.isArray(result) || !result.some((block) => block.type === 'tool_result')) {
        return claudeStream([
          { type: 'thinking', thinking: 'Read the file first.', signature: 'sig-anthropic-1' },
          { type: 'tool_use', id: 'toolu_1', name: 'look', input: { path: 'a.txt' } },
        ], 'tool_use');
      }

      replayed.push(messages.at(-2)?.content);
      cached.push(text.includes('"cache_control"'));

      return claudeStream([{ type: 'text', text: 'a.txt says hello' }], 'end_turn');
    });

    const { hosted, local } = gatewayRoutes(upstream, [spec]);
    const workerFetch = globalThis.fetch;
    globalThis.fetch = upstream;

    try {
      const answers: string[] = [];

      for (const model of [hosted.resolveModel(spec, 'kinu-test'), local.resolveModel(spec, 'kinu-test')]) {
        const events: ChatEvent[] = [];

        for await (const event of runChat({
          model, system: 'You read files.', history: [{ role: 'user', content: 'What does a.txt say?' }],
          tools: { look: tool({ description: 'Read a file.', inputSchema: z.object({ path: z.string() }), execute: async () => 'hello' }) },
          cache: { providerId: 'my-gateway', modelId: 'anthropic/claude-opus-5.5', sessionKey: 'kinu-test' },
        })) events.push(event);

        answers.push(events.flatMap((event) => (event.type === 'text-delta' ? [event.delta] : [])).join(''));
      }

      const call = [
        { type: 'thinking', thinking: 'Read the file first.', signature: 'sig-anthropic-1' },
        { type: 'tool_use', name: 'look', input: { path: 'a.txt' } },
      ];

      expect({ answers, replayed, cached }).toMatchObject({ answers: ['a.txt says hello', 'a.txt says hello'], replayed: [call, call], cached: [true, true] });
    } finally {
      globalThis.fetch = workerFetch;
    }
  });
});
