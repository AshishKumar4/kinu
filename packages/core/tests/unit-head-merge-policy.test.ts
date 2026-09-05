/**
 * The head merge's model/effort/spend policy, proven where it now lives.
 *
 * This used to be decided twice — once per backend — and the two decided
 * differently: Cloudflare resolved the `judge` route off the turn profile and ran
 * at the deep tier's own effort, while the CLI passed the SESSION'S CHAT MODEL at
 * a hardcoded `'low'` and filed the result as `judge` spend anyway. One split,
 * one account, two models, both reported as deep-tier grading.
 *
 * So the assertions here are the policy, and each backend's suite proves only
 * that it calls this and supplies nothing else. The fixture is shared
 * (`@kinu.run/test-utils`, `mergePolicyProfile`) so all three suites route
 * against ONE catalog whose `default` and `deep` tiers disagree on both axes —
 * under a catalog where they agreed, a routed merge and a merge that used
 * whatever it was handed are indistinguishable.
 */

import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import {
  MERGE_POLICY_BINDING, MERGE_POLICY_CHAT_MODEL, MERGE_POLICY_JUDGE_MODEL,
  MERGE_POLICY_SPEND_SOURCE, mergePolicyProfile,
} from '@kinu.run/test-utils';
import { headMergeLLM } from '../src/heads/merge-policy';
import { MergeOutputSchema } from '../src/heads/merge-schema';
import type { ModelCallReport, ModelOperationEvent } from '../src/events/model-call';
import type { ResolvedTurnProfile } from '../src/profiles/resolve';

const GOOD_MERGE =
  '{"narrative":"Unified: both heads agree.","selected_decisions":[],"unresolved_questions":[],"recommendations":["ship it"]}';

/** A scripted model that also records the prompt it was handed, because the
 *  JSON-only instruction is part of what a caller inherits by riding this
 *  policy — the hand-rolled local merge did not append it. */
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
  const asked: Array<{ spec: string; effort: string; tier: string; source: string }> = [];
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
    // The turn's own model is the thing a merge must never silently run on, and
    // the fixture's tiers differ so this is a real discrimination.
    expect(asked[0]?.spec).not.toBe(MERGE_POLICY_CHAT_MODEL);
  });

  test('the spend label is the same string the route was keyed by', async () => {
    const { reports, mergeLLM } = policyWith(GOOD_MERGE, async () => mergePolicyProfile());

    await mergeLLM('merging the findings', MergeOutputSchema);

    // One literal produces both, so a merge cannot be attributed to a producer
    // whose route it did not take.
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

    // The local merge hand-rolled `generateText` + `extractJsonObject` and never
    // sent this, so the same schema was enforced against a model that had not
    // been told to answer with JSON.
    expect(prompts[0]).toContain('merging the findings');
    expect(prompts[0]?.toLowerCase()).toContain('json');
  });

  test('a reply that is not JSON still reports the spend the provider billed', async () => {
    const { reports, operations, mergeLLM } = policyWith(
      'not json at all', async () => mergePolicyProfile(),
    );

    await expect(mergeLLM('merging the findings', MergeOutputSchema)).rejects.toThrow('no JSON object in model output');

    // The call COMPLETED and was billed; rejecting its output is the
    // controller's fallback path, not this frame's failure.
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
  test('a merge whose profile cannot be resolved never reaches a model', async () => {
    const { asked, reports, operations, mergeLLM } = policyWith(GOOD_MERGE, async () => {
      throw new Error('the account profile could not be read');
    });

    await expect(mergeLLM('merging the findings', MergeOutputSchema))
      .rejects.toThrow('the account profile could not be read');
    // Nothing bound, nothing billed, no operation opened: the route comes FIRST,
    // so a merge that cannot be routed is not a merge on some other model. A
    // silent fallback here is exactly the drift this module removes.
    expect(asked).toEqual([]);
    expect(reports).toEqual([]);
    expect(operations).toEqual([]);
  });
});
