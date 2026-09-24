/**
 * CF head runtime merge: model, effort and spend label are one core decision (`judge` = `deep` tier).
 * Routes compare against `MERGE_POLICY_BINDING`, the same value the local backend's suite uses.
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
import type { ExplorationHostSeams } from '../src/exploration-hosting';

/** Calls' options are handed back so a suite can read the request this backend built. */
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

/** Fail-loud: `mergeLLM` must never reach the substrate; an answering member could acquire an actor. */
const neverHost: ExplorationHostSeams = {
  host: {
    acquire() { throw new Error('mergeLLM acquired a hosted actor'); },
    hosted() { throw new Error('mergeLLM read the hosted actor set'); },
    describe() { throw new Error('mergeLLM read the actor directory'); },
    bindStores() { throw new Error("mergeLLM bound an actor's stores"); },
    list() { throw new Error('mergeLLM listed the hosted actors'); },
    run() { throw new Error('mergeLLM ran work as a hosted actor'); },
    release() { throw new Error('mergeLLM released a hosted actor'); },
    releaseAll() { throw new Error('mergeLLM released every hosted actor'); },
    retire() { throw new Error('mergeLLM retired a hosted actor'); },
    resumable() { throw new Error('mergeLLM read the resumable claims'); },
  },
  register() { throw new Error('mergeLLM reached actor registration'); },
  watchWrites() { throw new Error("mergeLLM watched an actor's writes"); },
  profile() { throw new Error('mergeLLM resolved an exploration profile'); },
  resolveModel() { throw new Error('mergeLLM resolved a model through the seams'); },
  priceAs() { throw new Error('mergeLLM priced a hosted model through the seams'); },
  webSearch() { throw new Error('mergeLLM reached the web search provider'); },
  nodeHome() { throw new Error('mergeLLM provisioned a node home'); },
  codemodeTool() { throw new Error('mergeLLM built an eval surface'); },
  recordStep() { throw new Error('mergeLLM recorded a head step'); },
  publishDelta() { throw new Error('mergeLLM published a head stream frame'); },
  mission() { throw new Error('mergeLLM read the mission ledger'); },
  split() { throw new Error('mergeLLM reached the recursive split'); },
};

function runtimeWith(text: string) {
  const operations: ModelOperationEvent[] = [];
  const reports: ModelCallReport[] = [];
  const resolved: Array<{ spec: string | null | undefined; effort: ReasoningEffort }> = [];
  const calls: LanguageModelV3CallOptions[] = [];

  const runtime = createHeadRuntime({
    host: neverHost,
    models: {
      resolveModelWithEffort: (spec, effort) => {
        resolved.push({ spec, effort });

        return { model: mergeModel(text, calls), provider: 'mock', providerOptions: undefined };
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
    expect(operations[0].operationId).toBe(operations[1].operationId);
    expect(operations.every((e) => e.source === 'judge' && e.op === 'generate_json')).toBe(true);
    expect(operations[1].outcome).toBe('ok');
    expect(operations[1].usage).toEqual({ input: 41, output: 7 });
    expect(reports).toEqual([{
      source: 'judge', usage: { input: 41, output: 7 }, modelId: 'mock-model-id',
    }]);
  });

  test('malformed JSON still closes the operation as completed provider spend', async () => {
    const { operations, reports, runtime } = runtimeWith('not json at all');

    await expect(runtime.mergeLLM('merging the findings', MergeOutputSchema)).rejects.toThrow();

    // Billed; the parse refusal is the controller's fallback, not this frame's failure.
    expect(operations.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(operations[1].outcome).toBe('ok');
    expect(operations[1].usage).toEqual({ input: 41, output: 7 });
    expect(reports).toHaveLength(1);
  });

  test('the merge takes the judge route — the deep tier, at the tier\'s own effort', async () => {
    const { resolved, reports, runtime } = runtimeWith(GOOD_MERGE);

    await runtime.mergeLLM('merging the findings', MergeOutputSchema);

    // Compared against the binding the local backend's suite also uses.
    expect(resolved).toEqual([MERGE_POLICY_BINDING]);
    // One `'judge'` literal in core produced both route and spend label.
    expect(reports.map((r) => r.source)).toEqual([MERGE_POLICY_SPEND_SOURCE]);
  });

  test('the route is read per call, so a rebound tier lands on the next merge', async () => {
    const { resolved, runtime } = runtimeWith(GOOD_MERGE);

    await runtime.mergeLLM('first merge', MergeOutputSchema);
    await runtime.mergeLLM('second merge', MergeOutputSchema);

    // `profile()` is re-read per call, so a moved deep tier needs no new runtime.
    expect(resolved).toEqual([MERGE_POLICY_BINDING, MERGE_POLICY_BINDING]);
  });

  test('the merge request carries no output cap', async () => {
    const { calls, runtime } = runtimeWith(GOOD_MERGE);

    await runtime.mergeLLM('merging the findings', MergeOutputSchema);

    // Effort controls cost; an output cap truncates or starves a reasoning model.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.maxOutputTokens).toBeUndefined();
  });
});
