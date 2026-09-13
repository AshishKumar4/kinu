/**
 * Consent chords. Both approval overlays — shell command and device connect —
 * bind the same three actions in the same scope, so the keystroke resolves to
 * a decision here and each overlay maps it to its own verdict.
 */
import type { TuiKeyDispatcher, TuiKeyEvent } from './actions';

/** What a consent chord decided. Null is "bound nothing" or "the overlay
 *  vetoed approval at this size" — either way the keystroke is consumed and
 *  the question stays open. */
export type ConsentKeyDecision = 'once' | 'always' | 'deny';

export function consentKeyDecision(
  key: TuiKeyEvent,
  dispatcher: TuiKeyDispatcher,
  canApprove: boolean,
): ConsentKeyDecision | null {
  const actionId = dispatcher.feed(key, ['consent']).actionId;

  if (actionId === 'consent.once' && canApprove) return 'once';

  if (actionId === 'consent.always' && canApprove) return 'always';

  if (actionId === 'consent.deny') return 'deny';

  return null;
}
