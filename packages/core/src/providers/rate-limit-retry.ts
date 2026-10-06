import { APICallError } from 'ai';
import { asFetchFunction, copyHeaders } from './fetch-shim';
import * as v from 'valibot';
import { Effect } from 'effect';
import { diagnostics, KinuError, settle, settleSync, tolerate, toKinuError } from '../obs/index';
import { fmtSpan } from '../utils/format';
import { abortableSleep, providerPacer, type ProviderPacer } from './pacing';
import { retryAfterOf } from './fallback-cooldown';
import type { ProviderWaitInfo } from './types';
import { silenceBoundMs } from '../platform-catalog';
import { DEFAULT_PROVIDER_RETRIES } from '../types/profile';

/** Full-jitter backoff; unmeasured. */
const BASE_DELAY_MS = 2_000;

const BACKOFF_FACTOR = 2;

const MAX_DELAY_MS = 60_000;

/** OMP's `maxRetryDelayMs` (oh-my-pi ai/src/types.ts:499); a longer Retry-After means the account is spent. */
const MAX_RETRY_DELAY_MS = 60_000;

/** This call's retries; never sent upstream. */
export const PROVIDER_RETRIES_HEADER = 'x-kinu-retries';

/** Set by the call that streams, so the silence bound applies without parsing the request; never sent upstream. */
export const PROVIDER_STREAM_HEADER = 'x-kinu-stream';

/** What a provider that rebuilds a request keeps of the caller's: its retry allowance and its cancel. */
export interface TransportControls {
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal | null;
}

export function transportControls(requested: Pick<RequestInit, 'headers' | 'signal'> | undefined): TransportControls {
  const given = copyHeaders(requested?.headers);

  const kept = [PROVIDER_RETRIES_HEADER, PROVIDER_STREAM_HEADER].flatMap((name) => {
    const value = given.get(name);

    return value === null ? [] : [[name, value] as const];
  });

  return { headers: Object.fromEntries(kept), signal: requested?.signal ?? null };
}

export interface RateLimitRetryOptions {
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
  const sleep = opts.sleep ?? abortableSleep;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const pacer = opts.pacer ?? providerPacer;

  const warn = opts.warn ?? ((message: string) => diagnostics.failure(
    'provider.rate_limited',
    new KinuError('unavailable', message),
  ));

