/** Consent chords shared by the shell-command and device-connect overlays. */
import type { TuiKeyDispatcher, TuiKeyEvent } from './actions';

/** Null consumes the key and leaves the question open. `later` only answers a question that can wait. */
export type ConsentKeyDecision = 'once' | 'always' | 'deny' | 'later';

export function consentKeyDecision(
  key: TuiKeyEvent,
  dispatcher: TuiKeyDispatcher,
  canApprove: boolean,
): ConsentKeyDecision | null {
  const actionId = dispatcher.feed(key, ['consent']).actionId;

  if (actionId === 'consent.once' && canApprove) return 'once';

  if (actionId === 'consent.always' && canApprove) return 'always';

  if (actionId === 'consent.deny') return 'deny';

  if (actionId === 'consent.later') return 'later';

  return null;
}
