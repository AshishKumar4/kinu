/** Summarizer transport for `createCompactionExtension`. The caller owns cancellation. */

import type { LanguageModel } from 'ai';
import { generateReported, type ModelCallSpend } from '@kinu.run/core';

/** Each fold is filed under `spend`, which the caller labels `compaction`. */
export function createModelSummarizer(
  getModel: () => LanguageModel,
  spend: ModelCallSpend,
  spec?: () => string,
): (prompt: string, signal?: AbortSignal) => Promise<string> {
  return async (prompt, signal) => (await generateReported({
    model: getModel(),
    prompt,
    abortSignal: signal,
  }, { spend, spec: spec?.() })).text;
}
