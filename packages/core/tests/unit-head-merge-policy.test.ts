/**
 * The head merge's model/effort/spend policy: the resolved `judge` route at the deep tier's effort,
 * billed as `judge`. `mergePolicyProfile` makes the `default` and `deep` tiers differ on both axes.
 */

import { describe, expect, test } from 'bun:test';
import { withModelStack } from '../src/providers/wire-model';
import { MockLanguageModelV3 } from 'ai/test';
import {
  MERGE_POLICY_BINDING, MERGE_POLICY_CHAT_MODEL, MERGE_POLICY_JUDGE_MODEL,
  MERGE_POLICY_SPEND_SOURCE, mergePolicyProfile,
} from '@kinu.run/test-utils';
import { headMergeLLM } from '../src/heads/merge-policy';
import { MergeOutputSchema } from '../src/heads/merge-schema';
import type { ModelCallReport, ModelOperationEvent } from '../src/events/model-call';
import type { ResolvedTurnProfile } from '../src/profiles/resolve';
import { createChatModel } from '../src/llm';
import { bindRoute } from '../src/profiles/model-lane';
import { parseJsonObject } from '../src/utils/json';

const GOOD_MERGE =
  '{"narrative":"Unified: both heads agree.","selected_decisions":[],"unresolved_questions":[],"recommendations":["ship it"]}';

