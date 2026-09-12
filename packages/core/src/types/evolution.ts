/** The turn-outcome and replay-eval contract, declared at the platform layer:
 *  the agent-self tool surface reads replay summaries without importing the
 *  evolution or replay machinery. */

import type { ScoreInterval } from '../utils/stats';

export interface ReplayInstanceResult {
  outcomeId: string;
  outcome: TurnOutcomeRow['outcome'];
  score: number;
  note: string;
}

export interface ReplayEvalSummary {
  id: string;
  ranAt: number;
  sampleSize: number;
  acceptedCount: number;
  negativeCount: number;
  meanScore: number;
  loss: number;
  /** 95% interval around `meanScore` (loss bounds are its complement — see
   *  `lossInterval`). Never read the mean without it. */
  interval: ScoreInterval;
  scaffoldVersion: number | null;
  results: ReplayInstanceResult[];
}

/** Every outcome kind, in the ledger's canonical order. The one list — the
 *  table's CHECK constraint, the query filter and the changelog tally all
 *  derive from it. */
export const TURN_OUTCOMES = ['accepted', 'corrected', 'frustrated', 'abandoned'] as const;

export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

/** The outcomes that carry a complaint — what "a turn that landed badly"
 *  means everywhere it is drawn as a set (GEPA's optimization targets, the
 *  pathology clustering). `abandoned` is an absence of signal, not a verdict. */
export const NEGATIVE_TURN_OUTCOMES = ['corrected', 'frustrated'] as const;

/** What a HUMAN may say about a turn when hand-labeling it (calibration.ts):
 *  any real outcome, or an admission that the follow-up does not settle it.
 *  `unclear` is a verdict, not a skip — it is recorded, then excluded from
 *  every estimate. */
export const OUTCOME_LABELS = [...TURN_OUTCOMES, 'unclear'] as const;

export type OutcomeLabel = (typeof OUTCOME_LABELS)[number];

/** Where an outcome row came from, in the ledger's canonical order — the one
 *  list the table's CHECK constraint derives from:
 *    explicit    — the user's thumbs.
 *    classifier  — the LLM verdict on a real conversational follow-up.
 *    session_end — the session-end (abandoned) rule.
 *    take_pick   — an Alternate Takes pick (mcts/takes.ts): an explicit
 *                  preference between explored takes.
 *    execution   — the ENVIRONMENT's verdict on a turn no user will grade
 *                  (see `executionVerdict`). Machine evidence, not a person's
 *                  judgment; every reader that speaks about user opinion must
 *                  say so and exclude it (alignment.ts does).
 */
export const TURN_OUTCOME_SOURCES = [
  'explicit', 'classifier', 'session_end', 'take_pick', 'execution',
] as const;

export type TurnOutcomeSource = (typeof TURN_OUTCOME_SOURCES)[number];

/** Which observation of one turn is its EFFECTIVE verdict, strongest first:
 *  a thumb outranks a take pick, which outranks the classifier, which outranks
 *  the environment. `session_end` is absent and ranks last. Both ledger reads
 *  that resolve a verdict bind this list into their ORDER BY, so the rule
 *  lives here once. */
export const TURN_OUTCOME_SOURCE_PRECEDENCE = [
  'explicit', 'take_pick', 'classifier', 'execution',
] as const satisfies readonly TurnOutcomeSource[];

export interface TurnOutcomeRow {
  id: string;
  turnId: string | null;
  sessionId: string;
  outcome: TurnOutcome;
  confidence: number;
  source: TurnOutcomeSource;
  userMessage: string;
  assistantResponse: string;
  followup: string | null;
  scaffoldVersion: number | null;
  createdAt: number;
  /** WHY this verdict: the classifier's one-sentence reason, or the execution
   *  verdict's observation. Null where the source is its own evidence (a thumb). */
  evidence: string | null;
}
