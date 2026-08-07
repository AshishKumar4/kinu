/**
 * How much of a turn the evolution loop is allowed to see, and which part.
 *
 * Every reader in the loop — the shadow judge, the GEPA reflector, the turn
 * outcome classifier, the replay judge — used to carry its own hard-coded
 * slice, and every one of those slices was `slice(0, n)`: the FIRST n
 * characters. That is not a cost bound, it is a blind spot with a shape. A
 * turn whose payoff lands at step 9 of 12 — which is what a long-horizon win
 * looks like — is invisible to a judge reading its first 2,500 characters, so
 * the fitness function cannot select for the thing it is supposed to select
 * for.
 *
 * Two changes, one policy:
 *
 *   1. Head AND tail. `evidenceWindow` keeps both ends and says how much it
 *      dropped, so a conclusion survives the budget. The split is even, unlike
 *      clampToolResult's 70/30 — a tool result's head carries the command echo
 *      and its tail the error, while a judged trajectory carries its framing at
 *      the start and its outcome at the end, and the outcome is the thing being
 *      judged.
 *
 *   2. One table. The budgets below are the single source, and they are
 *      ordered: a reader's budget is never larger than the budget the text was
 *      STORED at, because reading further than the row goes buys nothing. The
 *      old numbers had no such relation — the replay judge asked for 3,000
 *      characters of a response the ledger had already cut to 4,000 for
 *      reasons nobody had written down.
 *
 * What this deliberately does not touch: the judge protocols themselves, the
 * promotion thresholds, the sampling rates. Only how much evidence reaches an
 * unchanged reader. That is still not free — DEFAULT_SHADOW_CONFIG's decisive
 * yield and tie rate were Monte-Carlo-calibrated against the OLD evidence
 * (scripts/shadow-veto-monte-carlo.ts), and richer evidence moves both — so
 * the calibration is due a re-run against these budgets, and the promotion
 * rule is byte-unchanged until it has been.
 */

/** Even split: the framing is at the start, the outcome at the end, and a
 *  judge is scoring the outcome. */
const HEAD_FRACTION = 0.5;

/**
 * Bound `text` to roughly `maxChars`, keeping both ends and naming what was
 * dropped. Within budget the text passes through byte-identical, so nothing
 * short is ever marked up.
 */
export function evidenceWindow(text: string, maxChars: number): string {
  if (maxChars <= 0) throw new Error(`evidence budget must be positive, got ${maxChars}`);
  if (text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * HEAD_FRACTION);
  const tailLen = maxChars - headLen;
  const omitted = text.length - headLen - tailLen;
  return `${text.slice(0, headLen)}\n[... ${omitted} chars omitted from the middle ...]\n${text.slice(-tailLen)}`;
}

/**
 * The evolution loop's evidence budgets, in characters.
 *
 * Each is four times what the site it replaced used. Four rather than a number
 * chosen per site: the old numbers were not derived from anything, so tuning
 * them individually would be inventing a second set of arbitrary constants.
 * A uniform multiple keeps every reader's relative emphasis exactly as it was
 * while making all of them able to see a twelve-step turn — and the cost is
 * small, because these calls are already sampled (a quarter of turns) and are
 * the cheapest calls the loop makes.
 */
export const EVIDENCE_BUDGETS = {
  /** turn_outcomes rows. Everything downstream — GEPA instances, the replay
   *  judge — reads these, so this is the ceiling on the whole ledger path and
   *  must be raised first or every reader budget below it is inert. */
  storedUserMessage: 8_000,
  storedAssistantResponse: 16_000,
  storedFollowup: 8_000,

  /** Shadow eval: what the sampled judge is shown, and what the trial row
   *  records. One window for both, so the stored evidence IS the evidence the
   *  verdict was formed on. */
  shadowTask: 6_000,
  shadowOutput: 10_000,

  /** GEPA reflective mutation: per-instance trajectory evidence. */
  gepaInstanceInput: 1_600,
  gepaInstanceEvidence: 3_200,
  gepaInstanceFeedback: 3_200,
  /** The parent candidate's source. Head-only truncation, not a window: a
   *  rewrite of code whose middle was elided comes back with a hole. */
  gepaParentSource: 16_000,

  /** Replay eval: the task, the fresh response, and the reference it is scored
   *  against. */
  replayTask: 6_000,
  replayFreshResponse: 12_000,
  replayReferenceResponse: 12_000,
  replayFailedResponse: 8_000,
  replayCorrection: 4_000,

  /** Turn outcome classification from the user's follow-up. */
  outcomeUserMessage: 4_000,
  outcomeAssistantResponse: 8_000,
  outcomeFollowup: 4_000,
} as const;
