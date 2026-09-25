import { APICallError } from 'ai';
import { asFetchFunction, copyHeaders } from './fetch-shim';
import * as v from 'valibot';
import { diagnostics, KinuError, tolerate, toKinuError } from '../obs/index';
import { fmtSpan } from '../utils/format';
import { abortableSleep, providerPacer, type ProviderPacer } from './pacing';
import type { ProviderWaitInfo } from './types';


/** The SDK's own default transport retries, stated so a vendor update cannot move it silently. */
export const PROVIDER_SDK_RETRIES = 2;

/** Full-jitter backoff when a 429 lacks `Retry-After`; BASE and MAX are unmeasured. */
const DEFAULT_BASE_DELAY_MS = 2_000;

const DEFAULT_BACKOFF_FACTOR = 2;

const DEFAULT_MAX_DELAY_MS = 60_000;

/** OMP's `maxRetryDelayMs` (oh-my-pi ai/src/types.ts:499). A longer Retry-After classifies the answer, not elapsed
 *  time: the account is spent until then. */
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

/** A chain call with a next model hands over on 429; never sent upstream. */
export const RATE_LIMIT_HANDOVER_HEADER = 'x-kinu-rate-limit-handover';

export interface RateLimitRetryOptions {
  baseDelayMs?: number;
  backoffFactor?: number;
  maxDelayMs?: number;
  maxRetryDelayMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
  warn?: (message: string) => void;
  pacer?: ProviderPacer;
  provider?: string;
  modelId?: string;
  /** Called before each sleep, including joined pacer cooldowns; a throw is reported and ignored. */
  onWait?: (info: ProviderWaitInfo) => void;
  lane?: string;
}

/** Follows a Retry-After up to a minute until success, failure or cancel; siblings share each declared wait. */
export function withRateLimitRetry(
  fetchImpl: typeof globalThis.fetch,
  opts: RateLimitRetryOptions = {},
): typeof globalThis.fetch {
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const backoffFactor = opts.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const maxRetryDelayMs = opts.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const sleep = opts.sleep ?? abortableSleep;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const pacer = opts.pacer ?? providerPacer;

  const warn = opts.warn ?? ((message: string) => diagnostics.failure(
    'provider.rate_limited',
    new KinuError('unavailable', message),
  ));

  return asFetchFunction(async (input, requested) => {
    const headers = copyHeaders(requested?.headers);
    const handover = headers.has(RATE_LIMIT_HANDOVER_HEADER);

    headers.delete(RATE_LIMIT_HANDOVER_HEADER);
    const init: RequestInit | undefined = handover ? { ...requested, headers } : requested;

    if (!hasReplayableBody(input, init)) return fetchImpl(input, init);

    const host = providerHost(input);
    const lane = opts.lane === undefined ? host : `${host} ${opts.lane}`;
    const signal = init?.signal ?? undefined;

    const handedOver = (status: number | null, resetsInMs: number | null): KinuError => new KinuError('unavailable',
      `${host} is rate-limiting this account${status === null ? '' : ` (HTTP ${String(status)})`}`
      + `${resetsInMs === null ? '' : `; it resets in ${fmtSpan(resetsInMs)}`}`);

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

    // Announce only cooldowns another request declared.
    const ownedCooldownUntil = { ms: 0 };

    for (let attempt = 1; ; attempt++) {
      await pacer.admit(lane, signal, {
        onCooldown: (waitMs, untilMs, reason) => {
          if (waitMs > maxRetryDelayMs) {
            throw waitTooLong({ input, provider: opts.provider ?? host, untilMs, nowMs: now(), longestMs: maxRetryDelayMs, reason });
          }

          if (handover) throw handedOver(null, waitMs);

          if (untilMs === ownedCooldownUntil.ms) return;

          reportWait(waitMs, 0, 'cooldown');
        },
      });

      const response = await fetchImpl(input, init);
      const limit = await rateLimitOf(response);

      if (limit === null) return response;

      if ('spent' in limit) throw allowanceSpent({ input, response, body: limit.body, host, exhausted: limit.spent });

      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now());

      if (retryAfterMs !== null && retryAfterMs > maxRetryDelayMs) {
        const reason = providerMessage({ body: limit.body });
        const untilMs = now() + retryAfterMs;

        pacer.declareWait(lane, retryAfterMs, reason);

        throw waitTooLong({
          input, provider: opts.provider ?? host, untilMs, nowMs: now(), longestMs: maxRetryDelayMs, reason, status: limit.status, response,
        });
      }

      const backoffCeilingMs = Math.min(
        maxDelayMs,
        baseDelayMs * backoffFactor ** Math.min(attempt - 1, 32),
      );

      const waitMs = retryAfterMs ?? Math.floor(random() * backoffCeilingMs);

      const untilMs = now() + waitMs;
      pacer.declareWait(lane, waitMs);

      if (handover) throw handedOver(limit.status, retryAfterMs);
      ownedCooldownUntil.ms = untilMs;
      warn(
        `[kinu] ${host} rate-limited — waiting ${fmtSpan(waitMs)} `
        + `(attempt ${String(attempt)})`,
      );
      reportWait(waitMs, attempt, retryAfterMs !== null ? 'header' : 'backoff', limit.status);
      await sleep(waitMs, signal);
    }
  });
}

function hasReplayableBody(input: RequestInfo | URL, init: RequestInit | undefined): boolean {
  if (init?.body !== undefined) return v.safeParse(v.string(), init.body).success;

  return !(input instanceof Request) || input.body === null;
}