  return asFetchFunction((input, requested) => settle(Effect.gen(function* () {
      const headers = copyHeaders(requested?.headers);
      const stated = headers.get(PROVIDER_RETRIES_HEADER);
      const retries = stated === null ? DEFAULT_PROVIDER_RETRIES : Number(stated);
      const streams = headers.get(PROVIDER_STREAM_HEADER) !== null;

      headers.delete(PROVIDER_RETRIES_HEADER);
      headers.delete(PROVIDER_STREAM_HEADER);
      const init: RequestInit | undefined = stated === null && !streams ? requested : { ...requested, headers };

      if (!hasReplayableBody(input, init)) return yield* Effect.promise(() => fetchImpl(input, init));

      const host = providerHost(input);
      const lane = opts.lane === undefined ? host : `${host} ${opts.lane}`;
      const signal = init?.signal ?? undefined;

      const stalled = (): APICallError => new APICallError({
        message: `${opts.provider ?? host} sent nothing for ${fmtSpan(silenceBoundMs('provider.stream.idle_ms'))}`,
        url: input instanceof Request ? input.url : input.toString(),
        requestBodyValues: undefined,
        isRetryable: false,
        cause: new KinuError('timeout', `the ${opts.provider ?? host} stream stalled`),
      });

      const handedOver = (status: number | null, resetsInMs: number | null): APICallError => new APICallError({
        message: `${host} is rate-limiting this account${status === null ? '' : ` (HTTP ${String(status)})`}`
          + `${resetsInMs === null ? '' : `; it resets in ${fmtSpan(resetsInMs)}`}`,
        url: input instanceof Request ? input.url : input.toString(),
        requestBodyValues: undefined,
        ...(status !== null && { statusCode: status }),
        ...(resetsInMs !== null && { responseHeaders: { 'retry-after-ms': String(resetsInMs) } }),
        isRetryable: false,
      });

      const reportWait = (waitMs: number, attempt: number, source: ProviderWaitInfo['source'], status?: number): Effect.Effect<void> => {
        const onWait = opts.onWait;

        if (onWait === undefined) return Effect.void;

        const info: ProviderWaitInfo = {
          provider: opts.provider ?? host,
          waitMs,
          attempt,
          source,
          ...(opts.modelId !== undefined && { modelId: opts.modelId }),
          ...(status !== undefined && { status }),
        };

        return Effect.try({
          try: () => onWait(info),
          catch: (cause) => toKinuError({ doing: 'reporting a provider wait', cause, otherwise: 'io' }),
        }).pipe(Effect.catch((failure) => Effect.sync(() => diagnostics.failure('provider.wait_notify_failed', failure))));
      };

      // Announce only cooldowns another request declared.
      let owned: number | null = null;
      let waits = 0;

      const spendRetry = (spent: () => APICallError): Effect.Effect<void> => Effect.suspend(() => (++waits > retries ? Effect.die(spent()) : Effect.void));

      for (let attempt = 1; ; attempt++) {
          yield* Effect.promise(() => pacer.admit(lane, signal, {
          onCooldown: (waitMs, untilMs, reason) => settleSync(Effect.gen(function* () {
            if (waitMs > MAX_RETRY_DELAY_MS) {
              return yield* Effect.die(waitTooLong({ input, provider: opts.provider ?? host, untilMs, nowMs: now(), longestMs: MAX_RETRY_DELAY_MS, reason }));
            }

            if (untilMs === owned) return;

            // A chain entry takes a call with no retries.
            if (retries === 0) return yield* Effect.die(handedOver(null, waitMs));

            yield* reportWait(waitMs, 0, 'cooldown');
          })),
        }));

        const reading = streams ? new LiveStream(stalled) : UNTIMED;
        const response = yield* Effect.promise(() => reading.open(fetchImpl, input, init));
        const limit = response === null ? null : yield* Effect.promise(() => rateLimitOf(response));
        const read = response !== null && limit === null ? yield* Effect.promise(() => reading.body(response, waits >= retries)) : 'stall';

        if (read instanceof Response) return read;

        if (response === null || limit === null) {
          yield* spendRetry(stalled);
          const waitMs = Math.floor(random() * backoffCeiling(attempt));

          yield* reportWait(waitMs, attempt, read);
          yield* Effect.promise(() => sleep(waitMs, signal));
          continue;
        }

        if ('spent' in limit) return yield* Effect.die(allowanceSpent({ input, response, body: limit.body, host, exhausted: limit.spent }));

        const retryAfter = retryAfterOf(response.headers, now());

        if (retryAfter !== null && retryAfter > MAX_RETRY_DELAY_MS) {
          const reason = providerMessage({ body: limit.body });
          const untilMs = now() + retryAfter;

          pacer.declareWait(lane, retryAfter, reason);

          return yield* Effect.die(waitTooLong({
            input, provider: opts.provider ?? host, untilMs, nowMs: now(), longestMs: MAX_RETRY_DELAY_MS, reason, status: limit.status, response,
          }));
        }

        const waitMs = retryAfter ?? Math.floor(random() * backoffCeiling(attempt));

        const declared = pacer.declareWait(lane, waitMs);

        yield* spendRetry(() => handedOver(limit.status, retryAfter ?? waitMs));
        owned = declared;
        warn(
          `[kinu] ${host} rate-limited: waiting ${fmtSpan(waitMs)} `
          + `(attempt ${String(attempt)})`,
        );
        yield* reportWait(waitMs, attempt, retryAfter !== null ? 'header' : 'backoff', limit.status);
        yield* Effect.promise(() => sleep(waitMs, signal));
      }
  })));
}

function backoffCeiling(attempt: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * BACKOFF_FACTOR ** Math.min(attempt - 1, 32));
}

/** Null: silent before a byte. `body`: the answer, or the wait when silent or erring first (OpenRouter errs under
 *  HTTP 200) and not `last`. */
