// Prompt-cache markers on the wire: runChat through each real provider with a mocked fetch, asserting
// the HTTP body carries that provider's cache addressing.
import { describe, test, expect } from 'bun:test';
import { isStepCount, tool, type ModelMessage, type ToolSet } from 'ai';
import * as v from 'valibot';
import { z } from 'zod';
import {
  runChat, ProviderPacer,
  createAnthropicProvider, createOpenAIProvider, createOpenRouterProvider, createOpenAICompatProvider, createClaudeProvider, CLAUDE_CRED_KEY,
  ANTHROPIC_CRED_KEY, OPENAI_CRED_KEY, OPENROUTER_CRED_KEY,
  JsonObjectSchema, JsonValueSchema, parseJsonObject,
  type JsonObject, type JsonValue,
  type ModelCallDeps, type AuthResolution, type CacheRetention,
} from '../src/index';
import { createMockFetch, type MockFetchHandle } from '@kinu.run/test-utils';

function makeDeps(creds: Record<string, AuthResolution>, fetchFn: typeof fetch): ModelCallDeps {
  const store = new Map(Object.entries(creds));

  return {
    env: {},
    sessionAffinity: 'kinu-test',
    workspaceAffinity: 'kinu-test',
    fetch: fetchFn,
    async getAuth(key) { return store.get(key) ?? null; },
    async hasCredential(key) { return store.has(key); },
  };
}

/** Unmarked, as both backends build it: the request's cache plan places the tool breakpoint. */
function chatTools(): ToolSet {
  return {
    echo: tool({
      description: 'echo back',
      inputSchema: z.object({ x: z.number() }),
      execute: async ({ x }) => `echo:${x}`,
    }),
  };
}

const HISTORY = [
  { role: 'user' as const, content: 'first question' },
  { role: 'assistant' as const, content: 'first answer' },
  { role: 'user' as const, content: 'second question' },
];

/** Drain runChat without absorbing errors: the non-Anthropic blocks answer 400 and assert the rejection. */
async function drain(opts: Parameters<typeof runChat>[0]): Promise<void> {
  for await (const _ of runChat(opts)) { /* consume */ }
}

function bodyOf(handle: MockFetchHandle, i: number): JsonObject {
  const req = handle.requests[i];
  expect(req?.body).toBeDefined();

  return parseJsonObject(v.parse(v.string(), req?.body));
}

function countCacheControl(value: JsonValue): number {
  const json = JSON.stringify(value);

  return (json.match(/"cache_control"/g) ?? []).length;
}

function field<Output>(body: JsonObject, key: string, schema: v.GenericSchema<Output>): Output {
  return v.parse(schema, body[key]);
}

const CacheControlSchema = JsonObjectSchema;

const SystemBlocksSchema = v.array(v.object({
  text: v.optional(v.string()), cache_control: v.optional(CacheControlSchema),
}));

const ToolBlocksSchema = v.array(v.object({
  name: v.optional(v.string()), cache_control: v.optional(CacheControlSchema),
}));

const AnthropicMessagesSchema = v.array(v.object({
  role: v.optional(v.string()),
  content: v.array(v.object({
    type: v.optional(v.string()), cache_control: v.optional(CacheControlSchema),
  })),
}));

const OpenAiMessagesSchema = v.array(v.object({
  role: v.string(), content: v.optional(JsonValueSchema),
  cache_control: v.optional(CacheControlSchema),
}));

/** Ends in a tool_use, so streamText issues a second request. */
const ANTHROPIC_TOOL_USE_SSE = [
  'event: message_start',
  `data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-opus-4-7', stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } })}`,
  '',
  'event: content_block_start',
  `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'echo' } })}`,
  '',
  'event: content_block_delta',
  `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } })}`,
  '',
  'event: content_block_stop',
  `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
  '',
  'event: message_delta',
  `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } })}`,
  '',
  'event: message_stop',
  `data: ${JSON.stringify({ type: 'message_stop' })}`,
  '',
  '',
].join('\n');

const ANTHROPIC_TEXT_SSE = [
  'event: message_start',
  `data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_2', type: 'message', role: 'assistant', content: [], model: 'claude-opus-4-7', stop_reason: null, usage: { input_tokens: 20, output_tokens: 1 } } })}`,
  '',
  'event: content_block_start',
  `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
  '',
  'event: content_block_delta',
  `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } })}`,
  '',
  'event: content_block_stop',
  `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
  '',
  'event: message_delta',
  `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } })}`,
  '',
  'event: message_stop',
  `data: ${JSON.stringify({ type: 'message_stop' })}`,
  '',
  '',
].join('\n');

