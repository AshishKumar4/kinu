import { asFetchFunction } from './fetch-shim';
import * as v from 'valibot';
import { diagnostics, KinuError, toKinuError } from '../obs/index';
import { abortableSleep, providerPacer, type ProviderPacer } from './pacing';
import type { ProviderWaitInfo } from './types';


/** The SDK's own default transport retries, stated so a vendor update cannot move it silently. */
export const PROVIDER_SDK_RETRIES = 2;

/** Full-jitter backoff only when a 429 lacks `Retry-After`; attempts are unbounded.
 *  BASE and MAX are unmeasured. */
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
  /** Injectable for tests; defaults to the shared pacer. */
  pacer?: ProviderPacer;
  provider?: string;
  /** Absent for a count-endpoint wrapper. */
  modelId?: string;
  /** Called before each sleep, including joined pacer cooldowns; a throw is reported and ignored. */
  onWait?: (info: ProviderWaitInfo) => void;
}

/** Pace requests and follow the provider's Retry-After until success, definitive failure,
 *  or cancel; every wait is declared to the pacer so siblings share it. */
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

    const reportWait = (waitMs: number, attempt: number, source: ProviderWaitInfo['source'], status?: number): void => {
      if (opts.onWait === undefined) return;

      try {
        const info: ProviderWaitInfo = {
          provider: opts.provider ?? host,
          waitMs,
          attempt,
          source,
          ...(opts.modelId !== undefined && { modelId: opts.modelId }),
          ...(status !== undefined && { status }),
        };

        opts.onWait(info);
      } catch (cause) {
        diagnostics.failure('provider.wait_notify_failed', toKinuError({
          doing: 'reporting a provider wait',
          cause,
          otherwise: 'io',
        }));
      }
    };

    // Only announce cooldowns another request declared; this one's was already reported.
    const ownedCooldownUntil = { ms: 0 };

    for (let attempt = 1; ; attempt++) {
      await pacer.admit(host, signal, {
        onCooldown: (waitMs, untilMs) => {
          if (untilMs === ownedCooldownUntil.ms) return;

          reportWait(waitMs, 0, 'cooldown');
        },
      });

      const response = await fetchImpl(input, init);

      const limited = await rateLimitStatus(response);

      if (limited === null) return response;

      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now());

      const backoffCeilingMs = Math.min(
        maxDelayMs,
        baseDelayMs * backoffFactor ** Math.min(attempt - 1, 32),
      );

      const waitMs = retryAfterMs ?? Math.floor(random() * backoffCeilingMs);

      const untilMs = now() + waitMs;
      pacer.declareWait(host, waitMs);
      ownedCooldownUntil.ms = untilMs;
      warn(
        `[kinu] ${host} rate-limited — waiting ${formatSeconds(waitMs)}s `
        + `(attempt ${String(attempt)})`,
      );
      reportWait(waitMs, attempt, retryAfterMs !== null ? 'header' : 'backoff', limited);
      await sleep(waitMs, signal);
    }
  });
}

function hasReplayableBody(input: RequestInfo | URL, init: RequestInit | undefined): boolean {
  if (init?.body !== undefined) return v.safeParse(v.string(), init.body).success;

  return !(input instanceof Request) || input.body === null;
}

/** The rate-limit status, if any. An unreadable 503 body propagates rather than
 *  reading as "not rate-limited". */
async function rateLimitStatus(response: Response): Promise<number | null> {
  if (response.status === 429 || response.status === 529) return response.status;

  if (response.status !== 503) return null;

  const detail = [
    response.statusText,
    response.headers.get('x-error-code') ?? '',
    await response.clone().text(),
  ].join(' ');

  return /overload(?:ed|ing)?|\bcapacity\b|\btoo many requests\b|\brate[ _-]?limit/i.test(detail)
    ? response.status
    : null;
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

  // Blank host (data:, file:) is treated as unparseable.
  const host = url?.host;

  return host === undefined || host === '' ? 'provider' : host;
}

function formatSeconds(ms: number): string {
  return String(Math.ceil(ms / 1_000));
}
