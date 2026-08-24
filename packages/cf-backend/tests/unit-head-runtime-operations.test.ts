/**
 * The CF head runtime's merge synthesis files its operation lifecycle.
 *
 * `createHeadRuntime` passes the caller's operation sink through `spend`, so
 * core's `generateJson` opens and closes the frame around the merge call.
 * These tests drive `mergeLLM` directly — the spawn substrate beside it is
 * inert by construction.
 */

import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import {
  MergeOutputSchema,
  type ModelCallReport,
  type ModelOperationEvent,
} from '@kinu.run/core';
import { createHeadRuntime } from '../src/head-runtime';
import type { FacetHost } from '../src/facet-spawn';

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
  const runtime = createHeadRuntime({
    host: neverHost,
    identity: async () => { throw new Error('mergeLLM resolved a facet identity'); },
    models: {
      resolveModelWithEffort: () => ({ model: mergeModel(text), providerOptions: undefined }),
    },
    mergeModelSpec: () => 'fake/m1',
    reportModelCall: (report) => reports.push(report),
    operations: (event) => operations.push(event),
  });
  return { operations, reports, runtime };
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
});
