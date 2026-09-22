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
  /** 95% interval around `meanScore`; never read the mean without it. */
  interval: ScoreInterval;
  scaffoldVersion: number | null;
  results: ReplayInstanceResult[];
}

/** Canonical order; the table's CHECK constraint, query filter and changelog derive from it. */
export const TURN_OUTCOMES = ['accepted', 'corrected', 'frustrated', 'abandoned'] as const;

export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

/** `abandoned` is an absence of signal, not a complaint. */
export const NEGATIVE_TURN_OUTCOMES = ['corrected', 'frustrated'] as const;

/** Human labels; `unclear` is recorded, then excluded from every estimate. */
export const OUTCOME_LABELS = [...TURN_OUTCOMES, 'unclear'] as const;

export type OutcomeLabel = (typeof OUTCOME_LABELS)[number];

/**
 * The table's CHECK constraint derives from this list. `execution` is the environment's verdict,
 * not a person's; readers speaking about user opinion must exclude it.
 */
export const TURN_OUTCOME_SOURCES = [
  'explicit', 'classifier', 'session_end', 'take_pick', 'execution',
] as const;

export type TurnOutcomeSource = (typeof TURN_OUTCOME_SOURCES)[number];

/** Effective-verdict precedence, strongest first; `session_end` ranks last. Bound into ORDER BY. */
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
  /** Null where the source is its own evidence (a thumb). */
  evidence: string | null;
}
