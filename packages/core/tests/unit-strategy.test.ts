import { describe, test, expect } from 'bun:test';
import { streamText } from 'ai';
import * as v from 'valibot';
import {
  mergeProviderOptions, createChatModel, runChat, JsonObjectSchema, asFetchFunction, type ChatEvent, type JsonObject,
} from '../src/index';

/** Anthropic's Messages stream of one thinking block and one answer: a Claude 5 model always thinks, and its thinking text
 *  is omitted unless the request asks `display: "summarized"` (platform.claude.com, "thinking" and its supported-models
 *  table, read 2026-11-10). */
function claudeThinkingAnswer(body: JsonObject, thought: string): Response {
  const thinking = v.safeParse(v.looseObject({ display: v.string() }), body.thinking);
  const shown = thinking.success && thinking.output.display === 'summarized' ? thought : '';

  const events = [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    ...(shown === '' ? [] : [{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: shown } }]),
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Both files agree.' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];

  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

describe('a call at a reasoning effort', () => {
  test('configured Workers AI effort reaches the streaming HTTP request without an output cap', async () => {
    const requests: JsonObject[] = [];

    const model = createChatModel({
      kind: 'openai-compat', name: 'workers-ai', modelId: '@cf/zai-org/glm-5.3',
      baseURL: 'https://fixture.invalid/v1', headers: {},
      fetch: asFetchFunction(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(v.parse(JsonObjectSchema, await new Request(input, init).json()));

        return new Response(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: '@cf/zai-org/glm-5.3',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      }),
    });

    const result = streamText({ model, prompt: 'probe', maxRetries: 0, reasoning: 'medium' });
    await result.text;
    expect(requests[0]?.reasoning_effort).toBe('medium');
    expect(requests[0]?.reasoningEffort).toBeUndefined();
    expect(requests[0]?.max_tokens).toBeUndefined();
    expect(requests[0]?.max_completion_tokens).toBeUndefined();
  });

  // Owner report 2026-11-10: no thinking streamed for Opus. From 2026-09-10 a Claude call sent only `effort`, and a
  // Claude 5 model, which always thinks, returned its thinking blocks with the text omitted.
  test("a turn at an effort streams a Claude model's thinking as text", async () => {
    const thought = 'The second file restates the first.';

    const model = createChatModel({
      kind: 'anthropic', modelId: 'claude-opus-5-5', baseURL: 'https://fixture.invalid/v1', headers: { 'x-api-key': 'test' },
      fetch: asFetchFunction(async (input: RequestInfo | URL, init?: RequestInit) => claudeThinkingAnswer(v.parse(JsonObjectSchema, await new Request(input, init).json()), thought)),
    });

    const events: ChatEvent[] = [];

    for await (const event of runChat({
      modelSpec: 'anthropic/claude-opus-5-5', model, system: 'You compare files.', history: [{ role: 'user', content: 'Do the two files agree?' }],
      tools: {}, cache: { providerId: 'anthropic', modelId: 'claude-opus-5-5' }, reasoning: 'medium',
    })) events.push(event);

    expect(events.flatMap((event) => (event.type === 'reasoning-delta' ? [event.delta] : [])).join('')).toBe(thought);
  });
});

describe('provider options layer per namespace', () => {
  test('inside one provider namespace the override beats the base it is layered over', () => {
    // The second argument is the request and wins over the plan (`chat.ts`, `orchestrator.ts` layer this way).
    // A shared and a unique key together: a wholesale override would lose the cache key.
    expect(mergeProviderOptions(
      { openai: { promptCacheKey: 'session-1', reasoningEffort: 'low' } },
      { openai: { reasoningEffort: 'high' } },
    )).toEqual({
      openai: { promptCacheKey: 'session-1', reasoningEffort: 'high' },
    });

    // The merge is per-namespace, not whole-object.
    expect(mergeProviderOptions(
      { anthropic: { cacheControl: { type: 'ephemeral' } }, openai: { reasoningEffort: 'low' } },
      { openai: { reasoningEffort: 'high' } },
    )).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
      openai: { reasoningEffort: 'high' },
    });
  });
});
