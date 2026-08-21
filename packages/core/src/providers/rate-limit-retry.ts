import { asFetchFunction } from './fetch-shim';
import * as v from 'valibot';
import { diagnostics, KinuError } from '../obs/index';
import { abortableSleep, providerPacer, type ProviderPacer } from './pacing';

/**
 * How many times ONE request may be told to wait before this layer stops asking.
 *
 * Exported because it is also the turn loop's bound: `chat.ts`'s stall watchdog
 * excuses a silence that a provider mandated, and the number of declared waits a
 * single request can possibly produce is exactly this. So the watchdog's patience
 * is derived from the retry policy rather than being a second guess at it.
 */
export const RATE_LIMIT_MAX_ATTEMPTS = 6;

/** The wall clock one request may spend inside this layer's waits. Beyond it the
 *  429 is handed back to the SDK unchanged. */
export const RATE_LIMIT_MAX_ELAPSED_MS = 180_000;

/**
 * How many times the AI SDK may re-issue a model request of its own accord.
 *
 * THE VALUE IS THE SDK'S OWN DEFAULT, stated rather than changed, and the point
 * of stating it is arithmetic that nobody could previously do. This layer's waits
 * are bounded by {@link RATE_LIMIT_MAX_ELAPSED_MS}, so a reader concluded that a
 * rate-limited request could go quiet for at most 180 s — and then a live turn
 * was ended for 300 s of silence. The missing term is this one: an outer retry
 * RE-ENTERS this wrapper with a fresh elapsed budget, so the mandated silence one
 * request can produce is {@link PROVIDER_WAIT_BUDGET_MS}, not one budget.
 *
 * Passed explicitly at the `streamText` call rather than inherited, so the number
 * the watchdog derives its patience from is the number actually configured. A
 * vendor default that changes under us would otherwise silently move a bound in
 * a different file.
 */
export const PROVIDER_SDK_RETRIES = 2;

/**
 * The longest ONE uninterrupted silence may legitimately be provider-mandated.
 *
 * Every term is measured or configured: the SDK issues one request plus
 * {@link PROVIDER_SDK_RETRIES} more, and each of those may spend up to
 * {@link RATE_LIMIT_MAX_ELAPSED_MS} inside this layer's waits. Beyond it nothing
 * is holding off under instruction any more, so `chat.ts`'s watchdog stops
 * excusing the silence and ends the turn — naming the rate limit, which is the
 * distinction the incident turned on.
 */
export const PROVIDER_WAIT_BUDGET_MS =
  (PROVIDER_SDK_RETRIES + 1) * RATE_LIMIT_MAX_ELAPSED_MS;

const DEFAULT_BASE_DELAY_MS = 2_000;
const DEFAULT_BACKOFF_FACTOR = 2;
const DEFAULT_MAX_DELAY_MS = 60_000;

export interface RateLimitRetryOptions {
  maxAttempts?: number;
  maxElapsedMs?: number;
  baseDelayMs?: number;
  backoffFactor?: number;
  maxDelayMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
  warn?: (message: string) => void;
  /** The isolate's provider pacer. Injectable so a suite can drive lanes and
   *  cooldowns without reaching into the shared one. */
  pacer?: ProviderPacer;
}

/**
 * Add patient rate-limit handling at a model provider's HTTP boundary, and pace
 * the requests that reach it.
 *
 * Responses are returned unchanged when the retry budget is exhausted so the
 * provider SDK retains ownership of its normal error shape.
 *
 * TWO THINGS BEYOND RETRYING, both because the provider is SHARED (see
 * `pacing.ts` for the incident):
 *
 *   - Every attempt goes out through {@link ProviderPacer.admit}, which spaces
 *     request STARTS against one host and holds each caller behind any wait the
 *     provider has already mandated. A whole swarm level starting at once used to
 *     arrive as N simultaneous first requests on one credential.
 *   - Every wait is DECLARED before it is taken, which is what makes it
 *     distinguishable from silence one level up. Without that the turn loop saw a
 *     mandated wait as a dead request and ended the turn.
 */