describe('Anthropic cache breakpoints on the wire', () => {
  async function runAnthropicTurn(retention?: CacheRetention, system: { readonly text: string; readonly shared?: number } = { text: 'You are Kinu.' }): Promise<MockFetchHandle> {
    const mock = createMockFetch([{
      match: 'api.anthropic.com',
      respond: (_req, callIndex) => ({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: callIndex === 0 ? ANTHROPIC_TOOL_USE_SSE : ANTHROPIC_TEXT_SSE,
      }),
    }]);

    const deps = makeDeps({
      [ANTHROPIC_CRED_KEY]: { headers: { 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' } },
    }, mock.fetch);

    const model = createAnthropicProvider().createModel('claude-opus-4-7', deps);
    await drain({
      modelSpec: 'test/model',
      model,
      system: system.text,
      ...(system.shared !== undefined && { systemShared: system.shared }),
      history: [...HISTORY],
      tools: chatTools(),
      stopWhen: isStepCount(3),
      cache: {
        providerId: 'anthropic', modelId: 'claude-opus-4-7',
        retention,
      },
    });

    return mock;
  }

  test('system + last tool + last-2 messages carry cache_control, within the 4-block limit', async () => {
    const mock = await runAnthropicTurn();
    expect(mock.requests.length).toBeGreaterThanOrEqual(1);
    const body = bodyOf(mock, 0);

    const system = field(body, 'system', SystemBlocksSchema);
    expect(system[system.length - 1]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(system.map((block) => block.text).join('')).toBe('You are Kinu.');

    const tools = field(body, 'tools', ToolBlocksSchema);
    expect(tools[tools.length - 1]?.cache_control).toEqual({ type: 'ephemeral' });

    const messages = field(body, 'messages', AnthropicMessagesSchema);
    const last = messages[messages.length - 1]?.content ?? [];
    const prev = messages[messages.length - 2]?.content ?? [];
    expect(last[last.length - 1]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(prev[prev.length - 1]?.cache_control).toEqual({ type: 'ephemeral' });

    expect(countCacheControl(body)).toBeLessThanOrEqual(4);
  });

  test('the system part every workspace shares is a block of its own, its breakpoint in the tools\' place, on every step', async () => {
    const shared = 'You are Kinu. The guidance every workspace shares.';
    const mock = await runAnthropicTurn(undefined, { text: `${shared}\n\nYou work in the workspace "Ledger".`, shared: shared.length });

    for (const index of [0, 1]) {
      const body = bodyOf(mock, index);

      expect(field(body, 'system', SystemBlocksSchema).map((block) => [block.text, block.cache_control])).toEqual([
        [shared, { type: 'ephemeral' }],
        ['You work in the workspace "Ledger".', { type: 'ephemeral' }],
      ]);
      expect(field(body, 'tools', ToolBlocksSchema).some((offered) => offered.cache_control !== undefined)).toBe(false);
      expect(countCacheControl(body)).toBe(4);
    }
  });

  test('breakpoints ROLL onto the newest tail on the second step of the tool loop', async () => {
    const mock = await runAnthropicTurn();
    expect(mock.requests.length).toBe(2);
    const step2 = bodyOf(mock, 1);

    const messages = field(step2, 'messages', AnthropicMessagesSchema);
    // Step 2: the tail markers move to the newest messages.
    const last = messages[messages.length - 1];
    expect(last?.content.some((part) => part.type === 'tool_result')).toBe(true);
    expect(last?.content[last.content.length - 1]?.cache_control).toEqual({ type: 'ephemeral' });

    const markedMessages = messages.filter((message) => message.content.some((part) => part.cache_control)).length;
    expect(markedMessages).toBe(2);
    expect(countCacheControl(step2)).toBeLessThanOrEqual(4);
  });

  test("retention 'long' puts ttl:1h on EVERY breakpoint — tools, system and tail", async () => {
    const mock = await runAnthropicTurn('long');
    const body = bodyOf(mock, 0);
    const long = { type: 'ephemeral', ttl: '1h' };

    const system = field(body, 'system', SystemBlocksSchema);
    expect(system[system.length - 1]?.cache_control).toEqual(long);
    const tools = field(body, 'tools', ToolBlocksSchema);
    expect(tools[tools.length - 1]?.cache_control).toEqual(long);
    const messages = field(body, 'messages', AnthropicMessagesSchema);
    const last = messages[messages.length - 1]?.content ?? [];
    expect(last[last.length - 1]?.cache_control).toEqual(long);
    expect(countCacheControl(body)).toBeLessThanOrEqual(4);
  });

  test("retention 'none' writes no cache_control at all", async () => {
    const mock = await runAnthropicTurn('none');
    const body = bodyOf(mock, 0);
    expect(countCacheControl(body)).toBe(0);
    const system = field(body, 'system', SystemBlocksSchema);
    expect(system.every((block) => block.cache_control === undefined)).toBe(true);
  });
});

// Anthropic refuses a request whose breakpoints raise their TTL along tools → system → messages (production,
// 2026-10-05: Claude Opus 5.5 after GPT turns, "a ttl='1h' cache_control block must not come after a ttl='5m'").
describe('one TTL per request, in the order Anthropic reads it', () => {
  const GPT_THEN_CLAUDE: ModelMessage[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'Planning a greeting.', providerOptions: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'ENC' } } }, { type: 'text', text: 'Hello! What first?', providerOptions: { openai: { itemId: 'msg_1' } } }] },
    { role: 'user', content: 'onboard yourself on this project' },
  ];

  const ttlOf = (block: JsonValue | undefined): string => {
    const parsed = v.safeParse(v.object({ cache_control: v.object({ ttl: v.optional(v.string()) }) }), block);

    return parsed.success ? parsed.output.cache_control.ttl ?? '5m' : '';
  };

  /** Every breakpoint's TTL in the order the API processes them: tools, system, then each message's blocks. */
  const breakpointTtls = (body: JsonObject): string[] => [
    ...v.parse(v.array(JsonValueSchema), body.tools ?? []),
    ...v.parse(v.array(JsonValueSchema), body.system ?? []),
    ...v.parse(v.array(v.looseObject({ content: v.array(JsonValueSchema) })), body.messages).flatMap((message) => message.content),
  ].map(ttlOf).filter((ttl) => ttl !== '');

  test.each([
    ['claude', 'short'], ['claude', 'long'], ['anthropic', 'short'], ['anthropic', 'long'],
  ] as const)('the %s route at %s retention marks tools, system and tail with one TTL', async (route, retention) => {
    const mock = createMockFetch([{ match: 'api.anthropic.com', respond: () => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: ANTHROPIC_TEXT_SSE }) }]);
    const credKey = route === 'claude' ? CLAUDE_CRED_KEY : ANTHROPIC_CRED_KEY;
    const deps = makeDeps({ [credKey]: { headers: route === 'claude' ? { Authorization: 'Bearer sk-ant-oat01-test' } : { 'x-api-key': 'sk-ant-test' }, credentialKey: credKey } }, mock.fetch);
    const provider = route === 'claude' ? createClaudeProvider() : createAnthropicProvider();

    await drain({
      modelSpec: 'test/model',
      model: provider.createModel('claude-opus-5-5', deps), system: 'You are Kinu.', history: GPT_THEN_CLAUDE,
      tools: chatTools(), cache: { providerId: route, modelId: 'claude-opus-5-5', retention },
    });

    const ttls = breakpointTtls(bodyOf(mock, 0));

    expect(ttls.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ttls).size).toBe(1);
  });
  // Audit New#2: a fallback is prepared for the provider serving it, per m1820's fallback chain.
  test('an OpenAI turn that falls back to Claude sends Claude its own cache markers and replay', async () => {
    const mock = createMockFetch([
      { match: 'api.openai.com', respond: { status: 503, body: JSON.stringify({ error: { message: 'overloaded', type: 'server_error' } }) } },
      { match: 'api.anthropic.com', respond: () => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: ANTHROPIC_TEXT_SSE }) },
    ]);

    const deps = makeDeps({
      [OPENAI_CRED_KEY]: { headers: { Authorization: 'Bearer sk-openai' } },
      [ANTHROPIC_CRED_KEY]: { headers: { 'x-api-key': 'sk-ant-test' } },
    }, mock.fetch);

    await drain({
      model: createOpenAIProvider().createModel('gpt-5.5', deps), modelSpec: 'openai/gpt-5.5',
      fallbacks: [{
        spec: 'anthropic/claude-opus-5-5', accepts: new Set(), window: { contextWindow: null, modelOutputLimit: null },
        bind: () => ({ model: createAnthropicProvider().createModel('claude-opus-5-5', deps), provider: 'anthropic' }),
      }],
      pacer: new ProviderPacer(),
      system: 'You are Kinu.', history: GPT_THEN_CLAUDE, tools: chatTools(),
      cache: { providerId: 'openai', modelId: 'gpt-5.5' },
    });

    const sent = mock.requests.findIndex((request) => request.url.includes('api.anthropic.com'));
    const body = bodyOf(mock, sent);

    expect({
      system: breakpointTtls({ system: body.system ?? [], messages: [] }).length,
      tools: breakpointTtls({ tools: body.tools ?? [], messages: [] }).length,
      replayedOpenAiItem: JSON.stringify(body.messages).includes('rs_1'),
    }).toEqual({ system: 1, tools: 1, replayedOpenAiItem: false });
  });
});

