import { asFetchFunction } from './fetch-shim';
import * as v from 'valibot';
import { diagnostics, ProteusError } from '../obs/index';

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_MAX_ELAPSED_MS = 180_000;
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
}

/**
 * Add patient rate-limit handling at a model provider's HTTP boundary.
 * Responses are returned unchanged when the retry budget is exhausted so the
 * provider SDK retains ownership of its normal error and outer-retry shape.
 */
export function withRateLimitRetry(
  fetchImpl: typeof globalThis.fetch,
  opts: RateLimitRetryOptions = {},
): typeof globalThis.fetch {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxElapsedMs = opts.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const backoffFactor = opts.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = opts.sleep ?? abortableSleep;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const warn = opts.warn ?? ((message: string) => diagnostics.failure(
    'provider.rate_limited',
    new ProteusError('unavailable', message),
  ));

  return asFetchFunction(async (input, init) => {
    if (!hasReplayableBody(input, init)) return fetchImpl(input, init);

    const startedAt = now();
    for (let attempt = 1; ; attempt++) {
      const response = await fetchImpl(input, init);
      if (!(await isRateLimited(response)) || attempt >= maxAttempts) return response;

      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now());
      const backoffCeilingMs = Math.min(
        maxDelayMs,
        baseDelayMs * backoffFactor ** (attempt - 1),
      );
      const waitMs = retryAfterMs ?? Math.floor(random() * backoffCeilingMs);
      const remainingMs = maxElapsedMs - (now() - startedAt);
      if (remainingMs <= 0 || waitMs >= remainingMs) return response;

      warn(
        `[proteus] ${providerHost(input)} rate-limited — waiting ${formatSeconds(waitMs)}s ` +
        `(attempt ${attempt}/${maxAttempts})`,
      );
      await sleep(waitMs, init?.signal ?? undefined);
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

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
