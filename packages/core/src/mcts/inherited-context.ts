/**
 * Branch context inheritance — whole-message, last-N bounded.
 *
 * An MCTS branch reasons from the parent's conversation history. The naive
 * approach joins every message into one string and char-slices the tail
 * (`.slice(-2000)` / `.slice(-800)`), which severs the oldest surviving message
 * mid-word — the branch starts reading from a fragment with no role marker
 * (THINKING-AUDIT-2026-06-12 §4 #10).
 *
 * This shares `readInheritedContext`'s last-N *message* discipline: keep whole
 * messages, bound by count, never split one. The same boundary the heads path
 * already uses — one source of truth for "what context a child inherits".
 */

/** A conversation message as branches receive it from `getHistory`. */
export interface InheritedMessage {
  readonly role: string;
  readonly content: string;
}

/** Default number of trailing whole messages a branch inherits. */
export const DEFAULT_INHERITED_MESSAGES = 12;

/**
 * Format the last-N whole messages as the branch's prior-context block.
 *
 * Keeps complete messages (role + full content) — no mid-word truncation —
 * bounded by message count, not character budget. Returns '' for empty input.
 */
export function formatInheritedContext(
  history: readonly InheritedMessage[],
  lastN: number = DEFAULT_INHERITED_MESSAGES,
): string {
  if (history.length === 0) return '';
  const n = Math.max(1, lastN);
  return history
    .slice(-n)
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');
}