/** A limit to wait out, a spent allowance, or null; an unreadable limited body propagates. */
async function rateLimitOf(response: Response): Promise<{ status: number; body: string } | { spent: ExhaustedAllowance; body: string } | null> {
  const { status } = response;

  if (status !== 429 && status !== 503 && status !== 529) return null;
  const body = await response.clone().text();

  if (status === 529) return { status, body };

  if (status === 429) {
    const spent = exhaustedAllowance({ body });

    return spent === null ? { status, body } : { spent, body };
  }

  const detail = [response.statusText, response.headers.get('x-error-code') ?? '', body].join(' ');

  return /overload(?:ed|ing)?|\bcapacity\b|\btoo many requests\b|\brate[ _-]?limit/i.test(detail) ? { status, body } : null;
}

const ExhaustedAllowanceCodeSchema = v.picklist([
  'insufficient_quota',
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'usage_limit_reached',
  'usage_not_included',
  'enforced_spend_limit_reached',
  'quota_exceeded',
]);

const WORKERS_AI_DAILY_ALLOCATION = 3036;

const ErrorCodeSchema = v.union([v.string(), v.number()]);

const ProviderErrorSchema = v.looseObject({
  code: v.optional(ErrorCodeSchema),
  type: v.optional(v.string()),
  status: v.optional(v.string()),
  message: v.optional(v.string()),
  details: v.optional(v.unknown()),
  metadata: v.optional(v.looseObject({ provider_code: v.optional(v.string()) })),
});

const ErrorEnvelopeSchema = v.looseObject({
  error: v.optional(ProviderErrorSchema),
  errors: v.optional(v.array(v.looseObject({ code: v.optional(ErrorCodeSchema), message: v.optional(v.string()) }))),
});

const AnthropicErrorDetailsSchema = v.looseObject({ error_code: v.string() });

const QuotaFailureSchema = v.looseObject({
  violations: v.array(v.looseObject({ quotaId: v.optional(v.string()), quotaValue: v.optional(v.string()) })),
});

interface ExhaustedAllowance {
  readonly marker: string;
  readonly message: string | undefined;
}

function exhaustedAllowance(input: { body: string }): ExhaustedAllowance | null {
  const decoded = tolerate<unknown>(() => JSON.parse(input.body), 'malformed-input');
  const unwrapped = v.safeParse(v.tuple([v.unknown()]), decoded);
  const envelope = v.safeParse(ErrorEnvelopeSchema, unwrapped.success ? unwrapped.output[0] : decoded);

  if (!envelope.success) return null;
  const { error, errors } = envelope.output;
  const allocation = errors?.find((entry) => entry.code === WORKERS_AI_DAILY_ALLOCATION);

  if (allocation !== undefined) return { marker: String(WORKERS_AI_DAILY_ALLOCATION), message: allocation.message };

  if (error === undefined) return null;
  const anthropic = v.safeParse(AnthropicErrorDetailsSchema, error.details);

  const named = [error.code, error.type, anthropic.success ? anthropic.output.error_code : undefined, error.metadata?.provider_code]
    .find((field) => field === WORKERS_AI_DAILY_ALLOCATION || v.is(ExhaustedAllowanceCodeSchema, field));

  if (named !== undefined) return { marker: String(named), message: error.message };

  return error.status === 'RESOURCE_EXHAUSTED' && spentQuota({ details: error.details })
    ? { marker: error.status, message: error.message }
    : null;
}

function spentQuota(input: { details: unknown }): boolean {
  const details = v.safeParse(v.array(v.unknown()), input.details);

  return details.success && details.output.some((detail) => {
    const failure = v.safeParse(QuotaFailureSchema, detail);

    return failure.success && failure.output.violations.some(
      (violation) => violation.quotaValue === '0' || (violation.quotaId?.includes('PerDay') ?? false),
    );
  });
}

function allowanceSpent(input: {
  input: RequestInfo | URL;
  response: Response;
  body: string;
  host: string;
  exhausted: ExhaustedAllowance;
}): APICallError {
  const { marker, message } = input.exhausted;

  return new APICallError({
    message: message ?? `HTTP 429 (${marker})`,
    url: input.input instanceof Request ? input.input.url : input.input.toString(),
    requestBodyValues: undefined,
    statusCode: 429,
    responseHeaders: Object.fromEntries(input.response.headers),
    responseBody: input.body,
    isRetryable: false,
    cause: new KinuError(
      'budget',
      `${input.host} answered HTTP 429 ${marker}: the account's quota or spend limit is used up, `
        + 'and waiting does not restore it',
    ),
  });
}

function providerMessage(input: { body: string }): string | undefined {
  const decoded = tolerate<unknown>(() => JSON.parse(input.body), 'malformed-input');
  const envelope = v.safeParse(ErrorEnvelopeSchema, decoded);

  if (envelope.success) return envelope.output.error?.message ?? envelope.output.errors?.[0]?.message;
  const text = input.body.trim();

  return decoded === undefined && text !== '' && text.length <= 300 ? text : undefined;
}

function waitTooLong(input: {
  input: RequestInfo | URL;
  provider: string;
  untilMs: number;
  nowMs: number;
  longestMs: number;
  reason: string | undefined;
  status?: number;
  response?: Response;
}): APICallError {
  const resetsAt = `${new Date(input.untilMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

  return new APICallError({
    message: `${input.provider} is rate-limited until ${resetsAt} (in ${fmtSpan(input.untilMs - input.nowMs)})`
      + `${input.reason === undefined ? '' : `: ${input.reason}`}`,
    url: input.input instanceof Request ? input.input.url : input.input.toString(),
    requestBodyValues: undefined,
    ...(input.status !== undefined && { statusCode: input.status }),
    ...(input.response !== undefined && { responseHeaders: Object.fromEntries(input.response.headers) }),
    isRetryable: false,
    cause: new KinuError(
      'budget',
      `${input.provider} declared a wait until ${resetsAt}, past the ${fmtSpan(input.longestMs)} a call waits`,
    ),
  });
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
