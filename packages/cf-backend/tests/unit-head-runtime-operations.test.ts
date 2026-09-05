/**
 * The CF head runtime's merge synthesis: what model it runs on, and that it
 * files its operation lifecycle.
 *
 * `createHeadRuntime` hands core's `headMergeLLM` a profile thunk and a model
 * binder and nothing else, so the MODEL, the EFFORT and the SPEND LABEL are one
 * decision made in core: the merge files `judge` spend, `judge` is the
 * account-wide `deep` tier, and a tier is a (model, effort) pair.
 *
 * The route assertions compare against `MERGE_POLICY_BINDING` from
 * `@kinu.run/test-utils` — the SAME value the local backend's suite compares
 * against, over the same catalog — so "both backends resolve one policy" is an
 * equality between two suites rather than two expectations maintained apart.
 * These tests drive `mergeLLM` directly; the spawn substrate beside it is inert
 * by construction.
 */

import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';
import {
  MergeOutputSchema,
  type ModelCallReport,
  type ModelOperationEvent,
  type ReasoningEffort,
} from '@kinu.run/core';
import {
  MERGE_POLICY_BINDING, MERGE_POLICY_SPEND_SOURCE, mergePolicyProfile,
} from '@kinu.run/test-utils';
import { createHeadRuntime } from '../src/head-runtime';
import type { FacetHost } from '../src/facet-spawn';

/** A scripted merge model: valid JSON unless the test says otherwise. Every
 *  call's options are handed back so a suite can read the REQUEST this backend
 *  built, not just the answer it got. */
function mergeModel(text: string, calls?: LanguageModelV3CallOptions[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      calls?.push(options);
      return {
        content: [{ type: 'text' as const, text }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: 41, noCache: 41, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 7, text: 7, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

const GOOD_MERGE =
  '{"narrative":"Unified: both heads agree the parser is sound.","selected_decisions":[],"unresolved_questions":[],"recommendations":["ship it"]}';

/** The spawn substrate, fail-loud: mergeLLM must never reach it, so any touch
 *  is a wiring regression this suite wants named, not absorbed. */
const neverHost: FacetHost = {
  explorationFacet() { throw new Error('mergeLLM reached the spawn substrate'); },
  facetHomes() { throw new Error('mergeLLM reached the spawn substrate'); },
  subAgent() { throw new Error('mergeLLM reached the spawn substrate'); },
  abortSubAgent() { throw new Error('mergeLLM reached the spawn substrate'); },
  deleteSubAgent() { throw new Error('mergeLLM reached the spawn substrate'); },
};

function runtimeWith(text: string) {
  const operations: ModelOperationEvent[] = [];
  const reports: ModelCallReport[] = [];
  /** What the merge asked the resolver for — the route it actually took. */
  const resolved: Array<{ spec: string | null | undefined; effort: ReasoningEffort }> = [];
  /** The provider requests this backend built, options and all. */
  const calls: LanguageModelV3CallOptions[] = [];
  const runtime = createHeadRuntime({
    host: neverHost,
    identity: async () => { throw new Error('mergeLLM resolved a facet identity'); },
    models: {
      resolveModelWithEffort: (spec, effort) => {
        resolved.push({ spec, effort });
        return { model: mergeModel(text, calls), providerOptions: undefined };
      },
    },
    profile: async () => mergePolicyProfile(),
    reportModelCall: (report) => reports.push(report),
    operations: (event) => operations.push(event),
  });
  return { calls, operations, reports, resolved, runtime };
}

describe('createHeadRuntime — the merge call carries the operation sink', () => {
  test('a successful merge writes start and end rows joined by operationId', async () => {
    const { operations, reports, runtime } = runtimeWith(GOOD_MERGE);

    const merge = await runtime.mergeLLM('merging the findings', MergeOutputSchema);

    expect(merge.narrative).toContain('Unified');
    expect(operations.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(operations[0]!.operationId).toBe(operations[1]!.operationId);
    expect(operations.every((e) => e.source === 'judge' && e.op === 'generate_json')).toBe(true);
    expect(operations[1]!.outcome).toBe('ok');
    expect(operations[1]!.usage).toEqual({ input: 41, output: 7 });
    // The cost report rides the same call, unchanged.
    expect(reports).toEqual([{
      source: 'judge', usage: { input: 41, output: 7 }, modelId: 'mock-model-id',
    }]);
  });

  test('malformed JSON still closes the operation as completed provider spend', async () => {
    const { operations, reports, runtime } = runtimeWith('not json at all');

    await expect(runtime.mergeLLM('merging the findings', MergeOutputSchema)).rejects.toThrow();

    // The provider answered and was billed; the parse refusal is the
    // controller's fallback path, not this frame's failure.
    expect(operations.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(operations[1]!.outcome).toBe('ok');
    expect(operations[1]!.usage).toEqual({ input: 41, output: 7 });
    expect(reports).toHaveLength(1);
  });

  test('the merge takes the judge route — the deep tier, at the tier\'s own effort', async () => {
    const { resolved, reports, runtime } = runtimeWith(GOOD_MERGE);

    await runtime.mergeLLM('merging the findings', MergeOutputSchema);

    // The DEEP model at the DEEP tier's effort, not the turn's chat model at a
    // constant. Compared against the shared binding rather than against local
    // literals: the local backend's suite compares against this same value, so
    // one of them drifting from the policy is a failure here.
    expect(resolved).toEqual([MERGE_POLICY_BINDING]);
    // And the spend label agrees with the route it resolved, because one
    // `'judge'` literal in core produced both.
    expect(reports.map((r) => r.source)).toEqual([MERGE_POLICY_SPEND_SOURCE]);
  });

  test('the route is read per call, so a rebound tier lands on the next merge', async () => {
    const { resolved, runtime } = runtimeWith(GOOD_MERGE);

    await runtime.mergeLLM('first merge', MergeOutputSchema);
    await runtime.mergeLLM('second merge', MergeOutputSchema);

    // A thunk, not a captured value: `profile()` is asked again each time, so an
    // account that moves its deep tier does not need a new runtime to take effect.
    expect(resolved).toEqual([MERGE_POLICY_BINDING, MERGE_POLICY_BINDING]);
  });

  test('the merge request carries no output cap', async () => {
    const { calls, runtime } = runtimeWith(GOOD_MERGE);

    await runtime.mergeLLM('merging the findings', MergeOutputSchema);

    // The routed effort is how this call's cost is controlled. An output cap is
    // not a field any request this backend builds sets: completion length is
    // the model's, bounded by the provider, and a cap truncates a reasoning
    // model's answer or starves it before it emits one.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.maxOutputTokens).toBeUndefined();
  });
});
