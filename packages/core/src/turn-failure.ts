/**
 * Turn-failure classification and overflow recovery shared by both backends.
 * `context_length` arms force-compaction plus one retry; `rate_limit` does not, unless the last per-request prompt exceeded half the window.
 */

/** `auth` and `admission_refused` (our own pre-submission gate, #20) are never `transient`: a retry can only fail again. */
export type TurnFailureClass = 'context_length' | 'rate_limit' | 'auth' | 'admission_refused' | 'transient';

/** Stamped on the single retry turn; a failing retry never enqueues another. */
export const OVERFLOW_RETRY_EVENT = 'overflow_retry';

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

/** Leads the message `refuseOversizedRequest` (orchestrator/turn-context.ts) raises. */
export const ADMISSION_REFUSAL_MARK = 'Request refused before submission';

/** Kept in step with the texts `cloudflare-ai-fetch.ts` and `providers/codex.ts` emit. */
const AUTH_PATTERNS: readonly RegExp[] = [
  /\b401\b/,
  /unauthorized/i,
  /invalid[ _-]?grant/i,
  /invalid[ _-]?(api[ _-]?)?key/i,
  /login is no longer valid/i,
  /(api[ _]?key|credential|token)[^.\n]*(invalid|expired|revoked|not configured)/i,
];

export interface TurnFailureSignals {
  /** Per-request prompt size (TurnAccumulator.lastPromptTokens), not the turn's cumulative input. */
  lastPromptTokens?: number;
  contextWindow?: number;
}

export function classifyTurnFailure(error: string, signals: TurnFailureSignals = {}): TurnFailureClass {
  // First: the refusal text also matches the context-length patterns.
  if (error.includes(ADMISSION_REFUSAL_MARK)) return 'admission_refused';

  if (CONTEXT_LENGTH_PATTERNS.some((re) => re.test(error))) return 'context_length';

  if (RATE_LIMIT_PATTERNS.some((re) => re.test(error))) {
    const { lastPromptTokens, contextWindow } = signals;

    const oversized =
      lastPromptTokens !== undefined && lastPromptTokens > 0 &&
      contextWindow !== undefined && contextWindow > 0 &&
      lastPromptTokens > contextWindow * 0.5;

    return oversized ? 'context_length' : 'rate_limit';
  }

  if (AUTH_PATTERNS.some((re) => re.test(error))) return 'auth';

  return 'transient';
}

export interface OverflowRecoveryInput extends TurnFailureSignals {
  error: string | undefined;
  turnWasOverflowRetry: boolean;
}

export interface OverflowRecoveryDecision {
  failureClass: TurnFailureClass | null;
  /** Next assembly runs the context transform with trigger:'force'. */
  forceCompaction: boolean;
  enqueueRetry: boolean;
}

export function planOverflowRecovery(input: OverflowRecoveryInput): OverflowRecoveryDecision {
  if (!input.error) return { failureClass: null, forceCompaction: false, enqueueRetry: false };
  const failureClass = classifyTurnFailure(input.error, input);

  if (failureClass !== 'context_length') return { failureClass, forceCompaction: false, enqueueRetry: false };

  return { failureClass, forceCompaction: true, enqueueRetry: !input.turnWasOverflowRetry };
}
