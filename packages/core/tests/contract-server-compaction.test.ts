// Anthropic's server-side compaction through the real adapter (platform.claude.com/docs/en/build-with-claude/
// compaction-threshold): asked for on a Claude model that supports it, at Kinu's compaction trigger. The summary is
// for the model, not the owner: it stays out of the answer and the stream, and opens the replayed conversation.
import { describe, expect, test } from 'bun:test';
import { tool, type ModelMessage, type UIMessageChunk } from 'ai';
import { z } from 'zod';
import * as v from 'valibot';
import {
  runChat, createAnthropicProvider, createOpenAIProvider, createFallbackCooldowns, decodeModelMessageValues, drawnStep, encodeModelMessageValues, TurnAccumulator,
  ANTHROPIC_CRED_KEY, OPENAI_CRED_KEY, parseJsonObject,
  type ChatEvent, type ChatOptions, type JsonObject, type ModelCallDeps,
} from '../src/index';
import { createMockFetch, type MockFetchHandle } from '@kinu.run/test-utils';

const SUMMARY = 'Summary of the conversation: the owner is renaming the parser module.';

/** Every event terminated: the SSE parser drops an unterminated tail. */
function sse(events: ReadonlyArray<readonly [string, JsonObject]>): string {
  return `${events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join('\n')}\n`;
}

/** A response that compacted first: the summary block, then the reply. */
const COMPACTED = sse([
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-opus-4-7', stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'compaction', content: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'compaction_delta', content: SUMMARY } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Continuing the rename.' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  // Billed for both samplings; the top level and the last iteration are the answer's alone.
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: {
    input_tokens: 23_000, output_tokens: 6, cache_read_input_tokens: 2_000,
    iterations: [{ type: 'compaction', input_tokens: 180_000, output_tokens: 3_500 }, { type: 'message', input_tokens: 23_000, output_tokens: 6 }],
  } }],
  ['message_stop', { type: 'message_stop' }],
]);