// No request carries a cache key: the static prompt every conversation and workspace shares is cached once for all of
// them (the owner, 2026-10-08; OpenAI caches a prefix with or without one, measured 2026-10-08).
describe('OpenAI caches by prefix, with no key on the wire', () => {
  test('openai (responses API): no prompt_cache_key', async () => {
    const mock = createMockFetch([
      { match: 'api.openai.com', respond: { status: 400, body: {} } },
    ]);

    const deps = makeDeps({ [OPENAI_CRED_KEY]: { headers: { Authorization: 'Bearer sk-test' } } }, mock.fetch);
    const model = createOpenAIProvider().createModel('gpt-5.5', deps);
    await expect(drain({
      modelSpec: 'test/model',
      model, system: 'sys', history: [...HISTORY], tools: {},
      cache: { providerId: 'openai', modelId: 'gpt-5.5' },
    })).rejects.toThrow();
    const body = bodyOf(mock, 0);
    expect(body.prompt_cache_key).toBeUndefined();
    expect(body.prompt_cache_retention).toBeUndefined();
    expect(countCacheControl(body)).toBe(0);
  });

  test("retention 'long' asks OpenAI for the 24h prompt cache", async () => {
    const mock = createMockFetch([
      { match: 'api.openai.com', respond: { status: 400, body: {} } },
    ]);

    const deps = makeDeps({ [OPENAI_CRED_KEY]: { headers: { Authorization: 'Bearer sk-test' } } }, mock.fetch);
    const model = createOpenAIProvider().createModel('gpt-5.5', deps);
    await expect(drain({
      modelSpec: 'test/model',
      model, system: 'sys', history: [...HISTORY], tools: {},
      cache: { providerId: 'openai', modelId: 'gpt-5.5', retention: 'long' },
    })).rejects.toThrow();
    expect(bodyOf(mock, 0).prompt_cache_retention).toBe('24h');
  });

  test("retention 'none' asks for no retention either", async () => {
    const mock = createMockFetch([
      { match: 'api.openai.com', respond: { status: 400, body: {} } },
    ]);

    const deps = makeDeps({ [OPENAI_CRED_KEY]: { headers: { Authorization: 'Bearer sk-test' } } }, mock.fetch);
    const model = createOpenAIProvider().createModel('gpt-5.5', deps);
    await expect(drain({
      modelSpec: 'test/model',
      model, system: 'sys', history: [...HISTORY], tools: {},
      cache: { providerId: 'openai', modelId: 'gpt-5.5', retention: 'none' },
    })).rejects.toThrow();
    const body = bodyOf(mock, 0);
    expect(body.prompt_cache_key).toBeUndefined();
    expect(body.prompt_cache_retention).toBeUndefined();
  });
});

