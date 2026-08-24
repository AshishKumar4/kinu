/**
 * The one summarizer transport both backends inject into
 * `createCompactionExtension`: a generateText call on the active model.
 *
 * The caller owns cancellation. This transport does not turn elapsed time into
 * a provider failure or discard an active fold.
 */

import { generateText, type LanguageModel } from 'ai';
import { beginModelOperation, normalizeUsage, type ModelCallSpend } from '@kinu.run/core';


/**
 * `spend` carries both the sink and the label — `compaction` for the fold this
 * summarizer exists for. It is the producer that fires precisely when a
 * conversation got expensive, so a workspace total that omitted it understated
 * exactly the sessions an owner asks about. Optional: a backend that wires no
 * sink summarizes exactly as before.
 */
export function createModelSummarizer(
  getModel: () => LanguageModel,
  spend?: ModelCallSpend,
): (prompt: string) => Promise<string> {
  return async (prompt) => {
    // Opened before the request. If the process stops, the unmatched start row
    // names the in-flight fold on the next activation.
    const operation = beginModelOperation(spend, 'complete');
    let result;
    try {
      result = await generateText({
        model: getModel(),
        prompt,
      });
    } catch (err) {
      operation.failed({ cause: err });
      throw err;
    }
    // A thrown request has no provider usage report. Its failed operation row
    // records the cause without inventing spend.
    const usage = normalizeUsage(result.totalUsage);
    const modelId = result.response.modelId;
    operation.completed({ usage, modelId });
    spend?.report({ source: spend.source, usage, modelId });
    return result.text;
  };
}
