/**
 * Turn-failure classification and overflow recovery shared by both backends.
 * `context_length` arms force-compaction plus one retry; `rate_limit` does not, unless the last per-request prompt exceeded half the window.
 */
import { APICallError, RetryError } from 'ai';
import { renderThrownChain } from './obs/index';

/** `auth` and `admission_refused` (our own pre-submission gate, #20) are never `transient`: a retry can only fail again. */
export type TurnFailureClass = 'context_length' | 'rate_limit' | 'auth' | 'admission_refused' | 'transient';

/** Stamped on the single retry turn; a failing retry never enqueues another. */
export const OVERFLOW_RETRY_EVENT = 'overflow_retry';

export const OVERFLOW_RETRY_TEXT =
  "The previous turn failed because the request exceeded the model's context window. " +
  'The history has been compacted: continue the interrupted work from where it stopped.';

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
  /exceeds? the (?:maximum )?(?:number of )?(?:tokens?|context)/i,
];

/** OpenAI's 429 for one request over the whole per-minute budget, which no wait cures: "Request too large for …". */
const UNSERVABLE_REQUEST = /request too large/i;

const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /\b429\b/,
  /too many requests/i,
  /rate[ _-]?limit/i,
  /quota exceeded/i,
];

/** Leads the message `refuseOversizedRequest` (orchestrator/turn-context.ts) raises. */
export const ADMISSION_REFUSAL_MARK = 'Request refused before submission';

/** A credential refused before any response (an OAuth refresh's `invalid_grant`); a refused request has its 401 or 403. */
const AUTH_PATTERNS: readonly RegExp[] = [
  /\b401\b/,
  /unauthorized/i,
  /invalid[ _-]?grant/i,
  /invalid[ _-]?(api[ _-]?)?key/i,
  /login is no longer valid/i,
  /(api[ _]?key|credential|token)[^.\n]*(invalid|expired|revoked|not configured)/i,
];

/** How providers state the limit a refused request overran: OpenAI's "maximum context length is N", Anthropic's
 *  "N > M maximum", Gemini's "maximum number of tokens allowed (M)", and the generic "context window of M". */
const STATED_LIMIT_PATTERNS: readonly RegExp[] = [
  /maximum context length is ([\d,]+)/i,
  />\s*([\d,]+) maximum/i,
  /maximum number of tokens(?: allowed)? (?:is )?\(?([\d,]+)/i,
  /context (?:length|window) (?:of|is) ([\d,]+)/i,
  /limit (?:of|is) ([\d,]+) tokens/i,
];

/** The context limit a too-long refusal states, or null when it states none. */
export function statedContextLimit(error: string): number | null {
  for (const pattern of STATED_LIMIT_PATTERNS) {
    const limit = Number(pattern.exec(error)?.[1]?.replaceAll(',', '') ?? Number.NaN);

    if (Number.isSafeInteger(limit) && limit > 0) return limit;
  }

  return null;
}

export interface TurnFailureSignals {
  /** Per-request prompt size (TurnAccumulator.lastPromptTokens), not the turn's cumulative input. */
  lastPromptTokens?: number;
  contextWindow?: number | null;
}

/** A rate limit on a prompt past half the window is the prompt's size, which compaction cures. */
function rateLimited(signals: TurnFailureSignals): TurnFailureClass {
  const { lastPromptTokens, contextWindow } = signals;

  const oversized =
    lastPromptTokens !== undefined && lastPromptTokens > 0 &&
    contextWindow !== undefined && contextWindow !== null && contextWindow > 0 &&
    lastPromptTokens > contextWindow * 0.5;

  return oversized ? 'context_length' : 'rate_limit';
}

/** The status a provider refused with, through `streamText`'s retry wrapper; a 2xx `APICallError` wraps a failed read. */
function refusalStatus(failure: Error): number | undefined {
  const seen = new Set<unknown>();

  for (let link: unknown = failure; link instanceof Error && !seen.has(link); link = RetryError.isInstance(link) ? link.lastError : link.cause) {
    seen.add(link);

    if (APICallError.isInstance(link) && link.statusCode !== undefined && link.statusCode >= 400) return link.statusCode;
  }

  return undefined;
}

/** A provider's refusal by its HTTP status; only a failure with none (a dropped connection, a local refusal) by its text. */
export function classifyTurnFailure(failure: string | Error, signals: TurnFailureSignals = {}): TurnFailureClass {
  const error = failure instanceof Error ? renderThrownChain({ cause: failure }) : failure;

  // First: the refusal text also matches the context-length patterns.
  if (error.includes(ADMISSION_REFUSAL_MARK)) return 'admission_refused';
  const status = failure instanceof Error ? refusalStatus(failure) : undefined;
  const tooLong = CONTEXT_LENGTH_PATTERNS.some((re) => re.test(error));

  if (status === undefined) {
    if (tooLong) return 'context_length';

    if (RATE_LIMIT_PATTERNS.some((re) => re.test(error))) return rateLimited(signals);

    return AUTH_PATTERNS.some((re) => re.test(error)) ? 'auth' : 'transient';
  }

  if (status === 413 || (status === 429 && UNSERVABLE_REQUEST.test(error))) return 'context_length';

  if (status === 429) return rateLimited(signals);

  if (status === 401 || status === 403) return 'auth';

  // A too-long request has no status of its own (OpenAI, Anthropic and Gemini answer 400): only its text says so.
  return tooLong ? 'context_length' : 'transient';
}

export interface OverflowRecoveryInput extends TurnFailureSignals {
  /** The turn's failure: an `APICallError` anywhere in its chain is read by its status. */
  error: string | Error | undefined;
  turnWasOverflowRetry: boolean;
}

export interface OverflowRecoveryDecision {
  failureClass: TurnFailureClass | null;
  /** Next assembly runs the context transform with trigger:'force'. */
  forceCompaction: boolean;
  enqueueRetry: boolean;
}

export function planOverflowRecovery(input: OverflowRecoveryInput): OverflowRecoveryDecision {
  if (input.error === undefined || input.error === '') return { failureClass: null, forceCompaction: false, enqueueRetry: false };
  const failureClass = classifyTurnFailure(input.error, input);

  if (failureClass !== 'context_length') return { failureClass, forceCompaction: false, enqueueRetry: false };

  return { failureClass, forceCompaction: true, enqueueRetry: !input.turnWasOverflowRetry };
}
