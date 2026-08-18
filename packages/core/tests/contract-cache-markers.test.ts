// Prompt-cache markers ON THE WIRE — the load-bearing proof for the
// cache-breakpoint layer: drive runChat through each real provider with a
// mocked fetch and assert the HTTP body carries the provider's cache
// addressing (Anthropic cache_control at system + tail + last tool, budgeted
// to the 4-block limit and ROLLED forward across steps; prompt_cache_key /
// promptCacheKey for the OpenAI-compatible family; nothing for no-op
// providers).
//
// Live readback: the provider's report normalizes to `Usage.cacheRead`, which
// the turn accumulator sums per step — the `cacheRead=` field of the
// step_finish activity-log line. cacheRead/input is the cache-read ratio these
// markers exist to raise.
import { describe, test, expect } from 'bun:test';
import { tool, type ToolSet } from 'ai';
import * as v from 'valibot';
import { z } from 'zod';
import {
  runChat,
  createAnthropicProvider, createOpenAIProvider, createOpenRouterProvider, createOpenAICompatProvider,
  markLastToolForAnthropicCache,
  ANTHROPIC_CRED_KEY, OPENAI_CRED_KEY, OPENROUTER_CRED_KEY,
  JsonObjectSchema, JsonValueSchema, parseJsonObject,
  type JsonObject, type JsonValue,
  type ProviderDeps, type AuthResolution, type CacheRetention,
} from '../src/index';
import { createMockFetch, type MockFetchHandle } from '@proteus/test-utils';

function makeDeps(creds: Record<string, AuthResolution>, fetchFn: typeof fetch): ProviderDeps {
  const store = new Map(Object.entries(creds));
  return {
    env: {},
    fetch: fetchFn,
    async getAuth(key) { return store.get(key) ?? null; },
    async hasCredential(key) { return store.has(key); },
  };
}

function chatTools(retention?: CacheRetention): ToolSet {
  const tools: ToolSet = {
    echo: tool({
      description: 'echo back',
      inputSchema: z.object({ x: z.number() }),
      execute: async ({ x }) => `echo:${x}`,
    }),
  };
  // Both backends mark the tool surface at build time; mirror that here.
  markLastToolForAnthropicCache(tools, retention);
  return tools;
}

const HISTORY = [
  { role: 'user' as const, content: 'first question' },
  { role: 'assistant' as const, content: 'first answer' },
  { role: 'user' as const, content: 'second question' },
];

/**
 * Drain runChat. Nothing is absorbed here: the Anthropic block answers with
 * real SSE and this resolves, while the OpenAI/OpenRouter/compat blocks answer
 * 400 on purpose and assert the rejection at the call site. Swallowing it made
 * "the request reached the wire and the provider refused it" indistinguishable
 * from "the turn died before sending anything", which is the one thing every
 * assertion in this file depends on.
 */
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

// ── Anthropic: full breakpoint layout, rolled across steps ────────────────

/** Minimal Anthropic SSE stream ending in a tool_use, so streamText runs a
 *  second step (and a second HTTP request) with the tool result appended. */
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
].join('\n');

describe('Anthropic cache breakpoints on the wire', () => {
  async function runAnthropicTurn(retention?: CacheRetention): Promise<MockFetchHandle> {
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
      model,
      system: 'You are Proteus.',
      history: [...HISTORY],
      tools: chatTools(retention),
      maxSteps: 3,
      cache: {
        providerId: 'anthropic', modelId: 'claude-opus-4-7', sessionKey: 'proteus-test',
        retention,
      },
    });
    return mock;
  }

  test('system + last tool + last-2 messages carry cache_control, within the 4-block limit', async () => {
    const mock = await runAnthropicTurn();
    expect(mock.requests.length).toBeGreaterThanOrEqual(1);
    const body = bodyOf(mock, 0);

    // System prompt is a cache-eligible block with the end-of-system breakpoint.
    const system = field(body, 'system', SystemBlocksSchema);
    expect(system[system.length - 1]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(system.map((block) => block.text).join('')).toBe('You are Proteus.');

    // The tool-surface breakpoint (fold of the old cf-backend anthropic-cache.ts).
    const tools = field(body, 'tools', ToolBlocksSchema);
    expect(tools[tools.length - 1]?.cache_control).toEqual({ type: 'ephemeral' });

    // Rolling tail: the last 2 messages end with a cache_control block.
    const messages = field(body, 'messages', AnthropicMessagesSchema);
    const last = messages[messages.length - 1]?.content ?? [];
    const prev = messages[messages.length - 2]?.content ?? [];
    expect(last[last.length - 1]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(prev[prev.length - 1]?.cache_control).toEqual({ type: 'ephemeral' });

    // Anthropic hard limit: at most 4 cache_control blocks per request.
    expect(countCacheControl(body)).toBeLessThanOrEqual(4);
  });

  test('breakpoints ROLL onto the newest tail on the second step of the tool loop', async () => {
    const mock = await runAnthropicTurn();
    expect(mock.requests.length).toBe(2);
    const step2 = bodyOf(mock, 1);

    const messages = field(step2, 'messages', AnthropicMessagesSchema);
    // Step 2 appends the assistant tool_use + the tool_result — the tail
    // markers must now sit on those newest messages, not the old tail.
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
    // A longer TTL must not buy more breakpoints.
    expect(countCacheControl(body)).toBeLessThanOrEqual(4);
  });

  test("retention 'none' writes no cache_control at all", async () => {
    const mock = await runAnthropicTurn('none');
    const body = bodyOf(mock, 0);
    expect(countCacheControl(body)).toBe(0);
    // The system prompt falls back to the plain (uncached) block.
    const system = field(body, 'system', SystemBlocksSchema);
    expect(system.every((block) => block.cache_control === undefined)).toBe(true);
  });
});