interface AttemptReading {
  open(fetchImpl: typeof globalThis.fetch, input: RequestInfo | URL, init: RequestInit | undefined): Promise<Response | null>;
  body(response: Response, last: boolean): Promise<Response | 'stall' | 'backoff'>;
}

const UNTIMED: AttemptReading = {
  open: (fetchImpl, input, init) => fetchImpl(input, init),
  body: async (response) => response,
};

class LiveStream implements AttemptReading {
  private readonly cut = new AbortController();

  constructor(private readonly stalled: () => APICallError) {}

  open(fetchImpl: typeof globalThis.fetch, input: RequestInfo | URL, init: RequestInit | undefined): Promise<Response | null> {
    const own = init?.signal ?? undefined;

    return this.within(fetchImpl(input, { ...init, signal: own === undefined ? this.cut.signal : AbortSignal.any([own, this.cut.signal]) }));
  }

  async body(response: Response, last: boolean): Promise<Response | 'stall' | 'backoff'> {
    if (response.body === null) return response;
    const reader = response.body.getReader();
    const events = response.headers.get('content-type')?.startsWith('text/event-stream') === true;
    const decoder = new TextDecoder();
    const held: Uint8Array[] = [];
    let text = '';
    let first: SseEvent | null = null;
    let ended: { readonly reason: unknown } | 'closed' | null = null;

    while (first === null && ended === null) {
      const [read] = await this.within(Promise.allSettled([reader.read()])) ?? [];

      if (read === undefined) {
        await reader.cancel();

        return 'stall';
      }

      if (read.status === 'rejected') ended = { reason: read.reason };
      else if (read.value.done) ended = 'closed';
      else {
        held.push(read.value.value);
        text += decoder.decode(read.value.value, { stream: true });
        first = events ? firstSseEvent(text) : 'output';
      }
    }

    if (first === 'error' && !last) {
      await reader.cancel();

      return 'backoff';
    }

    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const chunk of held) controller.enqueue(chunk);

        if (ended === 'closed') controller.close();
        else if (ended !== null) controller.error(ended.reason);
      },
      pull: async (controller) => {
        const next = await this.within(reader.read());

        if (next === null) controller.error(this.stalled());
        else if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel: (reason) => reader.cancel(reason),
    });

    return new Response(body, response);
  }

  /** Null once silent; cuts the call. */
  private within<T>(work: Promise<T>): Promise<T | null> {
    const stall = Promise.withResolvers<null>();

    const timer = setTimeout(() => {
      this.cut.abort(this.stalled());
      stall.resolve(null);
    }, silenceBoundMs('provider.stream.idle_ms'));

    return Promise.race([work, stall.promise]).finally(() => { clearTimeout(timer); });
  }
}

type SseEvent = 'error' | 'output';

function firstSseEvent(text: string): SseEvent | null {
  const whole = text.split(/\r\n\r\n|\n\n|\r\r/).slice(0, -1);

  for (const event of whole) {
    const lines = event.split(/\r\n|\n|\r/).filter((line) => line !== '' && !line.startsWith(':'));

    const field = (name: string): string[] => lines
      .filter((line) => line.startsWith(`${name}:`))
      .map((line) => line.slice(name.length + 1).replace(/^ /, ''));

    if (lines.length === 0) continue;

    if (field('event').includes('error')) return 'error';
    const data = tolerate<unknown>(() => JSON.parse(field('data').join('\n')), 'malformed-input');

    return v.is(SseErrorSchema, data) ? 'error' : 'output';
  }

  return null;
}

const SseErrorSchema = v.union([
  v.looseObject({ error: v.looseObject({}) }),
  v.looseObject({ type: v.literal('error') }),
]);

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

  return /overload(?:ed|ing)?|\bcapacity\b|\btoo many requests\b|\brate[ _-]?limit|subscription_sharing_(?:usage|user)_unavailable/i.test(detail) ? { status, body } : null;
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

function providerHost(input: RequestInfo | URL): string {
  const url = URL.parse(input instanceof Request ? input.url : input.toString());

  // Blank host (data:, file:) is treated as unparseable.
  const host = url?.host;

  return host === undefined || host === '' ? 'provider' : host;
}
