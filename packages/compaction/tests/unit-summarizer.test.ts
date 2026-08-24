/** The model summarizer waits for provider completion unless its caller
 * cancels the surrounding work. Elapsed time alone never fails an active fold. */

import { describe, expect, test, vi } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModel } from 'ai';
import type { ModelCallReport } from '@kinu.run/core';
import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider';
import { createModelSummarizer } from '../src/index';


/** One completed fold, typed off the provider spec so the double cannot drift
 *  from what a real provider returns. */
const FOLDED: LanguageModelV3GenerateResult = {
  content: [{ type: 'text', text: 'folded' }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 4_000, noCache: 4_000, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 120, text: 120, reasoning: undefined },
  },
  warnings: [],
};

function deferredModel() {
  const deferred = Promise.withResolvers<LanguageModelV3GenerateResult>();
  const started = Promise.withResolvers<void>();
  return {
    model: () => new MockLanguageModelV3({
      doGenerate: () => {
        started.resolve();
        return deferred.promise;
      },
    }),
    started: started.promise,
    complete: () => deferred.resolve(FOLDED),
  };
}

function failingModel(): LanguageModel {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error('provider connection failed');
    },
  });
}

describe('createModelSummarizer', () => {
  test('waits for provider completion without an elapsed deadline', async () => {
    vi.useFakeTimers();
    try {
      const deferred = deferredModel();
      let settled = false;
      const pending = createModelSummarizer(deferred.model)('summarize this')
        .then((result) => {
          settled = true;
          return result;
        });
      await deferred.started;
      vi.advanceTimersByTime(600_001);
      expect(settled).toBe(false);
      deferred.complete();
      expect(await pending).toBe('folded');
    } finally {
      vi.useRealTimers();
    }
  });

  test('a completed fold reports one model_call under the `compaction` producer', async () => {
    // `compaction` was a declared SPEND_SOURCE that could never appear in the
    // Spend panel, because both backends built the summarizer without this sink.
    // The producer fires precisely when a conversation got expensive, so the
    // workspace total understated exactly the sessions an owner asks about.
    const reports: ModelCallReport[] = [];
    const summarize = createModelSummarizer(
      () => new MockLanguageModelV3({ doGenerate: async () => FOLDED }),
      { source: 'compaction', report: (report) => { reports.push(report); } },
    );

    expect(await summarize('fold this')).toBe('folded');
    expect(reports).toHaveLength(1);
    expect(reports[0]?.source).toBe('compaction');
    expect(reports[0]?.modelId).toBe('mock-model-id');
    expect(reports[0]?.usage).toMatchObject({ input: 4_000, output: 120 });
  });

  test('a provider failure reports no model_call usage', async () => {
    const reports: ModelCallReport[] = [];
    const summarize = createModelSummarizer(failingModel, {
      source: 'compaction', report: (report) => { reports.push(report); },
    });
    await expect(summarize('fold this')).rejects.toThrow('provider connection failed');
    expect(reports).toEqual([]);
  });

});