function deps(fetchFn: typeof fetch): ModelCallDeps {
  return {
    env: {}, sessionAffinity: 'kinu-test', fetch: fetchFn,
    getAuth: async () => ({ headers: { 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' } }),
    hasCredential: async (key) => key === ANTHROPIC_CRED_KEY,
  };
}

interface Turn {
  readonly mock: MockFetchHandle;
  readonly events: ChatEvent[];
  readonly shown: UIMessageChunk[];
}

async function turn(modelId: string, history: ModelMessage[], extra: Partial<ChatOptions> = {}): Promise<Turn> {
  const mock = createMockFetch([{ match: 'api.anthropic.com', respond: () => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: COMPACTED }) }]);
  const events: ChatEvent[] = [];
  const shown: UIMessageChunk[] = [];

  for await (const event of runChat({
    model: createAnthropicProvider().createModel(modelId, deps(mock.fetch)),
    modelSpec: `anthropic/${modelId}`,
    modelContext: { id: `anthropic/${modelId}`, contextWindow: 200_000 },
    system: 'You are Kinu.',
    history,
    tools: {},
    cache: { providerId: 'anthropic', modelId, sessionKey: 'kinu-test' },
    observeStream: async (stream) => {
      for await (const chunk of stream) shown.push(chunk);
    },
    ...extra,
  })) events.push(event);

  return { mock, events, shown };
}

function body(mock: MockFetchHandle): JsonObject {
  return parseJsonObject(v.parse(v.string(), mock.requests[0]?.body));
}

const ResponseMessagesSchema = v.object({ type: v.literal('done'), text: v.string(), responseMessages: v.array(v.custom<ModelMessage>(() => true)) });

describe('Anthropic server-side compaction', () => {
  test('a Claude model that compacts server-side is asked to at Kinu\'s trigger; one that does not is not', async () => {
    const opus = await turn('claude-opus-4-7', [{ role: 'user', content: 'rename the parser' }]);
    const haiku = await turn('claude-haiku-4-5', [{ role: 'user', content: 'rename the parser' }]);

    expect(body(opus.mock).context_management).toEqual({ edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: 170_000 } }] });
    expect(opus.mock.requests[0]?.headers['anthropic-beta']).toContain('compact-2026-01-12');
    expect(body(haiku.mock).context_management).toBeUndefined();
  });

  // `/compact` and an overflow's recovery arm the next request: it triggers just under its own input, so it compacts.
  test('an armed compaction asks for one just under the request\'s input, never under the API\'s floor', async () => {
    const trigger = async (counted: number) => body((await turn('claude-opus-4-7', [{ role: 'user', content: 'rename the parser' }], {
      transformTrigger: 'force', countInputTokens: async () => ({ kind: 'counted' as const, tokens: counted }),
    })).mock).context_management;

    expect([await trigger(120_000), await trigger(52_000)]).toEqual([
      { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: 108_000 } }] },
      { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: 50_000 } }] },
    ]);
  });

  // The provider reports every sampling's input together; the next turn's pressure is the prompt it answered from.
  test('the request after a compaction is measured from the summary on, and billed for both samplings', async () => {
    const acc = new TurnAccumulator();

    await turn('claude-opus-4-7', [{ role: 'user', content: 'rename the parser' }], { persistStep: async (record) => { acc.writeNative(record)(); } });

    expect({ pressure: acc.lastPromptTokens, billed: acc.usage.input }).toEqual({ pressure: 25_000, billed: 205_000 });
  });

  test('the summary stays out of the answer and the stream, and the next request opens on it', async () => {
    const first = await turn('claude-opus-4-7', [{ role: 'user', content: 'rename the parser' }]);
    const done = v.parse(ResponseMessagesSchema, first.events.find((event) => event.type === 'done'));
    const streamed = first.events.flatMap((event) => (event.type === 'text-delta' ? [event.delta] : [])).join('');

    const drawn = JSON.stringify(drawnStep(encodeModelMessageValues(done.responseMessages)));

    expect({ answer: done.text, streamed, shown: JSON.stringify(first.shown).includes(SUMMARY), drawn: drawn.includes(SUMMARY) })
      .toEqual({ answer: 'Continuing the rename.', streamed: 'Continuing the rename.', shown: false, drawn: false });

    const stored = decodeModelMessageValues(encodeModelMessageValues(done.responseMessages));
    const next = await turn('claude-opus-4-7', [{ role: 'user', content: 'rename the parser' }, ...stored, { role: 'user', content: 'and the tests' }]);
    const replayed = JSON.stringify(body(next.mock).messages);

    expect(replayed).toContain(JSON.stringify({ type: 'compaction', content: SUMMARY }).slice(0, -1));
  });

  // Anthropic numbers a response's blocks from 0, so the answer after a tool call reuses the summary's id.
  test('the answer after a compaction and a tool call streams, though it reuses the summary\'s block id', async () => {
    const compactedThenTool = sse([
      ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-opus-4-7', stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'compaction', content: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'compaction_delta', content: SUMMARY } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'look', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } }],
      ['message_stop', { type: 'message_stop' }],
    ]);

    const answered = sse([
      ['message_start', { type: 'message_start', message: { id: 'msg_2', type: 'message', role: 'assistant', content: [], model: 'claude-opus-4-7', stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'after tool' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }],
      ['message_stop', { type: 'message_stop' }],
    ]);

    const mock = createMockFetch([{ match: 'api.anthropic.com', respond: (_request, index) => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: index === 0 ? compactedThenTool : answered }) }]);
    const events: ChatEvent[] = [];
    const shown: UIMessageChunk[] = [];

    for await (const event of runChat({
      model: createAnthropicProvider().createModel('claude-opus-4-7', deps(mock.fetch)),
      modelSpec: 'anthropic/claude-opus-4-7', modelContext: { id: 'anthropic/claude-opus-4-7', contextWindow: 200_000 },
      system: 'You are Kinu.', history: [{ role: 'user', content: 'rename the parser' }],
      tools: { look: tool({ inputSchema: z.object({}), execute: async () => 'looked' }) },
      observeStream: async (stream) => {
        for await (const chunk of stream) shown.push(chunk);
      },
    })) events.push(event);

    const streamed = events.flatMap((event) => (event.type === 'text-delta' ? [event.delta] : [])).join('');
    const drawn = shown.flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.delta] : [])).join('');

    expect({ streamed, drawn }).toEqual({ streamed: 'after tool', drawn: 'after tool' });
  });

  // GrimCatfish, 2026-10-05: an armed request whose Opus attempt fails falls back to a Claude that compacts too.
  test('a fallback Claude is asked to compact as the turn asked, at its own window', async () => {
    const mock = createMockFetch([{ match: 'api.anthropic.com', respond: (request) => {
      const model = v.parse(v.object({ model: v.string() }), parseJsonObject(v.parse(v.string(), request.body))).model;

      return model === 'claude-opus-4-7'
        ? { status: 503, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }) }
        : { status: 200, headers: { 'content-type': 'text/event-stream' }, body: COMPACTED };
    } }]);

    for await (const _ of runChat({
      model: createAnthropicProvider().createModel('claude-opus-4-7', deps(mock.fetch)),
      modelSpec: 'anthropic/claude-opus-4-7', modelContext: { id: 'anthropic/claude-opus-4-7', contextWindow: 200_000 },
      fallbacks: [{ spec: 'anthropic/claude-sonnet-4-6', accepts: new Set(), window: { contextWindow: 1_000_000, modelOutputLimit: 64_000 }, bind: () => ({ model: createAnthropicProvider().createModel('claude-sonnet-4-6', deps(mock.fetch)), provider: 'anthropic' }) }],
      cooldowns: createFallbackCooldowns(),
      system: 'You are Kinu.', history: [{ role: 'user', content: 'rename the parser' }], tools: {},
      transformTrigger: 'force', countInputTokens: async () => ({ kind: 'counted' as const, tokens: 120_000 }),
    })) { /* drain */ }

    const sonnet = mock.requests.map((request) => parseJsonObject(v.parse(v.string(), request.body))).find((sent) => sent.model === 'claude-sonnet-4-6');

    expect(sonnet?.context_management).toEqual({ edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: 108_000 } }] });
  });
});

