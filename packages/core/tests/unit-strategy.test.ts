import { describe, test, expect } from 'bun:test';
import { streamText } from 'ai';
import * as v from 'valibot';
import {
  workersAIEffortOption, reasoningEffortOptions,
  mergeProviderOptions, createChatModel, JsonObjectSchema, asFetchFunction, type JsonObject,
} from '../src/index';

describe('reasoning_effort plumbing', () => {
  test('workersAIEffortOption returns empty when no effort', () => {
    expect(workersAIEffortOption()).toEqual({});
    expect(workersAIEffortOption(undefined)).toEqual({});
  });

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

    const result = streamText({ model, prompt: 'probe', maxRetries: 0, providerOptions: reasoningEffortOptions('medium', 'workers-ai/@cf/zai-org/glm-5.3') });
    await result.text;
    expect(requests[0]?.reasoning_effort).toBe('medium');
    expect(requests[0]?.reasoningEffort).toBeUndefined();
    expect(requests[0]?.max_tokens).toBeUndefined();
    expect(requests[0]?.max_completion_tokens).toBeUndefined();
  });

  test('maps user effort to each provider family exactly', () => {
    for (const spec of ['openai/gpt-6.1', 'codex/gpt-6.1', 'openai-compat/local-model', 'openai-compat:groq/llama'] as const) {
      expect(reasoningEffortOptions('medium', spec)).toEqual({
        openai: { reasoningEffort: 'medium' },
      });
    }

    expect(reasoningEffortOptions('low', 'openrouter/openai/gpt-6.1')).toEqual({
      openrouter: { reasoningEffort: 'low' },
    });
    expect(reasoningEffortOptions('high', 'anthropic/claude-opus-4-7')).toEqual({
      anthropic: { effort: 'high' },
    });
  });

  // The SufficientKoala audit: a gateway route sent no effort though its serving adapter is the author's own.
  test("a gateway's Claude or GPT route sends effort as the author's own API takes it; its chat route sends none", () => {
    expect(['my-gateway/anthropic/claude-opus-4.7', 'my-gateway/openai/gpt-6.1', 'my-gateway/workers-ai/@cf/zai-org/glm-5.3']
      .map((spec) => reasoningEffortOptions('high', spec) ?? null))
      .toEqual([{ anthropic: { effort: 'high' } }, { openai: { reasoningEffort: 'high' } }, null]);
  });

  test('Anthropic takes its documented effort levels and nothing outside them', () => {
    // `max` and `xhigh` exist only as the effort parameter; `none` is not an Anthropic level and sends nothing.
    expect(reasoningEffortOptions('max', 'anthropic/claude-opus-4-7')).toEqual({ anthropic: { effort: 'max' } });
    expect(reasoningEffortOptions('low', 'anthropic/claude-opus-4-7')).toEqual({ anthropic: { effort: 'low' } });
    expect(reasoningEffortOptions('none', 'anthropic/claude-opus-4-7')).toBeUndefined();
  });

  test('returns no options for an unsupported provider or missing effort', () => {
    expect(reasoningEffortOptions(undefined, 'openai/gpt-6.1')).toBeUndefined();
    expect(reasoningEffortOptions('high', 'unknown/model')).toBeUndefined();
  });

  test('merges effort into an existing provider namespace without clobbering it', () => {
    expect(mergeProviderOptions(
      { openai: { promptCacheKey: 'session-1' } },
      reasoningEffortOptions('high', 'openai/gpt-6.1'),
    )).toEqual({
      openai: { promptCacheKey: 'session-1', reasoningEffort: 'high' },
    });
  });
});

describe('provider options layer per namespace', () => {
  test('inside one provider namespace the override beats the base it is layered over', () => {
    // The second argument is the request and wins over the plan (`chat.ts`, `actor-agent.ts` layer this way).
    // A shared and a unique key together: a wholesale override would lose the cache key.
    expect(mergeProviderOptions(
      { openai: { promptCacheKey: 'session-1', reasoningEffort: 'low' } },
      reasoningEffortOptions('high', 'openai/gpt-6.1'),
    )).toEqual({
      openai: { promptCacheKey: 'session-1', reasoningEffort: 'high' },
    });

    // The merge is per-namespace, not whole-object.
    expect(mergeProviderOptions(
      { anthropic: { cacheControl: { type: 'ephemeral' } }, openai: { reasoningEffort: 'low' } },
      reasoningEffortOptions('high', 'openai/gpt-6.1'),
    )).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
      openai: { reasoningEffort: 'high' },
    });
  });
});
