import { describe, test, expect } from 'bun:test';
import { streamText } from 'ai';
import * as v from 'valibot';
import {
  workersAIEffortOption, effortFor, reasoningEffortOptions,
  mergeProviderOptions, REASONING_EFFORT_FOR_STAGE, createChatModel, JsonObjectSchema, asFetchFunction, type JsonObject,
} from '../src/index';
import { REASONING_EFFORTS } from '../src/strategy/effort';
import type { ReasoningEffort } from '../src/strategy/effort';

describe('reasoning_effort plumbing', () => {
  test('REASONING_EFFORT_FOR_STAGE has all stages', () => {
    expect(REASONING_EFFORT_FOR_STAGE.chat).toBe('medium');
    expect(REASONING_EFFORT_FOR_STAGE.mcts_rollout).toBe('low');
    expect(REASONING_EFFORT_FOR_STAGE.scaffold_mutation).toBe('high');
  });

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

    const result = streamText({ model, prompt: 'probe', maxRetries: 0, ...effortFor('chat') });
    await result.text;
    expect(requests[0]?.reasoning_effort).toBe(REASONING_EFFORT_FOR_STAGE.chat);
    expect(requests[0]?.reasoningEffort).toBeUndefined();
    expect(requests[0]?.max_tokens).toBeUndefined();
    expect(requests[0]?.max_completion_tokens).toBeUndefined();
  });

  test('maps user effort to each provider family exactly', () => {
    for (const provider of ['openai', 'opencode', 'codex', 'openai-compat', 'openai-compat:groq'] as const) {
      expect(reasoningEffortOptions('medium', provider)).toEqual({
        openai: { reasoningEffort: 'medium' },
      });
    }

    expect(reasoningEffortOptions('low', 'openrouter')).toEqual({
      openrouter: { reasoningEffort: 'low' },
    });
    expect(reasoningEffortOptions('high', 'anthropic')).toEqual({
      anthropic: { effort: 'high' },
    });
  });

  test('Anthropic takes its documented effort levels and nothing outside them', () => {
    // `max` and `xhigh` exist only as the effort parameter; `none` is not an Anthropic level and sends nothing.
    expect(reasoningEffortOptions('max', 'anthropic')).toEqual({ anthropic: { effort: 'max' } });
    expect(reasoningEffortOptions('low', 'anthropic')).toEqual({ anthropic: { effort: 'low' } });
    expect(reasoningEffortOptions('none', 'anthropic')).toBeUndefined();
  });

  test('returns no options for an unsupported provider or missing effort', () => {
    expect(reasoningEffortOptions(undefined, 'openai')).toBeUndefined();
    expect(reasoningEffortOptions('high', 'unknown')).toBeUndefined();
  });

  test('merges effort into an existing provider namespace without clobbering it', () => {
    expect(mergeProviderOptions(
      { openai: { promptCacheKey: 'session-1' } },
      reasoningEffortOptions('high', 'openai'),
    )).toEqual({
      openai: { promptCacheKey: 'session-1', reasoningEffort: 'high' },
    });
  });
});

/**
 * The rung table is asserted as an ordering (cheap fan-out, medium user-visible, high self-modification),
 * named by real call sites rather than stage by stage.
 */
describe('the reasoning rung a stage gets is a policy, not a list of magnitudes', () => {
  test('a scorer never reasons less than the sampling it is ranking', () => {
    // In `cf-backend/src/runtime.ts` one runtime samples with `effortFor('mcts_rollout')` and scores the same
    // branches with `effortFor('judge')`; a judge no stronger than the sampler cannot separate them.
    const rung = (effort: ReasoningEffort) => REASONING_EFFORTS.indexOf(effort);

    expect(rung(REASONING_EFFORT_FOR_STAGE.judge))
      .toBeGreaterThan(rung(REASONING_EFFORT_FOR_STAGE.mcts_rollout));
    expect(rung(REASONING_EFFORT_FOR_STAGE.mcts_judge))
      .toBeGreaterThan(rung(REASONING_EFFORT_FOR_STAGE.mcts_rollout));

    // The self-modifying turn is the strict maximum; the ladder is walked, so a new stage is covered.
    for (const [stage, effort] of Object.entries(REASONING_EFFORT_FOR_STAGE)) {
      if (stage === 'scaffold_mutation') continue;
      expect(rung(REASONING_EFFORT_FOR_STAGE.scaffold_mutation)).toBeGreaterThan(rung(effort));
    }

  });

  test('inside one provider namespace the override beats the base it is layered over', () => {
    // The second argument is the request and wins over the plan (`chat.ts`, `actor-agent.ts` layer this way).
    // A shared and a unique key together: a wholesale override would lose the cache key.
    expect(mergeProviderOptions(
      { openai: { promptCacheKey: 'session-1', reasoningEffort: 'low' } },
      reasoningEffortOptions('high', 'openai'),
    )).toEqual({
      openai: { promptCacheKey: 'session-1', reasoningEffort: 'high' },
    });

    // The merge is per-namespace, not whole-object.
    expect(mergeProviderOptions(
      { anthropic: { cacheControl: { type: 'ephemeral' } }, openai: { reasoningEffort: 'low' } },
      reasoningEffortOptions('high', 'openai'),
    )).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
      openai: { reasoningEffort: 'high' },
    });
  });
});