/** OpenAI's compaction item, encrypted: opaque to everyone but the API that wrote it. */
const ENCRYPTED = 'ENCRYPTED-COMPACTION-STATE';

const RESPONSE = { id: 'resp_1', object: 'response', created_at: 1_790_000_000, model: 'gpt-5.5', status: 'in_progress', output: [] };

const MESSAGE = { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Continuing the rename.', annotations: [] }] };

/** A Responses stream that compacted first: the compaction item, then the reply. */
const OPENAI_COMPACTED = [
  { type: 'response.created', response: RESPONSE },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'compaction', id: 'cmp_1', encrypted_content: ENCRYPTED } },
  { type: 'response.output_item.added', output_index: 1, item: { ...MESSAGE, status: 'in_progress', content: [] } },
  { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'Continuing the rename.' },
  { type: 'response.output_item.done', output_index: 1, item: MESSAGE },
  { type: 'response.completed', response: { ...RESPONSE, status: 'completed', usage: { input_tokens: 23_000, output_tokens: 6, total_tokens: 23_006 } } },
].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');

async function openaiTurn(modelId: string, history: ModelMessage[]): Promise<Turn> {
  const mock = createMockFetch([{ match: 'api.openai.com', respond: () => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: OPENAI_COMPACTED }) }]);
  const events: ChatEvent[] = [];
  const shown: UIMessageChunk[] = [];

  const routed: ModelCallDeps = {
    env: {}, sessionAffinity: 'kinu-test', fetch: mock.fetch,
    getAuth: async () => ({ headers: { Authorization: 'Bearer sk-test' } }),
    hasCredential: async (key) => key === OPENAI_CRED_KEY,
  };

  for await (const event of runChat({
    model: createOpenAIProvider().createModel(modelId, routed),
    modelSpec: `openai/${modelId}`,
    modelContext: { id: `openai/${modelId}`, contextWindow: 200_000 },
    system: 'You are Kinu.',
    history,
    tools: {},
    observeStream: async (stream) => {
      for await (const chunk of stream) shown.push(chunk);
    },
  })) events.push(event);

  return { mock, events, shown };
}

describe('OpenAI server-side compaction', () => {
  test('a GPT-5 model on the Responses API is asked to compact at Kinu\'s trigger; an older model is not', async () => {
    const gpt5 = await openaiTurn('gpt-5.5', [{ role: 'user', content: 'rename the parser' }]);
    const gpt41 = await openaiTurn('gpt-4.1', [{ role: 'user', content: 'rename the parser' }]);

    expect(body(gpt5.mock).context_management).toEqual([{ type: 'compaction', compact_threshold: 170_000 }]);
    expect(body(gpt41.mock).context_management).toBeUndefined();
  });

  test('the compaction item stays out of the answer and the stream, and the next request carries it', async () => {
    const first = await openaiTurn('gpt-5.5', [{ role: 'user', content: 'rename the parser' }]);
    const done = v.parse(ResponseMessagesSchema, first.events.find((event) => event.type === 'done'));
    const drawn = JSON.stringify(drawnStep(encodeModelMessageValues(done.responseMessages)));

    expect({ answer: done.text, shown: JSON.stringify(first.shown).includes(ENCRYPTED), drawn: drawn.includes(ENCRYPTED) })
      .toEqual({ answer: 'Continuing the rename.', shown: false, drawn: false });

    const stored = decodeModelMessageValues(encodeModelMessageValues(done.responseMessages));
    const next = await openaiTurn('gpt-5.5', [{ role: 'user', content: 'rename the parser' }, ...stored, { role: 'user', content: 'and the tests' }]);

    // The direct route leaves `store` on, so the API holds the item and the next request names it.
    expect(JSON.stringify(body(next.mock).input)).toContain(JSON.stringify({ type: 'item_reference', id: 'cmp_1' }));
  });
});
