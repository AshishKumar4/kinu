/**
 * Branch context inheritance: last-N whole messages (never split one), then the shared
 * evidence window bounds total size.
 */

import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window';

export interface InheritedMessage {
  readonly role: string;
  readonly content: string;
}

export const DEFAULT_INHERITED_MESSAGES = 12;

const DEFAULT_INHERITED_CONTEXT_CHARS =
  DEFAULT_INHERITED_MESSAGES * EVIDENCE_BUDGETS.inheritedMessage;

/** Format the last-N whole messages as the branch's prior-context block; '' for empty input. */
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
