// KINU-085: a turn cut at the output limit is continued, then replayed to a different provider
// family through the real adapters; an unpaired completed call would re-run the tool.
import { describe, test, expect } from 'bun:test';
import { tool, type ModelMessage, type ToolSet } from 'ai';
import * as v from 'valibot';
import { z } from 'zod';
import {
  runChat,
  createAnthropicProvider, createOpenAICompatProvider,
  isPortableToolCallId,
  ANTHROPIC_CRED_KEY,
  parseJsonObject,
  type ChatEvent, type JsonObject, type ProviderDeps, type AuthResolution,
} from '../src/index';
import { createMockFetch, type MockFetchHandle, type RecordedRequest } from '@kinu.run/test-utils';

/** Answers each call with the next script, holding the last one once they run out. */
function replayingScripts(scripts: readonly string[]) {
  return (_req: RecordedRequest, callIndex: number) => ({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: scripts[Math.min(callIndex, scripts.length - 1)] ?? '',
  });
}

/** The source provider's id for this call: Anthropic's grammar, which no other family mints. */
const ANTHROPIC_NATIVE_ID = 'toolu_01SourceMinted';

const ANTHROPIC_REASONING = 'I should look this up.';

const ANTHROPIC_REASONING_SIGNATURE = 'anthropic-source-signature';

const COMPAT_NATIVE_ID = 'call_source_minted';

const COMPAT_REASONING = 'I should use the lookup tool.';

const COMPAT_BASE = 'https://compat.example/v1';

function makeDeps(creds: Record<string, AuthResolution>, fetchFn: typeof fetch): ProviderDeps {
  const store = new Map(Object.entries(creds));

  return {
    env: {},
    fetch: fetchFn,
    async getAuth(key) { return store.get(key) ?? null; },
    async hasCredential(key) { return store.has(key); },
  };
}

/** One side effect counted across both turns: a re-issued completed call shows up here. */
function countingTools() {
  let executions = 0;

  const tools: ToolSet = {
    look: tool({
      description: 'look the answer up',
      inputSchema: z.object({ topic: z.string() }),
      execute: async (): Promise<string> => {
        executions += 1;

        return 'the answer is 41';
      },
    }),
  };

  return { tools, executions: () => executions } as const;
}

/** Every event terminated, including the last: the SSE parser drops an unterminated tail. */
function sse(events: ReadonlyArray<readonly [string, JsonObject]>): string {
  return `${events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join('\n')}\n`;
}

const ANTHROPIC_USAGE = { input_tokens: 10, output_tokens: 4 };

/** Step 1: the model reasons, then calls the tool. */
const ANTHROPIC_TOOL_USE = sse([
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-opus-4-7', stop_reason: null, usage: ANTHROPIC_USAGE } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ANTHROPIC_REASONING } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: ANTHROPIC_REASONING_SIGNATURE } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: ANTHROPIC_NATIVE_ID, name: 'look' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"topic":"life"}' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } }],
  ['message_stop', { type: 'message_stop' }],
]);

/** A text step with a chosen stop reason; `max_tokens` maps to the `length` the continuation reads. */
function anthropicText(id: string, text: string, stopReason: 'max_tokens' | 'end_turn'): string {
  return sse([
    ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [], model: 'claude-opus-4-7', stop_reason: null, usage: ANTHROPIC_USAGE } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 6 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

/** Chat-completions streaming, the openai-compatible wire. */
function compatSse(chunks: ReadonlyArray<readonly [JsonObject, string | null]>): string {
  const body = chunks.map(([delta, finish]) => `data: ${JSON.stringify({
    id: 'cmpl-1', object: 'chat.completion.chunk', created: 1, model: 'llama-4',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`).join('');

  return `${body}data: [DONE]\n\n`;
}

function compatText(text: string): string {
  return compatSse([
    [{ role: 'assistant', content: '' }, null],
    [{ content: text }, null],
    [{}, 'stop'],
  ]);
}

const COMPAT_TOOL_USE = compatSse([
  [{ role: 'assistant', reasoning_content: COMPAT_REASONING }, null],
  [{
    tool_calls: [{
      index: 0,
      id: COMPAT_NATIVE_ID,
      function: { name: 'look', arguments: '{"topic":"life"}' },
    }],
  }, null],
  [{}, 'tool_calls'],
]);

async function drain(opts: Parameters<typeof runChat>[0]): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];

  for await (const event of runChat(opts)) events.push(event);

  return events;
}