/** Records the prompt, since the JSON-only instruction is part of the policy. */
function scriptedModel(text: string, prompts: string[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));

      return {
        content: [{ type: 'text' as const, text }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: 11, noCache: 11, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 3, text: 3, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

function policyWith(text: string, profile: () => Promise<ResolvedTurnProfile>) {
  const asked: Array<{ spec: string; effort: string | null; tier: string; source: string }> = [];
  const prompts: string[] = [];
  const reports: ModelCallReport[] = [];
  const operations: ModelOperationEvent[] = [];

  const mergeLLM = headMergeLLM({
    profile,
    bindMergeModel: (route) => {
      asked.push({
        spec: route.model,
        effort: route.reasoningEffort,
        tier: route.tier,
        source: route.source,
      });

      return { model: scriptedModel(text, prompts) };
    },
    reportModelCall: (report) => reports.push(report),
    operations: (event) => operations.push(event),
  });

  return { asked, prompts, reports, operations, mergeLLM };
}

describe('the head merge resolves one route, one effort, one spend label', () => {
  test('the binder is handed the judge route: the deep tier, at the deep tier\'s effort', async () => {
    const { asked, mergeLLM } = policyWith(GOOD_MERGE, async () => mergePolicyProfile());

    const merge = await mergeLLM('merging the findings', MergeOutputSchema);

    expect(merge.narrative).toContain('Unified');
    expect(asked).toEqual([{
      spec: MERGE_POLICY_JUDGE_MODEL,
      effort: MERGE_POLICY_BINDING.effort,
      tier: 'deep',
      source: MERGE_POLICY_SPEND_SOURCE,
    }]);
    // The turn's own model must never be used; the fixture's tiers differ.
    expect(asked[0]?.spec).not.toBe(MERGE_POLICY_CHAT_MODEL);
  });

  test('the spend label is the same string the route was keyed by', async () => {
    const { reports, mergeLLM } = policyWith(GOOD_MERGE, async () => mergePolicyProfile());

    await mergeLLM('merging the findings', MergeOutputSchema);

    // One literal for both, so attribution matches the route taken.
    expect(reports.map((r) => r.source)).toEqual([MERGE_POLICY_SPEND_SOURCE]);
    expect(reports[0]?.usage).toEqual({ input: 11, output: 3 });
  });

  test('the operation frame opens and closes around the one call', async () => {
    const { operations, mergeLLM } = policyWith(GOOD_MERGE, async () => mergePolicyProfile());

    await mergeLLM('merging the findings', MergeOutputSchema);

    expect(operations.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(operations[0]?.operationId).toBe(operations[1]?.operationId);
    expect(operations.every((e) => e.source === MERGE_POLICY_SPEND_SOURCE
      && e.op === 'generate_json')).toBe(true);
  });

  test('the JSON-only instruction rides the prompt, so no backend re-derives it', async () => {
    const { prompts, mergeLLM } = policyWith(GOOD_MERGE, async () => mergePolicyProfile());

    await mergeLLM('merging the findings', MergeOutputSchema);

    expect(prompts[0]).toContain('merging the findings');
    expect(prompts[0]?.toLowerCase()).toContain('json');
  });

  test('a reply that is not JSON still reports the spend the provider billed', async () => {
    const { reports, operations, mergeLLM } = policyWith(
      'not json at all', async () => mergePolicyProfile(),
    );

    await expect(mergeLLM('merging the findings', MergeOutputSchema)).rejects.toThrow('no JSON object in model output');

    // The call completed and was billed; rejecting output is the controller's fallback.
    expect(reports).toHaveLength(1);
    expect(operations.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(operations[1]?.outcome).toBe('ok');
  });

  test('the profile is asked per merge, so a rebound tier lands on the next one', async () => {
    let asks = 0;

    const { asked, mergeLLM } = policyWith(GOOD_MERGE, async () => {
      asks += 1;

      return mergePolicyProfile();
    });

    await mergeLLM('first merge', MergeOutputSchema);
    await mergeLLM('second merge', MergeOutputSchema);

    expect(asks).toBe(2);
    expect(asked).toEqual([asked[0], asked[0]]);
  });
});

describe('the binder is the whole of a backend\'s say', () => {
  test('a refused merge primary hands over at once and prices the serving fallback', async () => {
    const suffix = crypto.randomUUID();
    const primary = `primary-${suffix}`;
    const fallback = `fallback-${suffix}`;
    const requests: Array<{ model: unknown; effort: unknown }> = [];
    const reports: ModelCallReport[] = [];

    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(request) {
        const body = parseJsonObject(await request.text());
        requests.push({ model: body.model, effort: body.reasoning_effort });

        if (body.model === primary || requests.filter((sent) => sent.model === fallback).length === 1) {
          return new Response('limited', { status: 429, headers: { 'retry-after': '0' } });
        }

        return Response.json({
          id: 'merge', object: 'chat.completion', created: 0, model: fallback,
          choices: [{ index: 0, message: { role: 'assistant', content: GOOD_MERGE }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
        });
      },
    });

    const profile = mergePolicyProfile();

    const merge = headMergeLLM({
      profile: async () => ({ ...profile, retries: 1, tiers: { ...profile.tiers, deep: {
        model: `openai-compat/${primary}`, reasoningEffort: 'high',
        fallbacks: [{ model: `openai-compat/${fallback}`, reasoningEffort: 'low' }],
      } } }),
      bindMergeModel: (route) => bindRoute({
        normalize: (spec) => spec,
        // Named `openai`: that is the options namespace core's effort for an openai-compat spec writes.
        // As the registry resolves it: the one stack, which spends the route's retries.
        resolve: (spec) => withModelStack(createChatModel({
          kind: 'openai-compat', name: 'openai', baseURL: server.url.toString(), headers: {}, modelId: spec.slice('openai-compat/'.length),
        }), { provider: 'openai-compat', lane: spec }),
      }, route),
      reportModelCall: (report) => reports.push(report),
    });

    try {
      expect((await merge('merge the findings', MergeOutputSchema)).narrative).toContain('Unified');
      expect(requests).toEqual([
        { model: primary, effort: 'high' }, { model: fallback, effort: 'low' }, { model: fallback, effort: 'low' },
      ]);
      expect(reports).toHaveLength(1);
      expect(reports[0]?.spec).toBe(`openai-compat/${fallback}`);
      expect(reports[0]?.source).toBe('judge');
    } finally {
      await server.stop(true);
    }
  });

  test('a merge whose profile cannot be resolved never reaches a model', async () => {
    const { asked, reports, operations, mergeLLM } = policyWith(GOOD_MERGE, async () => {
      throw new Error('the account profile could not be read');
    });

    await expect(mergeLLM('merging the findings', MergeOutputSchema))
      .rejects.toThrow('the account profile could not be read');
    // Routing comes first: an unroutable merge does not fall back to another model.
    expect(asked).toEqual([]);
    expect(reports).toEqual([]);
    expect(operations).toEqual([]);
  });
});
