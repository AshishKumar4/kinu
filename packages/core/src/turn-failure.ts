/**
 * Provider turn-failure classification + overflow recovery — ONE shared
 * policy both backends apply when a turn's model request fails.
 *
 * `context_length` failures arm force-compaction: the request cannot be
 * replayed as-is, so the NEXT turn assembly must run the context transform
 * with trigger:'force' (the compaction extension's forceRebuild), and ONE
 * retry turn is enqueued to resume the interrupted work. `rate_limit`
 * failures do NOT force-compact — throughput exhaustion is not a size
 * problem (production-proven on workspace-1a4e20: a 429 after 1.5M
 * CUMULATIVE input tokens across 33 uncached steps whose individual
 * requests were each ~40-60k tokens, well inside the window).
 *
 * The one exception is the size heuristic: a rate-limit-shaped error on a
 * request whose measured PER-REQUEST prompt (the last provider-reported
 * step, never the turn's cumulative total) exceeded half the window is
 * treated as context-class — at that size the request itself is the
 * problem, whatever the provider called it.
 */

/** Closed classification of a failed turn's provider error. */
export type TurnFailureClass = 'context_length' | 'rate_limit' | 'transient';

/** Marker metadata value stamped on the ONE enqueued retry turn — a retry
 *  turn that fails again never enqueues another (never loop). */
export const OVERFLOW_RETRY_EVENT = 'overflow_retry';

/** The retry turn's user-visible text. */
export const OVERFLOW_RETRY_TEXT =
  "The previous turn failed because the request exceeded the model's context window. " +
  'The history has been compacted — continue the interrupted work from where it stopped.';

const CONTEXT_LENGTH_PATTERNS: readonly RegExp[] = [
  /context[ _-]?length/i,
  /context[ _-]?window/i,
  /maximum context/i,
  /too many tokens/i,
  /string too long/i,
  /prompt is too long/i,
  /input is too long/i,
  /request too large/i,
  /payload too large/i,
  /exceeds? the (?:maximum )?(?:token|context)/i,
];

const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /\b429\b/,
  /too many requests/i,
  /rate[ _-]?limit/i,
  /quota exceeded/i,
];

export interface TurnFailureSignals {
  /** The last provider-reported PER-REQUEST prompt size of the failed turn
   *  (TurnAccumulator.lastPromptTokens) — NOT the turn's cumulative input. */
  lastPromptTokens?: number;
  /** The resolved model's context window, in tokens. */
  contextWindow?: number;
}

/** Classify a failed turn's provider error text. */
export function classifyTurnFailure(error: string, signals: TurnFailureSignals = {}): TurnFailureClass {
  if (CONTEXT_LENGTH_PATTERNS.some((re) => re.test(error))) return 'context_length';
  if (RATE_LIMIT_PATTERNS.some((re) => re.test(error))) {
    const { lastPromptTokens, contextWindow } = signals;
    const oversized =
      lastPromptTokens !== undefined && lastPromptTokens > 0 &&
      contextWindow !== undefined && contextWindow > 0 &&
      lastPromptTokens > contextWindow * 0.5;
    return oversized ? 'context_length' : 'rate_limit';
  }
  return 'transient';
}

export interface OverflowRecoveryInput extends TurnFailureSignals {
  /** The failed turn's provider error text, when one was reported. */
  error: string | undefined;
  /** Whether the failed turn WAS the enqueued overflow retry — a second
   *  failure must never enqueue a third turn. */
  turnWasOverflowRetry: boolean;
}

export interface OverflowRecoveryDecision {
  failureClass: TurnFailureClass | null;
  /** Arm the session's force-compaction flag: next assembly runs the
   *  context transform with trigger:'force'. */
  forceCompaction: boolean;
  /** Enqueue the ONE overflow retry turn (OVERFLOW_RETRY_TEXT, stamped
   *  proteusEvent: OVERFLOW_RETRY_EVENT). */
  enqueueRetry: boolean;
}

/** The shared recovery decision for a non-completed turn. */
export function planOverflowRecovery(input: OverflowRecoveryInput): OverflowRecoveryDecision {
  if (!input.error) return { failureClass: null, forceCompaction: false, enqueueRetry: false };
  const failureClass = classifyTurnFailure(input.error, input);
  if (failureClass !== 'context_length') return { failureClass, forceCompaction: false, enqueueRetry: false };
  return { failureClass, forceCompaction: true, enqueueRetry: !input.turnWasOverflowRetry };
}