function doneOf(events: readonly ChatEvent[]) {
  const done = events.find((event) => event.type === 'done');

  if (done?.type !== 'done') throw new Error('the turn produced no done event');

  return { text: done.text, responseMessages: done.responseMessages } as const;
}

function bodyOf(handle: MockFetchHandle, index: number): JsonObject {
  const request = handle.requests[index];
  expect(request?.body).toBeDefined();

  return parseJsonObject(v.parse(v.string(), request?.body));
}

const AnthropicMessagesSchema = v.array(v.object({
  role: v.string(),
  content: v.union([v.string(), v.array(v.object({
    type: v.string(),
    text: v.optional(v.string()),
    thinking: v.optional(v.string()),
    signature: v.optional(v.string()),
    data: v.optional(v.string()),
    id: v.optional(v.string()),
    tool_use_id: v.optional(v.string()),
  }))]),
}));

const CompatMessagesSchema = v.array(v.object({
  role: v.string(),
  content: v.optional(v.nullable(v.string())),
  reasoning_content: v.optional(v.string()),
  tool_call_id: v.optional(v.string()),
  tool_calls: v.optional(v.array(v.object({ id: v.string() }))),
}));

/** Every `tool_use.id` and `tool_result.tool_use_id` in an Anthropic request, in wire order. */
function anthropicPairing(body: JsonObject) {
  const messages = v.parse(AnthropicMessagesSchema, body.messages);
  const calls: string[] = [];
  const results: string[] = [];

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;

    for (const part of message.content) {
      if (part.type === 'tool_use' && part.id !== undefined) calls.push(part.id);

      if (part.type === 'tool_result' && part.tool_use_id !== undefined) results.push(part.tool_use_id);
    }
  }

  return { calls, results } as const;
}

/**
 * `tool_calls[].id` and `tool_call_id` on the openai-compatible wire. `order` is wire order: a
 * `tool` message must follow the assistant message that opened its call.
 */
function compatPairing(body: JsonObject) {
  const messages = v.parse(CompatMessagesSchema, body.messages);
  const calls = messages.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? []);

  const results = messages.flatMap((message) =>
    message.role === 'tool' && message.tool_call_id !== undefined ? [message.tool_call_id] : []);

  const order = messages.flatMap((message) => [
    ...(message.tool_calls ?? []).map((call) => `assistant#${call.id}`),
    ...(message.role === 'tool' && message.tool_call_id !== undefined ? [`tool#${message.tool_call_id}`] : []),
  ]);

  return { calls, results, order } as const;
}

/**
 * Turn one on Anthropic: a tool call, a cut answer, then the continuation. Returns the durable
 * history and the continuation's wire.
 */
async function truncatedAnthropicTurn(tools: ToolSet): Promise<{
  mock: MockFetchHandle;
  responseMessages: ModelMessage[];
  text: string;
}> {
  const scripts = [
    ANTHROPIC_TOOL_USE,
    anthropicText('msg_2', 'the tool said', 'max_tokens'),
    anthropicText('msg_3', ' 41, and here is the rest', 'end_turn'),
  ];

  const mock = createMockFetch([{
    match: 'api.anthropic.com',
    respond: replayingScripts(scripts),
  }]);

  const deps = makeDeps({
    [ANTHROPIC_CRED_KEY]: { headers: { 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' } },
  }, mock.fetch);

  const events = await drain({
    model: createAnthropicProvider().createModel('claude-opus-4-7', deps),
    system: 'sys',
    history: [{ role: 'user', content: 'what is the answer' }],
    tools,
    cache: { providerId: 'anthropic', modelId: 'claude-opus-4-7', sessionKey: 'kinu-xprov' },
  });

  const done = doneOf(events);

  return { mock, responseMessages: done.responseMessages, text: done.text };
}

/** Turn two: the durable history from turn one, replayed to the other family. */
async function replayOnCompat(
  history: readonly ModelMessage[],
  tools: ToolSet,
  destination: { providerId?: string },
): Promise<MockFetchHandle> {
  const mock = createMockFetch([{
    match: 'compat.example',
    respond: () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: compatText('still 41'),
    }),
  }]);

  const deps = makeDeps({
    'openai-compat.default': { headers: { Authorization: 'Bearer k' }, baseURL: COMPAT_BASE },
  }, mock.fetch);

  let options: Parameters<typeof drain>[0] = {
    model: createOpenAICompatProvider().createModel('llama-4', deps),
    system: 'sys',
    history: [...history, { role: 'user', content: 'are you sure' }],
    tools,
  };

  if (destination.providerId !== undefined) {
    options = {
      ...options,
      cache: { providerId: destination.providerId, modelId: 'llama-4', sessionKey: 'kinu-xprov' },
    };
  }

  await drain(options);

  return mock;
}