describe('OpenRouter cache addressing on the wire', () => {
  async function runOpenRouterTurn(modelId: string): Promise<JsonObject> {
    const mock = createMockFetch([
      { match: 'openrouter.ai', respond: { status: 400, body: {} } },
    ]);

    const deps = makeDeps({ [OPENROUTER_CRED_KEY]: { headers: { Authorization: 'Bearer sk-or' } } }, mock.fetch);
    const model = createOpenRouterProvider().createModel(modelId, deps);
    await expect(drain({
      modelSpec: 'test/model',
      model, system: 'sys', history: [...HISTORY], tools: {},
      cache: { providerId: 'openrouter', modelId },
    })).rejects.toThrow();

    return bodyOf(mock, 0);
  }

  test('claude behind openrouter: cache_control on system and tail, and no key', async () => {
    const body = await runOpenRouterTurn('anthropic/claude-sonnet-4.6');
    expect(body.prompt_cache_key).toBeUndefined();

    const messages = field(body, 'messages', OpenAiMessagesSchema);
    const system = messages.find((m) => m.role === 'system');
    expect(system?.cache_control).toEqual({ type: 'ephemeral' });
    const nonSystem = messages.filter((m) => m.role !== 'system');
    expect(nonSystem[nonSystem.length - 1]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(nonSystem[nonSystem.length - 2]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(countCacheControl(body)).toBeLessThanOrEqual(4);
  });

  test('non-anthropic model: neither a key nor cache_control markers', async () => {
    const body = await runOpenRouterTurn('meta-llama/llama-4-maverick');
    expect(body.prompt_cache_key).toBeUndefined();
    expect(countCacheControl(body)).toBe(0);
    const messages = field(body, 'messages', OpenAiMessagesSchema);
    expect(messages[0]).toEqual({ role: 'system', content: 'sys' });
  });
});

describe('openai-compat + no-op providers', () => {
  test('an openai-compat endpoint is sent no cache key', async () => {
    const mock = createMockFetch([
      { match: 'groq.example', respond: { status: 400, body: {} } },
    ]);

    const deps = makeDeps({
      'openai-compat.default': { headers: { Authorization: 'Bearer k' }, baseURL: 'https://groq.example/v1' },
    }, mock.fetch);

    const model = createOpenAICompatProvider().createModel('llama-4', deps);
    await expect(drain({
      modelSpec: 'test/model',
      model, system: 'sys', history: [...HISTORY], tools: {},
      cache: { providerId: 'openai-compat', modelId: 'llama-4' },
    })).rejects.toThrow();
    const body = bodyOf(mock, 0);
    expect(body.prompt_cache_key).toBeUndefined();
    expect(countCacheControl(body)).toBe(0);
  });

  test('no cache identity (or a no-cache provider) leaves the request untouched', async () => {
    const mock = createMockFetch([
      { match: 'groq.example', respond: { status: 400, body: {} } },
    ]);

    const deps = makeDeps({
      'openai-compat.default': { headers: { Authorization: 'Bearer k' }, baseURL: 'https://groq.example/v1' },
    }, mock.fetch);

    const model = createOpenAICompatProvider().createModel('llama-4', deps);
    // workers-ai resolves to the `none` strategy: affinity headers, not body fields.
    await expect(drain({
      modelSpec: 'test/model',
      model, system: 'sys', history: [...HISTORY], tools: {},
      cache: { providerId: 'workers-ai', modelId: '@cf/moonshotai/kimi-k2.6' },
    })).rejects.toThrow();
    const body = bodyOf(mock, 0);
    expect(body.prompt_cache_key).toBeUndefined();
    expect(countCacheControl(body)).toBe(0);
    expect(field(body, 'messages', OpenAiMessagesSchema)[0]).toEqual({ role: 'system', content: 'sys' });
  });
});
