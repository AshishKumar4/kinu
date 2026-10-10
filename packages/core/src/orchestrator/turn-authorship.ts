/** Whom a turn answers, decided once for every host (design v2 §1.6). */

import { OWNER_ANSWER_SIGNAL } from '../types/owner-questions';

/** The hirer's turn runs in the hirer's lane and may `report`; the owner's does not. */
export type TurnAuthorship = 'owner' | 'hirer';

/** The owner's decisions a programmatic turn carries out: a plan's feedback or approval, and the answer that resumes a
 *  question. No words of the owner's open them, and they are the owner's all the same. */
const OWNER_DECISIONS: ReadonlySet<string | undefined> = new Set(['plan_feedback', 'plan_approved', OWNER_ANSWER_SIGNAL]);

/**
 * The owner's words and the owner's decisions are the owner's; every other programmatic turn is its hirer's. `event` is
 * the `kinuEvent` the turn's decision path stamped. The CLI gave every programmatic turn to the hirer, so a hire's
 * question the owner answered could `report`; the cloud agreed with this rule, and now both read it.
 */
export function turnAuthorship(turn: { readonly kind: 'user' | 'programmatic'; readonly event?: string }): TurnAuthorship {
  return turn.kind === 'user' || OWNER_DECISIONS.has(turn.event) ? 'owner' : 'hirer';
}