/** A compatible turn that reasons, calls the tool, then gives its answer. */
async function reasonedCompatTurn(tools: ToolSet): Promise<{
  mock: MockFetchHandle;
  responseMessages: ModelMessage[];
  text: string;
}> {
  const scripts = [COMPAT_TOOL_USE, compatText('the answer is 41')];

  const mock = createMockFetch([{
    match: 'compat.example',
    respond: replayingScripts(scripts),
  }]);

  const deps = makeDeps({
    'openai-compat.default': { headers: { Authorization: 'Bearer k' }, baseURL: COMPAT_BASE },
  }, mock.fetch);

  const done = doneOf(await drain({
    model: createOpenAICompatProvider().createModel('llama-4', deps),
    system: 'sys',
    history: [{ role: 'user', content: 'what is the answer' }],
    tools,
    cache: { providerId: 'openai-compat', modelId: 'llama-4', sessionKey: 'kinu-xprov' },
  }));

  return { mock, responseMessages: done.responseMessages, text: done.text };
}

/** Replay compatible durable history through the Anthropic request adapter. */
async function replayOnAnthropic(
  history: readonly ModelMessage[],
  tools: ToolSet,
): Promise<MockFetchHandle> {
  const mock = createMockFetch([{
    match: 'api.anthropic.com',
    respond: () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: anthropicText('msg_replay', 'still 41', 'end_turn'),
    }),
  }]);

  const deps = makeDeps({
    [ANTHROPIC_CRED_KEY]: { headers: { 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' } },
  }, mock.fetch);

  await drain({
    model: createAnthropicProvider().createModel('claude-opus-4-7', deps),
    system: 'sys',
    history: [...history, { role: 'user', content: 'are you sure' }],
    tools,
    cache: { providerId: 'anthropic', modelId: 'claude-opus-4-7', sessionKey: 'kinu-xprov' },
  });

  return mock;
}

describe('an output-limit continuation, across two provider adapters', () => {
  test('the continuation replays the completed call paired with its result, and the tool stays run once', async () => {
    const { tools, executions } = countingTools();
    const { mock, text } = await truncatedAnthropicTurn(tools);

    // Two requests inside the SDK's own loop, then exactly one continuation.
    expect(mock.requests.length).toBe(3);
    expect(text).toBe('the tool said 41, and here is the rest');
    expect(executions()).toBe(1);

    // An unpaired `tool_use` asks the Messages API to run it; the completed call must arrive paired.
    const continuationBody = bodyOf(mock, 2);
    const pairing = anthropicPairing(continuationBody);
    expect(pairing.calls.length).toBe(1);
    expect(pairing.results).toEqual(pairing.calls);
    const messages = v.parse(AnthropicMessagesSchema, continuationBody.messages);
    expect(messages.some((message) =>
      Array.isArray(message.content)
      && message.content.some((part) =>
        part.type === 'thinking'
        && part.thinking === ANTHROPIC_REASONING
        && part.signature === ANTHROPIC_REASONING_SIGNATURE))).toBe(true);
  });

  test('replayed to the other family, the pairing survives and nothing runs a second time', async () => {
    const { tools, executions } = countingTools();
    const first = await truncatedAnthropicTurn(tools);
    expect(executions()).toBe(1);

    const mock = await replayOnCompat(first.responseMessages, tools, { providerId: 'openai-compat' });

    expect(mock.requests.length).toBe(1);
    const pairing = compatPairing(bodyOf(mock, 0));
    expect(pairing.calls.length).toBe(1);
    expect(pairing.results).toEqual(pairing.calls);
    expect(pairing.order).toEqual([`assistant#${pairing.calls[0]}`, `tool#${pairing.calls[0]}`]);

    for (const id of pairing.calls) expect(isPortableToolCallId(id)).toBe(true);
    expect(executions()).toBe(1);
  });

  test('converts signed Anthropic reasoning to portable text before an OpenAI-compatible replay', async () => {
    const { tools, executions } = countingTools();
    const first = await truncatedAnthropicTurn(tools);
    expect(JSON.stringify(first.responseMessages)).toContain(ANTHROPIC_REASONING_SIGNATURE);

    const mock = await replayOnCompat(first.responseMessages, tools, { providerId: 'openai-compat' });
    const body = bodyOf(mock, 0);
    const messages = v.parse(CompatMessagesSchema, body.messages);
    const assistant = messages.find((message) => (message.tool_calls?.length ?? 0) > 0);

    expect(assistant?.content).toContain(ANTHROPIC_REASONING);
    expect(assistant?.reasoning_content).toBeUndefined();
    expect(JSON.stringify(body)).toContain('the tool said');
    expect(JSON.stringify(body)).toContain('41, and here is the rest');
    expect(JSON.stringify(body)).not.toContain(ANTHROPIC_REASONING_SIGNATURE);
    expect(executions()).toBe(1);
  });

  test('the destination is handed ids of its own, not the source provider\'s', async () => {
    const { tools } = countingTools();
    const first = await truncatedAnthropicTurn(tools);

    // The durable history is faithful to the provider that produced it.
    expect(JSON.stringify(first.responseMessages)).toContain(ANTHROPIC_NATIVE_ID);

    const mock = await replayOnCompat(first.responseMessages, tools, { providerId: 'openai-compat' });
    const body = bodyOf(mock, 0);
    // The request is not.
    expect(JSON.stringify(body)).not.toContain(ANTHROPIC_NATIVE_ID);
    expect(compatPairing(body).calls.length).toBe(1);
  });

  test('a replayed request is byte-stable, so a reconnect resends the same bytes', async () => {
    const { tools } = countingTools();
    const first = await truncatedAnthropicTurn(tools);

    const once = await replayOnCompat(first.responseMessages, tools, { providerId: 'openai-compat' });
    const twice = await replayOnCompat(first.responseMessages, tools, { providerId: 'openai-compat' });

    expect(bodyOf(twice, 0)).toEqual(bodyOf(once, 0));
  });

  test('NEGATIVE CONTROL: with no destination resolved, the source provider\'s ids ride the wire', async () => {
    const { tools } = countingTools();
    const first = await truncatedAnthropicTurn(tools);

    // Control: without a destination the ids stay Anthropic-native, so the assertions above measure
    // the normalization.
    const mock = await replayOnCompat(first.responseMessages, tools, {});
    const pairing = compatPairing(bodyOf(mock, 0));
    expect(pairing.calls).toEqual([ANTHROPIC_NATIVE_ID]);
    expect(pairing.results).toEqual([ANTHROPIC_NATIVE_ID]);
  });
});

describe('reasoning replay from an OpenAI-compatible model to Anthropic', () => {
  test('converts unsigned reasoning to portable text and keeps the completed tool paired', async () => {
    const { tools, executions } = countingTools();
    const first = await reasonedCompatTurn(tools);
    expect(first.text).toBe('the answer is 41');
    expect(JSON.stringify(first.responseMessages)).toContain(COMPAT_REASONING);
    const sourceBody = bodyOf(first.mock, 1);
    const sourceMessages = v.parse(CompatMessagesSchema, sourceBody.messages);
    expect(sourceMessages.some((message) =>
      message.reasoning_content === COMPAT_REASONING)).toBe(true);
    expect(executions()).toBe(1);

    const mock = await replayOnAnthropic(first.responseMessages, tools);
    expect(mock.requests).toHaveLength(1);
    const body = bodyOf(mock, 0);
    const messages = v.parse(AnthropicMessagesSchema, body.messages);

    const assistant = messages.find((message) =>
      Array.isArray(message.content)
      && message.content.some((part) => part.type === 'tool_use'));

    const content = assistant && Array.isArray(assistant.content) ? assistant.content : [];

    expect(content.some((part) => part.type === 'text' && part.text === COMPAT_REASONING)).toBe(true);
    expect(content.some((part) => part.type === 'thinking' || part.type === 'redacted_thinking')).toBe(false);
    expect(JSON.stringify(body)).toContain('the answer is 41');
    const pairing = anthropicPairing(body);
    expect(pairing.calls).toHaveLength(1);
    expect(pairing.results).toEqual(pairing.calls);

    for (const id of pairing.calls) expect(isPortableToolCallId(id)).toBe(true);
    expect(executions()).toBe(1);
  });
});
