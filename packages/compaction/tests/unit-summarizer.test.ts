/** The bounded model summarizer (H1 latent-hang fix): a hung provider call
 *  rejects at the wall-clock budget instead of wedging the awaited
 *  transformContext, and the extension degrades to deterministic previews so
 *  the turn always proceeds. */

import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModel } from 'ai';
import type { ModelCallReport } from '@kinu/core';
import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider';
import { createCompactionExtension, createModelSummarizer } from '../src/index';
import type { CompactionProfile } from '../src/index';
import { history, memoryArchive, memoryPorts } from './helpers';

/** A model whose generate call NEVER resolves on its own — it settles only
 *  when the request's abortSignal fires (exactly how a hung provider fetch
 *  behaves under AbortSignal.timeout). */
function hangingModel(): LanguageModel {
  return new MockLanguageModelV3({
    doGenerate: (options) =>
      new Promise((_, reject) => {
        const signal = options.abortSignal;
        if (signal?.aborted) { reject(signal.reason); return; }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  });
}

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

describe('createModelSummarizer', () => {
  test('a hanging model call rejects at the timeout budget', async () => {
    const summarize = createModelSummarizer(hangingModel, 25);
    const started = Date.now();
    await expect(summarize('summarize this')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('a completed fold reports one model_call under the `compaction` producer', async () => {
    // `compaction` was a declared SPEND_SOURCE that could never appear in the
    // Spend panel, because both backends built the summarizer without this sink.
    // The producer fires precisely when a conversation got expensive, so the
    // workspace total understated exactly the sessions an owner asks about.
    const reports: ModelCallReport[] = [];
    const summarize = createModelSummarizer(
      () => new MockLanguageModelV3({ doGenerate: async () => FOLDED }),
      undefined,
      { source: 'compaction', report: (report) => { reports.push(report); } },
    );

    expect(await summarize('fold this')).toBe('folded');
    expect(reports).toHaveLength(1);
    expect(reports[0]?.source).toBe('compaction');
    expect(reports[0]?.modelId).toBe('mock-model-id');
    expect(reports[0]?.usage).toMatchObject({ input: 4_000, output: 120 });
  });

  test('a fold that never completed reports nothing — an aborted call cost nothing', async () => {
    const reports: ModelCallReport[] = [];
    const summarize = createModelSummarizer(hangingModel, 25, {
      source: 'compaction', report: (report) => { reports.push(report); },
    });
    await expect(summarize('fold this')).rejects.toThrow();
    expect(reports).toEqual([]);
  });

  test('a hanging summarizer never blocks transformContext — the turn proceeds on deterministic previews', async () => {
    const profile: CompactionProfile = {
      preset: 'custom',
      triggerPercent: 85,
      targetPercent: 30,
      recentToolTokens: 2_000,
      summarizerConcurrency: 2,
    };
    const extension = createCompactionExtension({
      ports: memoryPorts(),
      archive: memoryArchive(),
      summarize: createModelSummarizer(hangingModel, 25),
      ephemeral: { dropSuperseded: () => 0 },
      profile,
    });
    if (!extension.transformContext) throw new Error('extension must implement transformContext');

    // 'force' guarantees a rebuild whose summary jobs all hit the hung model.
    const transformed = await extension.transformContext({
      sessionKey: 'hang-test',
      messages: history(12, 3_000),
      system: 'system prompt',
      contextWindow: 10_000,
      trigger: 'force',
    });
    // The plan applied without a single LLM summary — pruned history returned,
    // not a hang and not a throw.
    expect(transformed).toBeDefined();
    expect(transformed!.length).toBeGreaterThan(0);
  }, 10_000);
});