export function withRateLimitRetry(
  fetchImpl: typeof globalThis.fetch,
  opts: RateLimitRetryOptions = {},
): typeof globalThis.fetch {
  const maxAttempts = opts.maxAttempts ?? RATE_LIMIT_MAX_ATTEMPTS;
  const maxElapsedMs = opts.maxElapsedMs ?? RATE_LIMIT_MAX_ELAPSED_MS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const backoffFactor = opts.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = opts.sleep ?? abortableSleep;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const pacer = opts.pacer ?? providerPacer;
  const warn = opts.warn ?? ((message: string) => diagnostics.failure(
    'provider.rate_limited',
    new KinuError('unavailable', message),
  ));

  return asFetchFunction(async (input, init) => {
    if (!hasReplayableBody(input, init)) return fetchImpl(input, init);

    const host = providerHost(input);
    const signal = init?.signal ?? undefined;
    const startedAt = now();
    for (let attempt = 1; ; attempt++) {
      // THE LANE IS HELD ONLY WHILE THE REQUEST IS AWAITING HEADERS, which is the
      // same boundary Cloudflare's own connection budget frees at, and it is
      // released before any wait below: a request sleeping out a Retry-After must
      // not occupy capacity a sibling could be using. Streaming bodies are
      // untouched — five nodes still stream their answers in parallel.
      const release = await pacer.admit(host, signal);
      let response: Response;
      try {
        response = await fetchImpl(input, init);
      } finally {
        release();
      }
      if (!(await isRateLimited(response)) || attempt >= maxAttempts) return response;

      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now());
      const backoffCeilingMs = Math.min(
        maxDelayMs,
        baseDelayMs * backoffFactor ** (attempt - 1),
      );
      const waitMs = retryAfterMs ?? Math.floor(random() * backoffCeilingMs);
      const remainingMs = maxElapsedMs - (now() - startedAt);
      if (remainingMs <= 0 || waitMs >= remainingMs) return response;

      // DECLARED FIRST, then reported, then taken. The declaration is what the
      // watchdog reads and what every sibling request for this host now waits
      // behind, so it must be true before anyone can observe the silence it
      // explains.
      pacer.declareWait(host, waitMs);
      warn(
        `[kinu] ${host} rate-limited — waiting ${formatSeconds(waitMs)}s ` +
        `(attempt ${attempt}/${maxAttempts})`,
      );
      await sleep(waitMs, signal);
    }
  });
}

function hasReplayableBody(input: RequestInfo | URL, init: RequestInit | undefined): boolean {
  if (init?.body !== undefined) return v.safeParse(v.string(), init.body).success;
  return !(input instanceof Request) || input.body === null;
}

/**
 * Whether `response` is the provider saying "slow down".
 *
 * The 503 branch needs the body to decide, so a body it cannot read is not a
 * decision — it propagates. Reporting "not rate-limited" there would retire the
 * retry budget on the strength of an error nobody ever saw, and the SDK is
 * handed the same unreadable body a moment later regardless.
 */
async function isRateLimited(response: Response): Promise<boolean> {
  if (response.status === 429 || response.status === 529) return true;
  if (response.status !== 503) return false;
  const detail = [
    response.statusText,
    response.headers.get('x-error-code') ?? '',
    await response.clone().text(),
  ].join(' ');
  return /overload(?:ed|ing)?|\bcapacity\b|\btoo many requests\b|\brate[ _-]?limit/i.test(detail);
}

function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null || !value.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

function providerHost(input: RequestInfo | URL): string {
  const url = URL.parse(input instanceof Request ? input.url : input.toString());
  return url?.host || 'provider';
}

function formatSeconds(ms: number): string {
  return String(Math.ceil(ms / 1_000));
}
