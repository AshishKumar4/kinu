// Anthropic's server-side compaction through the real adapter (platform.claude.com/docs/en/build-with-claude/
// compaction-threshold): asked for on a Claude model that supports it, at Kinu's compaction trigger. The summary is
// for the model, not the owner: it stays out of the answer and the stream, and opens the replayed conversation.
import { describe, expect, test } from 'bun:test';
import type { ModelMessage, UIMessageChunk } from 'ai';
import * as v from 'valibot';
import {
  runChat, createAnthropicProvider, decodeModelMessageValues, drawnStep, encodeModelMessageValues, TurnAccumulator,
  ANTHROPIC_CRED_KEY, parseJsonObject,
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
});
