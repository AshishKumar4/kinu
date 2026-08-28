// KINU-085. A turn cut at the provider's output limit is continued, and the
// conversation it produced is then replayed to a DIFFERENT provider family.
// Both halves cross an adapter boundary that owns the tool-call identifier, and
// the pairing between a completed call and its result is the only thing keeping
// the work done: a destination that reads the call as PENDING re-issues it, and
// the tool runs twice.
//
// `unit-output-limit-continuation.test.ts` proves the continuation itself
// against a mock LanguageModel, which converts nothing — the assertion there is
// about `runChat`. This file is about the ADAPTERS: both turns run through the
// real registered providers with a mocked fetch, so what is asserted is the
// bytes @ai-sdk/anthropic and @ai-sdk/openai-compatible actually put on the
// wire. Nothing here reads our source.
//
// The switch is the production one: a turn resolves ONE model, and the model a
// conversation resolves can change between turns (the owner picks another, a
// tier routes elsewhere). `normalizeReplayForDestination` exists for exactly
// that hop, and until now it was measured only as a pure function.
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
import { createMockFetch, type MockFetchHandle } from '@kinu.run/test-utils';

/** What the SOURCE provider named this call. Anthropic's own grammar, and
 *  nothing any other family would mint — which is what makes its presence or
 *  absence on the destination wire an unambiguous reading. */
const ANTHROPIC_NATIVE_ID = 'toolu_01SourceMinted';

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

/** One side effect, counted across BOTH turns. A destination that mistakes the
 *  completed call for a pending one re-issues it, and this is where that shows
 *  up as a second execution rather than as a formatting difference. */
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

/** Every event terminated, INCLUDING the last one. An unterminated tail is
 *  discarded by the SSE parser, and the `finish` frame carrying the provider's
 *  stop reason is what goes missing with it. */
function sse(events: ReadonlyArray<readonly [string, JsonObject]>): string {
  return `${events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join('\n')}\n`;
}

const ANTHROPIC_USAGE = { input_tokens: 10, output_tokens: 4 };

/** Step 1: the model calls the tool. */
const ANTHROPIC_TOOL_USE = sse([
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-opus-4-7', stop_reason: null, usage: ANTHROPIC_USAGE } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: ANTHROPIC_NATIVE_ID, name: 'look' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"topic":"life"}' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } }],
  ['message_stop', { type: 'message_stop' }],
]);

/** A text step with a chosen stop reason. `max_tokens` is the provider saying
 *  it cut the answer; the adapter maps it to the `length` the continuation
 *  reads. */
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
function compatText(text: string): string {
  const chunk = (delta: JsonObject, finish: string | null): string =>
    `data: ${JSON.stringify({
      id: 'cmpl-1', object: 'chat.completion.chunk', created: 1, model: 'llama-4',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return `${chunk({ role: 'assistant', content: '' }, null)}${chunk({ content: text }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`;
}

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

// ── What each wire calls the pairing key ──────────────────────────────────

const AnthropicMessagesSchema = v.array(v.object({
  role: v.string(),
  content: v.union([v.string(), v.array(v.object({
    type: v.string(),
    id: v.optional(v.string()),
    tool_use_id: v.optional(v.string()),
  }))]),
}));

const CompatMessagesSchema = v.array(v.object({
  role: v.string(),
  tool_call_id: v.optional(v.string()),
  tool_calls: v.optional(v.array(v.object({ id: v.string() }))),
}));

/** Every `tool_use.id` and every `tool_result.tool_use_id` in an Anthropic
 *  request, in wire order. */
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
 * The same two halves on the openai-compatible wire: `tool_calls[].id` on the
 * assistant message, `tool_call_id` on the tool message.
 *
 * `order` is every id-bearing message in WIRE ORDER, because the endpoint's
 * requirement is positional as well as referential — a `tool` message that does
 * not follow the assistant message that opened its call is rejected, and a
 * rewrite that renumbered the two halves independently would still pair.
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
 * Turn one, on Anthropic: a tool call, then an answer the provider cuts at its
 * output limit, then the continuation `runChat` owes.
 *
 * Returns what a caller persists — the durable history — plus the wire the
 * continuation went out on.
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
    respond: (_req, callIndex) => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: scripts[Math.min(callIndex, scripts.length - 1)] ?? '',
    }),
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

describe('an output-limit continuation, across two provider adapters', () => {
  test('the continuation replays the completed call paired with its result, and the tool stays run once', async () => {
    const { tools, executions } = countingTools();
    const { mock, text } = await truncatedAnthropicTurn(tools);

    // Two requests inside the SDK's own loop, then exactly one continuation.
    expect(mock.requests.length).toBe(3);
    expect(text).toBe('the tool said 41, and here is the rest');
    expect(executions()).toBe(1);

    // On the CONTINUATION's wire, the completed call arrives with its result
    // against the same key. That pairing is what tells the Messages API the
    // call is finished; an unpaired `tool_use` is a request to run it.
    const pairing = anthropicPairing(bodyOf(mock, 2));
    expect(pairing.calls.length).toBe(1);
    expect(pairing.results).toEqual(pairing.calls);
  });

  test('replayed to the other family, the pairing survives and nothing runs a second time', async () => {
    const { tools, executions } = countingTools();
    const first = await truncatedAnthropicTurn(tools);
    expect(executions()).toBe(1);

    const mock = await replayOnCompat(first.responseMessages, tools, { providerId: 'openai-compat' });

    expect(mock.requests.length).toBe(1);
    const pairing = compatPairing(bodyOf(mock, 0));
    // The completed call is still one call joined to one result — on a wire
    // that spells both halves differently from the one that minted them, and
    // in the position that wire requires.
    expect(pairing.calls.length).toBe(1);
    expect(pairing.results).toEqual(pairing.calls);
    expect(pairing.order).toEqual([`assistant#${pairing.calls[0]}`, `tool#${pairing.calls[0]}`]);
    for (const id of pairing.calls) expect(isPortableToolCallId(id)).toBe(true);
    // Nothing executed during the transformation: the replay is a request
    // rewrite, and the work the first turn did stays done.
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

    // The same replay with nothing naming the destination. The ids are the
    // Anthropic-native ones, which is what the assertions above would read if
    // the normalization were removed — so they are not measuring a property
    // the transport would have had anyway.
    const mock = await replayOnCompat(first.responseMessages, tools, {});
    const pairing = compatPairing(bodyOf(mock, 0));
    expect(pairing.calls).toEqual([ANTHROPIC_NATIVE_ID]);
    expect(pairing.results).toEqual([ANTHROPIC_NATIVE_ID]);
  });
});
