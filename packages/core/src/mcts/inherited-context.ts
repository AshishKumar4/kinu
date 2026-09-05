/**
 * Branch context inheritance — whole-message, last-N bounded, then windowed.
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
 * Count alone cannot bound the prompt: one long message still fills the
 * window. The joined block passes through the shared evidence window, which
 * keeps both ends and names what it dropped.
 */

import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window';

/** A conversation message as branches receive it from `getHistory`. */
export interface InheritedMessage {
  readonly role: string;
  readonly content: string;
}

/** Default number of trailing whole messages a branch inherits. */
export const DEFAULT_INHERITED_MESSAGES = 12;

/**
 * Default total characters a branch inherits. Twelve kept messages each run
 * to their per-message ceiling is 19,200 characters, so the total of what
 * the window may hold is the window times the ceiling it holds it to.
 */
export const DEFAULT_INHERITED_CONTEXT_CHARS =
  DEFAULT_INHERITED_MESSAGES * EVIDENCE_BUDGETS.inheritedMessage;

/**
 * Format the last-N whole messages as the branch's prior-context block.
 *
 * Keeps complete messages (role + full content) — no mid-word truncation —
 * bounded by message count, then by total characters through the shared
 * evidence window. Short blocks pass through byte-identical. Returns '' for
 * empty input.
 */
export function formatInheritedContext(
  history: readonly InheritedMessage[],
  lastN: number = DEFAULT_INHERITED_MESSAGES,
  maxChars: number = DEFAULT_INHERITED_CONTEXT_CHARS,
): string {
  if (history.length === 0) return '';
  const n = Math.max(1, lastN);
  const block = history
    .slice(-n)
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');
  return evidenceWindow(block, maxChars);
}
