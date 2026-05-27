/**
 * Context compaction — Hermes-style + Flue-style defaults.
 *
 * When a conversation accumulates enough tokens that the next turn would
 * crowd the model's context window, we summarize older turns and replace
 * them with a compact summary, preserving the first N+ turns (system /
 * initial instruction) and last N− turns (recent active context).
 *
 * Default thresholds mirror Flue's runtime/compaction.ts:
 *   reserveTokens     = 20000  (headroom: never compact within this of the limit)
 *   keepRecentTokens  = 8000   (tail to preserve verbatim)
 *   keepFirstMessages = 3      (head to preserve verbatim)
 *
 * Public API:
 *   shouldCompact(tokenCount, contextWindow, config) → boolean
 *   compactMessages(messages, summarize, config) → { messages, summary, droppedCount }
 */

import type { CompactionResult, CompactionConfig, CompactableMessage, SummarizeFn } from './types/compaction.js';

/** Concrete defaults; summarizationModel is intentionally left adapter-supplied. */
export const DEFAULT_COMPACTION_CONFIG: Omit<Required<CompactionConfig>, 'summarizationModel'> = {
  enabled: true,
  reserveTokens: 20_000,
  keepRecentTokens: 8_000,
  keepFirstMessages: 3,
  // Rough chars-per-token; English ~ 4. Used when no explicit token counter
  // is provided. Conservative high estimate keeps us from under-compacting.
  charsPerToken: 4,
};

/** Did `tokenCount` cross the threshold where we should run compaction? */
export function shouldCompact(
  tokenCount: number,
  contextWindow: number,
  config: Partial<CompactionConfig> = {},
): boolean {
  const c = { ...DEFAULT_COMPACTION_CONFIG, ...config };
  if (!c.enabled) return false;
  if (contextWindow <= 0) return false; // unknown window — don't compact
  return tokenCount > contextWindow - c.reserveTokens;
}

/** Rough token estimate. Used when no explicit counter is provided. */
export function estimateTokens(
  messages: readonly CompactableMessage[],
  config: Partial<CompactionConfig> = {},
): number {
  const c = { ...DEFAULT_COMPACTION_CONFIG, ...config };
  const chars = messages.reduce((acc, m) => acc + m.content.length, 0);
  return Math.ceil(chars / c.charsPerToken);
}

/**
 * Compact a message array. Returns a new shorter array + summary text +
 * how many were dropped. The structure:
 *
 *   [first N first messages (preserved verbatim)]
 *   [synthetic 'assistant' message with the summary]
 *   [last K recent messages summing ≤ keepRecentTokens (preserved verbatim)]
 *
 * Order is preserved; only middle is summarized.
 *
 * If there's nothing to compact (e.g. all messages fit in head+tail), returns
 * the original array unchanged.
 */
export async function compactMessages(
  messages: readonly CompactableMessage[],
  summarize: SummarizeFn,
  config: Partial<CompactionConfig> = {},
): Promise<CompactionResult> {
  const c = { ...DEFAULT_COMPACTION_CONFIG, ...config };
  if (messages.length === 0) {
    return { messages: [...messages], summary: '', droppedCount: 0 };
  }

  // Step 1: identify head (preserved verbatim)
  const head = messages.slice(0, c.keepFirstMessages);

  // Step 2: walk backwards from end to compute the tail that fits in keepRecentTokens
  const tail: CompactableMessage[] = [];
  let tailTokens = 0;
  for (let i = messages.length - 1; i >= c.keepFirstMessages; i--) {
    const m = messages[i];
    const t = Math.ceil(m.content.length / c.charsPerToken);
    if (tailTokens + t > c.keepRecentTokens) break;
    tail.unshift(m);
    tailTokens += t;
  }

  // Step 3: middle is what's between head and tail
  const middle = messages.slice(c.keepFirstMessages, messages.length - tail.length);
  if (middle.length === 0) {
    // Nothing to summarize; return original.
    return { messages: [...messages], summary: '', droppedCount: 0 };
  }

  // Step 4: summarize the middle
  const summary = await summarize(middle);

  const summaryMessage: CompactableMessage = {
    role: 'assistant',
    content: `[compaction summary of ${middle.length} earlier turn(s)]\n${summary}`,
  };

  return {
    messages: [...head, summaryMessage, ...tail],
    summary,
    droppedCount: middle.length,
  };
}
