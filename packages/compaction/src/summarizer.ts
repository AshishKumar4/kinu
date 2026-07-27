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

export const SUMMARIZER_TIMEOUT_MS = 60_000;

export function createModelSummarizer(
  getModel: () => LanguageModel,
  timeoutMs: number = SUMMARIZER_TIMEOUT_MS,
): (prompt: string) => Promise<string> {
  return (prompt) =>
    generateText({
      model: getModel(),
      prompt,
      abortSignal: AbortSignal.timeout(timeoutMs),
    }).then((r) => r.text);
}
