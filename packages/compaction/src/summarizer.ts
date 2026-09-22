/** Summarizer transport for `createCompactionExtension`. The caller owns cancellation. */

import { generateText, type LanguageModel } from 'ai';
import { beginModelOperation, normalizeUsage, type ModelCallSpend } from '@kinu.run/core';


/** `spend` is optional; when present the fold is recorded under `compaction`. */
export function createModelSummarizer(
  getModel: () => LanguageModel,
  spend?: ModelCallSpend,
): (prompt: string, signal?: AbortSignal) => Promise<string> {
  return async (prompt, signal) => {
    // Opened before the request so an unmatched start row names an in-flight fold after a crash.
    const operation = beginModelOperation(spend, 'complete');
    let result;

    try {
      result = await generateText({
        model: getModel(),
        prompt,
        abortSignal: signal,
      });
    } catch (err) {
      operation.failed({ cause: err });
      throw err;
    }

    const usage = normalizeUsage(result.totalUsage);
    const modelId = result.response.modelId;
    operation.completed({ usage, modelId });
    spend?.report({ source: spend.source, usage, modelId });

    return result.text;
  };
}
