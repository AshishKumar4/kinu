/** The bounded model summarizer (H1 latent-hang fix): a hung provider call
 *  rejects at the wall-clock budget instead of wedging the awaited
 *  transformContext, and the extension degrades to deterministic previews so
 *  the turn always proceeds. */

import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModel } from 'ai';
import { createCompactionExtension, createModelSummarizer } from '../src/index.js';
import type { CompactionProfile } from '../src/index.js';
import { history, memoryArchive, memoryPorts } from './helpers.js';

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

describe('createModelSummarizer', () => {
  test('a hanging model call rejects at the timeout budget', async () => {
    const summarize = createModelSummarizer(hangingModel, 25);
    const started = Date.now();
    await expect(summarize('summarize this')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
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
