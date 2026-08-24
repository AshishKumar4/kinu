import { asFetchFunction } from './fetch-shim';
import * as v from 'valibot';
import { diagnostics, KinuError } from '../obs/index';
import { abortableSleep, providerPacer, type ProviderPacer } from './pacing';


/**
 * How many times the AI SDK may re-issue a model request under its transport
 * policy. The value is the SDK's own default, stated explicitly at `streamText`
 * so a vendor update cannot move it in silence. This is not an elapsed-time
 * retry: the chat loop never re-issues a call because time passed.
 */
export const PROVIDER_SDK_RETRIES = 2;

const DEFAULT_BASE_DELAY_MS = 2_000;
const DEFAULT_BACKOFF_FACTOR = 2;
const DEFAULT_MAX_DELAY_MS = 60_000;

export interface RateLimitRetryOptions {
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
 * the requests that reach it. A rate-limited request keeps following the
 * provider's Retry-After responses until it succeeds, fails definitively, or
 * the caller cancels it. Elapsed time and attempt count never terminate it.
 *
 * TWO THINGS BEYOND RETRYING, both because the provider is SHARED (see
 * `pacing.ts` for the incident):
 *
 *   - Every attempt goes out through {@link ProviderPacer.admit}, which spaces
 *     request STARTS against one host and holds each caller behind any wait the
 *     provider has already mandated. A whole swarm level starting at once used to
 *     arrive as N simultaneous first requests on one credential.
   *   - Every wait is declared before it is taken, so every sibling request for
   *     this host respects the same provider-mandated cooldown.
 */
export function withRateLimitRetry(
  fetchImpl: typeof globalThis.fetch,
  opts: RateLimitRetryOptions = {},
): typeof globalThis.fetch {
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
      if (!(await isRateLimited(response))) return response;

      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now());
      const backoffCeilingMs = Math.min(
        maxDelayMs,
        baseDelayMs * backoffFactor ** Math.min(attempt - 1, 32),
      );
      const waitMs = retryAfterMs ?? Math.floor(random() * backoffCeilingMs);

      // Declare the provider cooldown before this request sleeps so siblings
      // join the same wait rather than starting another request immediately.
      pacer.declareWait(host, waitMs);
      warn(
        `[kinu] ${host} rate-limited — waiting ${formatSeconds(waitMs)}s `
        + `(attempt ${String(attempt)})`,
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
