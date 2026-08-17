/**
 * The one summarizer transport both backends inject into
 * `createCompactionExtension`: a generateText call on the session's active
 * model, bounded by a wall-clock budget.
 *
 * The bound is the load-bearing part — the extension's summarize calls are
 * awaited inside `transformContext`, which the turn assembly awaits, and on
 * the cloud backend that whole path runs inside Think's serialized turn
 * queue: one hung provider call would wedge every subsequent turn on the
 * workspace until eviction. A timeout rejection lands in the extension's
 * existing fail-open path (deterministic previews), so the turn always
 * proceeds.
 */

import { generateText, type LanguageModel } from 'ai';
import { normalizeUsage, type ModelCallSpend } from '@proteus/core';

export const SUMMARIZER_TIMEOUT_MS = 60_000;

/**
 * `spend` carries both the sink and the label — `compaction` for the fold this
 * summarizer exists for. It is the producer that fires precisely when a
 * conversation got expensive, so a workspace total that omitted it understated
 * exactly the sessions an owner asks about. Optional: a backend that wires no
 * sink summarizes exactly as before.
 */
export function createModelSummarizer(
  getModel: () => LanguageModel,
  timeoutMs: number = SUMMARIZER_TIMEOUT_MS,
  spend?: ModelCallSpend,
): (prompt: string) => Promise<string> {
  return async (prompt) => {
    const result = await generateText({
      model: getModel(),
      prompt,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    // A timeout rejection never reaches this line: it produced no usage and, as
    // far as this seam can see, no bill, so reporting it would count a call that
    // cost nothing against the measured fraction.
    spend?.report({
      source: spend.source,
      usage: normalizeUsage(result.totalUsage),
      modelId: result.response.modelId,
    });
    return result.text;
  };
}
