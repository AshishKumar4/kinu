/**
 * The CF head runtime's merge synthesis: what model it runs on, and that it
 * files its operation lifecycle.
 *
 * `createHeadRuntime` passes the caller's operation sink through `spend`, so
 * core's `generateJson` opens and closes the frame around the merge call. The
 * MODEL comes from `MODEL_ROUTE_POLICY` — the merge files `judge` spend, and
 * `judge` is the account-wide `deep` tier — so the route and the spend label are
 * two readings of one decision. These tests drive `mergeLLM` directly; the spawn
 * substrate beside it is inert by construction.
 */

import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import {
  BUILTIN_PROFILE_CATALOG,
  MergeOutputSchema,
  profileCatalogDigest,
  resolveTurnProfile,
  type ModelCallReport,
  type ModelOperationEvent,
  type ReasoningEffort,
  type ResolvedTurnProfile,
} from '@kinu.run/core';
import { createHeadRuntime } from '../src/head-runtime';
import type { FacetHost } from '../src/facet-spawn';

const DEFAULT_MODEL = 'fake/chat-default';
const DEEP_MODEL = 'fake/deep-grader';

/** A catalog whose `deep` slot is a DIFFERENT model at a DIFFERENT effort from
 *  `default`, so "did the merge take the deep route" has an observable answer.
 *  A catalog where every tier agrees could not distinguish a routed merge from
 *  one that simply used whatever it was handed. */
function profileFixture(): ResolvedTurnProfile {
  const catalog = {
    ...BUILTIN_PROFILE_CATALOG,
    tiers: {
      default: { model: DEFAULT_MODEL, reasoningEffort: 'low' as const },
      deep: { model: DEEP_MODEL, reasoningEffort: 'high' as const },
    },
  };
  return resolveTurnProfile({
    envelope: {
      authority: { kind: 'account', accountId: 'acct-1' },
      version: 1,
      digest: profileCatalogDigest(catalog),
      catalog,
    },
    provider: { revision: 'rev-1', availableModels: [DEFAULT_MODEL, DEEP_MODEL] },
    roleId: 'general',
    workMode: 'build',
    availableTools: [],
    activeSkills: [],
  });
}

/** A scripted merge model: valid JSON unless the test says otherwise. */
function mergeModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: {
        inputTokens: { total: 41, noCache: 41, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 7, text: 7, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

const GOOD_MERGE =
  '{"narrative":"Unified: both heads agree the parser is sound.","selected_decisions":[],"unresolved_questions":[],"recommendations":["ship it"]}';

/** The spawn substrate, fail-loud: mergeLLM must never reach it, so any touch
 *  is a wiring regression this suite wants named, not absorbed. */
const neverHost: FacetHost = {
  explorationFacet() { throw new Error('mergeLLM reached the spawn substrate'); },
  subAgent() { throw new Error('mergeLLM reached the spawn substrate'); },
  abortSubAgent() { throw new Error('mergeLLM reached the spawn substrate'); },
  deleteSubAgent() { throw new Error('mergeLLM reached the spawn substrate'); },
};

function runtimeWith(text: string) {
  const operations: ModelOperationEvent[] = [];
  const reports: ModelCallReport[] = [];
  /** What the merge asked the resolver for — the route it actually took. */
  const resolved: Array<{ spec: string | null | undefined; effort: ReasoningEffort }> = [];
  const runtime = createHeadRuntime({
    host: neverHost,
    identity: async () => { throw new Error('mergeLLM resolved a facet identity'); },
    models: {
      resolveModelWithEffort: (spec, effort) => {
        resolved.push({ spec, effort });
        return { model: mergeModel(text), providerOptions: undefined };
      },
    },
    profile: async () => profileFixture(),
    reportModelCall: (report) => reports.push(report),
    operations: (event) => operations.push(event),
  });
  return { operations, reports, resolved, runtime };
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

    // The DEEP model, not the turn's chat model. The old wiring passed the
    // caller's stored spec, so a synthesis reported as deep-tier grading ran on
    // whatever the conversation was set to.
    expect(resolved).toEqual([{ spec: DEEP_MODEL, effort: 'high' }]);
    // And the spend label agrees with the route it resolved, because one
    // `'judge'` literal produced both.
    expect(reports.map((r) => r.source)).toEqual(['judge']);
  });

  test('the route is read per call, so a rebound tier lands on the next merge', async () => {
    const { resolved, runtime } = runtimeWith(GOOD_MERGE);

    await runtime.mergeLLM('first merge', MergeOutputSchema);
    await runtime.mergeLLM('second merge', MergeOutputSchema);

    // A thunk, not a captured value: `profile()` is asked again each time, so an
    // account that moves its deep tier does not need a new runtime to take effect.
    expect(resolved).toHaveLength(2);
    expect(resolved.every((r) => r.spec === DEEP_MODEL && r.effort === 'high')).toBe(true);
  });
});
