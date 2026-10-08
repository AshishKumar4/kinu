/** A model reached through a gateway speaks its own provider's API on both backends: the CLI through the worker's proxy. */
import { describe, expect, test } from 'bun:test';
import { generateText, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import * as v from 'valibot';
import { asFetchFunction, requestUrl, runChat, type AuthResolution, type ChatEvent, type JsonObject, type UserCaller } from '@kinu.run/core';
import { createAgentProviderRegistry } from '../../src/providers/agent-registry';
import { aiProxyRoutes } from '../../src/user/ai-proxy';
import { cliRoutes, type CliRoutesEnv } from '../../src/cli/routes';
import { createLocalModelResolver } from '../../../cli-backend/src/model-resolver';
import { NO_RELAY_MACHINE } from '../helpers/user-credentials';
import { testOwner, TEST_CREDENTIAL_ENCRYPTION_KEY } from '../helpers/user-do';
import { serveFamily } from '../helpers/api';
import { cliAccount, unreachableAssets, unreachableKv, unreachableNamespace } from '../helpers/bindings';

const ACCOUNT_AI = 'https://api.cloudflare.com/client/v4/accounts/abc123abc123abc1/ai/v1';

/** The owner's gateway `default`, at its endpoints for each author's own API. */
const GATEWAY = 'https://gateway.ai.cloudflare.com/v1/abc123abc123abc1/default';

const ORIGIN = 'https://kinu.example.test';

const CLI_TOKEN = `ptc_${'0'.repeat(32)}_abcdefghijklmnopqrstuvwxyz`;

/** The owner's CLI bearer, as the worker verifies it. */
async function signedIn(_caller: UserCaller, bearer: string) {
  return { ok: bearer === CLI_TOKEN, tokenHash: 'h', user: { id: '0'.repeat(32), email: 'owner@example.test', displayName: 'Owner' } };
}

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
      verifyCliToken: signedIn,
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
  // refused in these words (measured 2026-10-06); OpenAI's own provider speaks Responses, and so must every route to it,
  // at the gateway's endpoint for it, which takes the SDK's own request.
  test('a gateway model speaks its author\'s own API on both backends, the CLI through the signed-in proxy', async () => {
    const wire: string[] = [];
    const keys: string[] = [];
    const menu = ['my-gateway/openai/gpt-6.1-sol', 'my-gateway/google/gemini-2.5-flash', 'my-gateway/anthropic/claude-sonnet-4.5'];

    const upstream = asFetchFunction(async (input, init) => {
      const url = requestUrl(input);

      if (url === 'https://models.dev/api.json') {
        return Response.json({
          openai: { id: 'openai', npm: '@ai-sdk/openai', models: { 'gpt-6.1-sol': { id: 'gpt-6.1-sol', reasoning: true, tool_call: true } } },
          google: { id: 'google', npm: '@ai-sdk/google', models: { 'gemini-2.5-flash': { id: 'gemini-2.5-flash', tool_call: true } } },
        });
      }

      const request = new Request(input, init);
      const body = v.parse(v.object({ model: v.string(), tools: v.optional(v.array(v.unknown())), system: v.optional(v.unknown()) }), JSON.parse(await request.text()));
      const endpoint = url.startsWith(GATEWAY) ? url.slice(`${GATEWAY}/`.length) : url.slice(`${ACCOUNT_AI}/`.length);
      wire.push(`${endpoint} ${body.model}`);

      // At an author's endpoint the gateway's token is its own header: `Authorization` there is the author's key.
      if (url.startsWith(GATEWAY)) keys.push([...request.headers.keys()].filter((name) => /authorization|api-key|gateway-id/u.test(name)).join(' '));

      if (endpoint === 'anthropic/v1/messages') {
        return Response.json({
          id: 'msg_1', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', stop_sequence: null,
          content: [{ type: 'text', text: 'served' }], usage: { input_tokens: 1, output_tokens: 1 },
        });
      }

      if (endpoint === 'openai/responses') {
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

      for (const spec of menu) answered.push(await answer(hosted.resolveModel(spec, { sessionAffinity: 'kinu-test', workspaceAffinity: 'kinu-test' })), await answer(local.resolveModel(spec, { sessionAffinity: 'kinu-test', workspaceAffinity: 'kinu-test' })));

      expect({ answered, wire, keys }).toEqual({
        answered: ['served', 'served', 'served', 'served', 'served', 'served'],
        wire: [
          'openai/responses gpt-6.1-sol', 'openai/responses gpt-6.1-sol', 'chat/completions google/gemini-2.5-flash',
          'chat/completions google/gemini-2.5-flash', 'anthropic/v1/messages claude-sonnet-4-5', 'anthropic/v1/messages claude-sonnet-4-5',
        ],
        keys: ['cf-aig-authorization', 'cf-aig-authorization', 'cf-aig-authorization', 'cf-aig-authorization'],
      });
    } finally {
      globalThis.fetch = workerFetch;
    }
  });

  // Fable 5.1 and Opus 5.5 think by default, and Anthropic reads a tool result only after the signed thinking that
  // called it, unchanged. The gateway's endpoint for Anthropic is Anthropic's own API, so the replay keeps the block
  // whole and caches as Anthropic does.
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

      for (const model of [hosted.resolveModel(spec, { sessionAffinity: 'kinu-test', workspaceAffinity: 'kinu-test' }), local.resolveModel(spec, { sessionAffinity: 'kinu-test', workspaceAffinity: 'kinu-test' })]) {
        const events: ChatEvent[] = [];

        for await (const event of runChat({
          modelSpec: 'test/model',
          model, system: 'You read files.', history: [{ role: 'user', content: 'What does a.txt say?' }],
          tools: { look: tool({ description: 'Read a file.', inputSchema: z.object({ path: z.string() }), execute: async () => 'hello' }) },
          cache: { providerId: 'my-gateway', modelId: 'anthropic/claude-opus-5.5' },
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

/** One event-loop turn, with no duration. */
async function oneTurn(): Promise<void> {
  const turn = Promise.withResolvers<void>();
  setImmediate(turn.resolve);
  await turn.promise;
}

describe('an account\'s model menu', () => {
  // A credential named `openai-compat.groq` once added a `openai-compat:groq/<modelId>` row the picker sent as is.
  // models.dev's catalog is about 1.5 MB of JSON, so the providers listing together on a cold cache share one read.
  test('lists each key\'s own models from one catalog read, after a refused read, and the chosen one reaches its endpoint', async () => {
    const ENDPOINT = 'https://groq.example.test/openai/v1';
    const KEYS = ['anthropic.bearer', 'openai.bearer', 'openai-compat.groq'];
    const sent: string[] = [];
    let catalogReads = 0;

    const upstream = asFetchFunction(async (input, init) => {
      const url = requestUrl(input);

      if (url === 'https://models.dev/api.json') {
        catalogReads += 1;

        // Long enough for every listing to reach models.dev if it would.
        for (let turn = 0; turn < 20; turn += 1) await oneTurn();

        if (catalogReads === 1) return new Response('busy', { status: 503 });

        return Response.json({
          anthropic: { id: 'anthropic', name: 'Anthropic', models: { 'claude-x': { id: 'claude-x', name: 'Claude X', tool_call: true } } },
          openai: { id: 'openai', name: 'OpenAI', api: 'https://api.openai.com/v1', models: { 'gpt-x': { id: 'gpt-x', name: 'GPT X', tool_call: true } } },
        });
      }

      if (url === `${ENDPOINT}/models`) return Response.json({ object: 'list', data: [{ id: 'llama-4-scout', object: 'model' }] });

      if (url === `${ENDPOINT}/chat/completions`) {
        sent.push(v.parse(v.object({ model: v.string() }), JSON.parse(await new Request(input, init).text())).model);

        return Response.json({ id: 'c', object: 'chat.completion', created: 1, model: 'llama-4-scout',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'served' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      }

      throw new Error(`unexpected fetch: ${url}`);
    });

    const keyed = async (key: string): Promise<AuthResolution | null> => {
      if (key === 'openai-compat.groq') return { baseURL: ENDPOINT, headers: { authorization: 'Bearer gsk-test' } };

      return KEYS.includes(key) ? { headers: { authorization: 'Bearer sk-test' } } : null;
    };

    const account = cliAccount({
      verifyCliToken: signedIn,
      getAuth: async (_caller, key: string) => await keyed(key),
      listCredentials: async () => KEYS.map((key) => ({ key, kind: 'bearer' as const, createdAt: 0, updatedAt: 0 })),
      ...NO_RELAY_MACHINE,
    });

    const env: CliRoutesEnv<string> = {
      UserDO: { idFromName: (name) => name, get: () => account },
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
      OrchestratorAgent: unreachableNamespace('OrchestratorAgent'),
      AUTH_KV: unreachableKv('AUTH_KV'),
      ASSETS: unreachableAssets(),
    };

    const menu = async () => {
      const answered = await serveFamily(cliRoutes)(new Request(`${ORIGIN}/api/cli/models`, { headers: { authorization: `Bearer ${CLI_TOKEN}` } }), env);
      const body = v.parse(v.object({ models: v.array(v.object({ spec: v.string() })), failures: v.array(v.object({ provider: v.string() })) }), await answered?.json());

      return { specs: body.models.map((model) => model.spec).sort(), failed: body.failures.map((failure) => failure.provider).sort() };
    };

    const workerFetch = globalThis.fetch;
    globalThis.fetch = upstream;

    try {
      const refused = await menu();
      const served = await menu();
      const hosted = createAgentProviderRegistry({ env: {}, fetch: upstream, userDO: { caller: testOwner, stub: account } });
      const answer = (await generateText({ model: hosted.resolveModel('openai-compat:groq/llama-4-scout', { sessionAffinity: 'kinu-test', workspaceAffinity: 'kinu-test' }), prompt: 'hi' })).text;

      expect({ refused, served, catalogReads, answer, sent }).toEqual({
        // The refused read fails the listing that met it; the next ones read again, together.
        refused: { specs: ['anthropic/claude-x', 'openai-compat:groq/llama-4-scout', 'openai/gpt-x'], failed: ['catalog'] },
        served: { specs: ['anthropic/claude-x', 'openai-compat:groq/llama-4-scout', 'openai/gpt-x'], failed: [] },
        catalogReads: 2,
        answer: 'served',
        sent: ['llama-4-scout'],
      });
    } finally {
      globalThis.fetch = workerFetch;
    }
  });
});