// ── OpenAI family: prompt_cache_key routing ───────────────────────────────

describe('OpenAI prompt_cache_key on the wire', () => {
  test('openai (responses API): promptCacheKey serializes as prompt_cache_key', async () => {
    const mock = createMockFetch([
      { match: 'api.openai.com', respond: { status: 400, body: {} } },
    ]);
    const deps = makeDeps({ [OPENAI_CRED_KEY]: { headers: { Authorization: 'Bearer sk-test' } } }, mock.fetch);
    const model = createOpenAIProvider().createModel('gpt-5.5', deps);
    await expect(drain({
      model, system: 'sys', history: [...HISTORY], tools: {},
      cache: { providerId: 'openai', modelId: 'gpt-5.5', sessionKey: 'proteus-agent:default' },
    })).rejects.toThrow();
    const body = bodyOf(mock, 0);
    expect(body.prompt_cache_key).toBe('proteus-agent:default');
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
      model, system: 'sys', history: [...HISTORY], tools: {},
      cache: { providerId: 'openai', modelId: 'gpt-5.5', sessionKey: 'k', retention: 'long' },
    })).rejects.toThrow();
    expect(bodyOf(mock, 0).prompt_cache_retention).toBe('24h');
  });

  test("retention 'none' routes no cache key at all", async () => {
    const mock = createMockFetch([
      { match: 'api.openai.com', respond: { status: 400, body: {} } },
    ]);
    const deps = makeDeps({ [OPENAI_CRED_KEY]: { headers: { Authorization: 'Bearer sk-test' } } }, mock.fetch);
    const model = createOpenAIProvider().createModel('gpt-5.5', deps);
    await expect(drain({
      model, system: 'sys', history: [...HISTORY], tools: {},
      cache: { providerId: 'openai', modelId: 'gpt-5.5', sessionKey: 'k', retention: 'none' },
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
      model, system: 'sys', history: [...HISTORY], tools: {},
      cache: { providerId: 'openrouter', modelId, sessionKey: 'proteus-or' },
    })).rejects.toThrow();
    return bodyOf(mock, 0);
  }

  test('claude behind openrouter: prompt_cache_key + cache_control on system and tail', async () => {
    const body = await runOpenRouterTurn('anthropic/claude-sonnet-4.6');
    expect(body.prompt_cache_key).toBe('proteus-or');

    const messages = field(body, 'messages', OpenAiMessagesSchema);
    const system = messages.find((m) => m.role === 'system');
    expect(system?.cache_control).toEqual({ type: 'ephemeral' });
    const nonSystem = messages.filter((m) => m.role !== 'system');
    expect(nonSystem[nonSystem.length - 1]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(nonSystem[nonSystem.length - 2]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(countCacheControl(body)).toBeLessThanOrEqual(4);
  });

  test('non-anthropic model: prompt_cache_key only, no cache_control markers', async () => {
    const body = await runOpenRouterTurn('meta-llama/llama-4-maverick');
    expect(body.prompt_cache_key).toBe('proteus-or');
    expect(countCacheControl(body)).toBe(0);
    // System stays a plain string message.
    const messages = field(body, 'messages', OpenAiMessagesSchema);
    expect(messages[0]).toEqual({ role: 'system', content: 'sys' });
  });
});

describe('openai-compat + no-op providers', () => {
  test('openai-compat endpoint gets prompt_cache_key in the body', async () => {
    const mock = createMockFetch([
      { match: 'groq.example', respond: { status: 400, body: {} } },
    ]);
    const deps = makeDeps({
      'openai-compat.default': { headers: { Authorization: 'Bearer k' }, baseURL: 'https://groq.example/v1' },
    }, mock.fetch);
    const model = createOpenAICompatProvider().createModel('llama-4', deps);
    await expect(drain({
      model, system: 'sys', history: [...HISTORY], tools: {},
      cache: { providerId: 'openai-compat', modelId: 'llama-4', sessionKey: 'proteus-compat' },
    })).rejects.toThrow();
    const body = bodyOf(mock, 0);
    expect(body.prompt_cache_key).toBe('proteus-compat');
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
    // workers-ai resolves to the `none` strategy — affinity headers, not body fields.
    await expect(drain({
      model, system: 'sys', history: [...HISTORY], tools: {},
      cache: { providerId: 'workers-ai', modelId: '@cf/moonshotai/kimi-k2.6', sessionKey: 'proteus-x' },
    })).rejects.toThrow();
    const body = bodyOf(mock, 0);
    expect(body.prompt_cache_key).toBeUndefined();
    expect(countCacheControl(body)).toBe(0);
    expect(field(body, 'messages', OpenAiMessagesSchema)[0]).toEqual({ role: 'system', content: 'sys' });
  });
});
