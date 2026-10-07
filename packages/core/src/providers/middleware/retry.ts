/**
 * Every model's retry, once: a stated Retry-After is waited out up to a minute and shared with the lane's other calls,
 * an opening error or a silent attempt is backed off, and a call with no retries left hands over to the fallback chain.
 * A stream is bounded by silence, never by duration: each provider event, keepalives included, resets the bound.
 */
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart, LanguageModelV4StreamResult, SharedV4ProviderOptions } from '@ai-sdk/provider';
import { APICallError, type LanguageModelMiddleware } from 'ai';
import { Effect } from 'effect';
import * as v from 'valibot';
import { detach, diagnostics, KinuError, settle, tolerate, toKinuError } from '../../obs/index';
import { silenceBoundMs } from '../../platform-catalog';
import { DEFAULT_PROVIDER_RETRIES } from '../../types/profile';
import { fmtSpan } from '../../utils/format';
import { retryAfterOf } from '../fallback-cooldown';
import { abortableSleep, providerPacer, type ProviderPacer } from '../pacing';
import type { ProviderWaitInfo } from '../types';

/** Full-jitter backoff; unmeasured. */
const BASE_DELAY_MS = 2_000;

const BACKOFF_FACTOR = 2;

const MAX_DELAY_MS = 60_000;

/** OMP's `maxRetryDelayMs` (oh-my-pi ai/src/types.ts:499); a longer Retry-After means the account is spent. */
const MAX_RETRY_DELAY_MS = 60_000;

export interface RetryPolicy {
  /** Named in wait notices and refusals. */
  readonly provider: string;
  readonly modelId?: string;
  /** Calls on one lane (a provider and the account it bills) share each declared wait. */
  readonly lane: string;
  /** Called before each sleep, including joined cooldowns; a throw is reported and ignored. */
  readonly onWait?: (info: ProviderWaitInfo) => void;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly warn?: (message: string) => void;
  readonly pacer?: ProviderPacer;
}

/** Kinu's own call options, which no provider reads: `retries` is the call's, `raw` whether its caller asked for raw
 *  events, which this layer always asks for so that silence is measured per event. */
const KinuOptionsSchema = v.looseObject({ kinu: v.optional(v.looseObject({ retries: v.optional(v.number()), raw: v.optional(v.boolean()) })) });

/** A call's own retries, as `providerOptions`; a chain entry takes a call with none. */
export function callRetries(retries: number): SharedV4ProviderOptions {
  return { kinu: { retries } };
}

interface KinuOptions {
  readonly retries: number;
  readonly raw: boolean;
}

function kinuOptions(params: LanguageModelV4CallOptions): KinuOptions {
  const stated = v.safeParse(KinuOptionsSchema, params.providerOptions ?? {});
  const kinu = stated.success ? stated.output.kinu : undefined;

  return { retries: kinu?.retries ?? DEFAULT_PROVIDER_RETRIES, raw: kinu?.raw ?? false };
}

type Opened<T> =
  | { readonly kind: 'answer'; readonly value: T }
  | { readonly kind: 'stall' | 'backoff' };

/** One call to the provider; `last` once no retry is left. */
type Open<T> = (last: boolean) => Promise<Opened<T>>;

export function retryMiddleware(policy: RetryPolicy): LanguageModelMiddleware {
  return {
    specificationVersion: 'v4',
    transformParams: async ({ params }) => ({
      ...params,
      includeRawChunks: true,
      providerOptions: { ...params.providerOptions, kinu: { ...params.providerOptions?.kinu, raw: params.includeRawChunks === true } },
    }),
    wrapGenerate: ({ doGenerate, params }) => settle(retrying(policy, params, async () => ({ kind: 'answer', value: await doGenerate() }))),
    wrapStream: ({ doStream, params }) => settle(retrying(policy, params, (last) => openStream({
      provider: policy.provider, opening: doStream(), last, keepRaw: kinuOptions(params).raw,
    }))),
  };
}

function retrying<T>(policy: RetryPolicy, params: LanguageModelV4CallOptions, open: Open<T>): Effect.Effect<T, KinuError> {
  const sleep = policy.sleep ?? abortableSleep;
  const now = policy.now ?? Date.now;
  const random = policy.random ?? Math.random;
  const pacer = policy.pacer ?? providerPacer;
  const signal = params.abortSignal;
  const { retries } = kinuOptions(params);

  const warn = policy.warn ?? ((message: string) => diagnostics.failure('provider.rate_limited', new KinuError('unavailable', message)));

  const reportWait = (waitMs: number, attemptNumber: number, source: ProviderWaitInfo['source'], status?: number): Effect.Effect<void> => {
    const onWait = policy.onWait;

    if (onWait === undefined) return Effect.void;

    const info: ProviderWaitInfo = {
      provider: policy.provider, waitMs, attempt: attemptNumber, source,
      ...(policy.modelId !== undefined && { modelId: policy.modelId }),
      ...(status !== undefined && { status }),
    };

    return Effect.try({
      try: () => onWait(info),
      catch: (cause) => toKinuError({ doing: 'reporting a provider wait', cause, otherwise: 'io' }),
    }).pipe(Effect.catch((failure) => Effect.sync(() => diagnostics.failure('provider.wait_notify_failed', failure))));
  };

  return Effect.gen(function* () {
    let owned: number | null = null;
    let waits = 0;

    const spendRetry = (spent: () => APICallError): Effect.Effect<void> => Effect.suspend(() => (++waits > retries ? Effect.die(spent()) : Effect.void));

    for (let attemptNumber = 1; ; attemptNumber++) {
      // The lane's cooldown first, re-read after each wait: a sibling may extend it.
      for (let cooling = pacer.cooling(policy.lane); cooling !== null; cooling = pacer.cooling(policy.lane)) {
        if (signal?.aborted === true) return yield* Effect.die(signal.reason);
        const { waitMs, untilMs, reason } = cooling;

        if (waitMs > MAX_RETRY_DELAY_MS) return yield* Effect.die(waitTooLong({ provider: policy.provider, untilMs, nowMs: now(), reason }));

        // Announce only cooldowns another call declared.
        if (untilMs !== owned) {
          if (retries === 0) return yield* Effect.die(handedOver({ provider: policy.provider, status: null, resetsInMs: waitMs }));
          yield* reportWait(waitMs, 0, 'cooldown');
        }

        yield* Effect.promise(() => pacer.pause(waitMs, signal));
      }

      const [opened] = yield* Effect.promise(() => Promise.allSettled([open(waits >= retries)]));

      if (opened.status === 'fulfilled') {
        const outcome = opened.value;

        if (outcome.kind === 'answer') return outcome.value;
        yield* spendRetry(() => stalled(policy.provider));
        const waitMs = Math.floor(random() * backoffCeiling(attemptNumber));

        yield* reportWait(waitMs, attemptNumber, outcome.kind);
        yield* Effect.promise(() => sleep(waitMs, signal));
        continue;
      }

      const failure: unknown = opened.reason;

      if (!APICallError.isInstance(failure) || !failure.isRetryable) return yield* Effect.die(failure);
      const limit = rateLimitOf(failure);

      const retryAfter = retryAfterOf(new Headers(failure.responseHeaders ?? {}), now());

      if (limit === null) {
        yield* spendRetry(() => final(failure));
        const stated = retryAfter !== null && retryAfter <= MAX_RETRY_DELAY_MS;
        const waitMs = stated ? retryAfter : Math.floor(random() * backoffCeiling(attemptNumber));

        yield* reportWait(waitMs, attemptNumber, stated ? 'header' : 'backoff', failure.statusCode);
        yield* Effect.promise(() => sleep(waitMs, signal));
        continue;
      }

      if (limit.spent !== null) return yield* Effect.die(allowanceSpent(failure, limit.spent));

      if (retryAfter !== null && retryAfter > MAX_RETRY_DELAY_MS) {
        pacer.declareWait(policy.lane, retryAfter, providerMessage(failure.responseBody ?? ''));

        return yield* Effect.die(waitTooLong({
          provider: policy.provider, untilMs: now() + retryAfter, nowMs: now(), reason: providerMessage(failure.responseBody ?? ''), failure,
        }));
      }

      const waitMs = retryAfter ?? Math.floor(random() * backoffCeiling(attemptNumber));
      const declared = pacer.declareWait(policy.lane, waitMs);

      yield* spendRetry(() => handedOver({ provider: policy.provider, status: limit.status, resetsInMs: retryAfter ?? waitMs }));
      owned = declared;
      warn(`[kinu] ${policy.provider} rate-limited: waiting ${fmtSpan(waitMs)} (attempt ${String(attemptNumber)})`);
      yield* reportWait(waitMs, attemptNumber, retryAfter !== null ? 'header' : 'backoff', limit.status);
      yield* Effect.promise(() => sleep(waitMs, signal));
    }
  });
}

function backoffCeiling(attempt: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * BACKOFF_FACTOR ** Math.min(attempt - 1, 32));
}

interface StreamAttempt {
  readonly provider: string;
  readonly opening: PromiseLike<LanguageModelV4StreamResult>;
  readonly last: boolean;
  readonly keepRaw: boolean;
}

/** The first event decides: an error opens a backoff unless no retry is left; anything else is the answer, still read
 *  under the bound. Silence before it is a stall: an attempt silent before its answer is abandoned, and its stream
 *  cancelled if it ever arrives (a middleware cannot re-sign a call with an abort of its own). */
async function openStream(attempt: StreamAttempt): Promise<Opened<LanguageModelV4StreamResult>> {
  const started = Date.now();
  const opening = Promise.resolve(attempt.opening);
  const silent = Promise.withResolvers<null>();
  const bound = new SilenceBound(attempt.provider, async () => { silent.resolve(null); });
  const opened = await Promise.race([opening, silent.promise]);

  if (opened === null) {
    await abandoned(opening.then((late) => late.stream.cancel()));

    return { kind: 'stall' };
  }

  // The answer's headers are in: its body is the provider's to send.
  diagnostics.event('provider.stream_opened', { provider: attempt.provider, ms: Date.now() - started });
  const parts = partsOf(opened.stream);
  const held: LanguageModelV4StreamPart[] = [];

  bound.onSilence(() => parts.cancel());

  for (;;) {
    const [read] = await Promise.allSettled([parts.read()]);

    if (bound.fired) return { kind: 'stall' };
    bound.hear();

    if (read.status === 'rejected') return answered(opened, { bound, parts, held, keepRaw: attempt.keepRaw, ended: { reason: read.reason } });

    if (read.value === 'end') return answered(opened, { bound, parts, held, keepRaw: attempt.keepRaw, ended: 'closed' });
    const part = read.value;

    held.push(part);

    if (part.type === 'stream-start' || part.type === 'raw') continue;

    if (part.type === 'error' && !attempt.last) {
      bound.stop();
      await abandoned(parts.cancel());

      return { kind: 'backoff' };
    }

    return answered(opened, { bound, parts, held, keepRaw: attempt.keepRaw, ended: null });
  }
}

/** A stream's parts one at a time, then `end`. */
interface Parts {
  read(): Promise<LanguageModelV4StreamPart | 'end'>;
  cancel(): Promise<void>;
}

function partsOf(stream: ReadableStream<LanguageModelV4StreamPart>): Parts {
  const reader = stream.getReader();

  return {
    read: async () => {
      const next = await reader.read();

      return next.done ? 'end' : next.value;
    },
    cancel: () => reader.cancel(),
  };
}

/** A cancel through the SDK's pipes waits on a read the silent provider never answers: it is started, not waited for. */
async function abandoned(cancelling: Promise<void>): Promise<void> {
  await Promise.race([Promise.allSettled([cancelling]), Promise.resolve()]);
}

type Ended = { readonly reason: unknown } | 'closed' | null;

interface LiveStream {
  readonly bound: SilenceBound;
  readonly parts: Parts;
  readonly held: readonly LanguageModelV4StreamPart[];
  readonly keepRaw: boolean;
  readonly ended: Ended;
}

/** The answer's parts, the held ones first, raw events dropped unless the caller asked for them; a silence past the
 *  bound errors it and cancels the provider's stream. */
function answered(opened: LanguageModelV4StreamResult, live: LiveStream): Opened<LanguageModelV4StreamResult> {
  const { bound, parts, held, keepRaw, ended } = live;
  const shown = (part: LanguageModelV4StreamPart): boolean => keepRaw || part.type !== 'raw';

  const stream = new ReadableStream<LanguageModelV4StreamPart>({
    start: (controller) => {
      bound.onSilence(async () => {
        controller.error(bound.failure);
        await parts.cancel();
      });

      for (const part of held.filter(shown)) controller.enqueue(part);

      if (ended !== null) bound.stop();

      if (ended === 'closed') controller.close();
      else if (ended !== null) controller.error(ended.reason);
    },
    pull: async (controller) => {
      for (;;) {
        const next = await parts.read();

        if (bound.fired) return;
        bound.hear();

        if (next === 'end') {
          bound.stop();

          return controller.close();
        }

        if (shown(next)) return controller.enqueue(next);
      }
    },
    cancel: () => {
      bound.stop();

      return parts.cancel();
    },
  });

  return { kind: 'answer', value: { ...opened, stream } };
}

/** One timer per attempt, not one per event: each event only moves `heard`, and the timer, when it fires, waits again
 *  for what is left of the bound or declares the silence. */
class SilenceBound {
  fired = false;
  readonly failure: APICallError;
  private heard = Date.now();
  private silenced: () => Promise<void>;
  private timer: ReturnType<typeof setTimeout>;

  constructor(provider: string, silenced: () => Promise<void>) {
    this.silenced = silenced;
    this.failure = stalled(provider);
    this.timer = this.arm(silenceBoundMs('provider.stream.idle_ms'));
  }

  hear(): void {
    this.heard = Date.now();
  }

  onSilence(silenced: () => Promise<void>): void {
    this.silenced = silenced;
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  private arm(ms: number): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const left = this.heard + silenceBoundMs('provider.stream.idle_ms') - Date.now();

      if (left > 0) {
        this.timer = this.arm(left);

        return;
      }

      this.fired = true;
      detach(Effect.promise(() => this.silenced()));
    }, ms);
  }
}

function stalled(provider: string): APICallError {
  return new APICallError({
    message: `${provider} sent nothing for ${fmtSpan(silenceBoundMs('provider.stream.idle_ms'))}`,
    url: provider,
    requestBodyValues: undefined,
    isRetryable: false,
    cause: new KinuError('timeout', `the ${provider} stream stalled`),
  });
}

/** The provider's own failure, final: the SDK must not retry what this layer gave up on. */
function final(failure: APICallError): APICallError {
  return new APICallError({
    message: failure.message, url: failure.url, requestBodyValues: failure.requestBodyValues,
    ...(failure.statusCode !== undefined && { statusCode: failure.statusCode }),
    ...(failure.responseHeaders !== undefined && { responseHeaders: failure.responseHeaders }),
    ...(failure.responseBody !== undefined && { responseBody: failure.responseBody }),
    cause: failure.cause, data: failure.data, isRetryable: false,
  });
}

function handedOver(input: { readonly provider: string; readonly status: number | null; readonly resetsInMs: number | null }): APICallError {
  return new APICallError({
    message: `${input.provider} is rate-limiting this account${input.status === null ? '' : ` (HTTP ${String(input.status)})`}`
      + `${input.resetsInMs === null ? '' : `; it resets in ${fmtSpan(input.resetsInMs)}`}`,
    url: input.provider,
    requestBodyValues: undefined,
    ...(input.status !== null && { statusCode: input.status }),
    ...(input.resetsInMs !== null && { responseHeaders: { 'retry-after-ms': String(input.resetsInMs) } }),
    isRetryable: false,
  });
}

interface RateLimit {
  readonly status: number;
  readonly spent: ExhaustedAllowance | null;
}

/** A limit to wait out or a spent allowance; null for any other failure. */
function rateLimitOf(failure: APICallError): RateLimit | null {
  const status = failure.statusCode;
  const body = failure.responseBody ?? '';

  if (status === 529) return { status, spent: null };

  if (status === 429) return { status, spent: exhaustedAllowance(body) };

  if (status !== 503) return null;
  const detail = [new Headers(failure.responseHeaders ?? {}).get('x-error-code') ?? '', body].join(' ');

  return /overload(?:ed|ing)?|\bcapacity\b|\btoo many requests\b|\brate[ _-]?limit|subscription_sharing_(?:usage|user)_unavailable/i.test(detail)
    ? { status, spent: null }
    : null;
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

function exhaustedAllowance(body: string): ExhaustedAllowance | null {
  const decoded = tolerate<unknown>(() => JSON.parse(body), 'malformed-input');
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
  const details = v.safeParse(v.array(v.unknown()), error.details);

  const failures = (details.success ? details.output : []).flatMap((detail) => {
    const failure = v.safeParse(QuotaFailureSchema, detail);

    return failure.success ? [failure.output] : [];
  });

  return error.status === 'RESOURCE_EXHAUSTED' && spentQuota(failures) ? { marker: error.status, message: error.message } : null;
}

function spentQuota(failures: readonly v.InferOutput<typeof QuotaFailureSchema>[]): boolean {
  return failures.some((failure) => failure.violations.some((violation) => violation.quotaValue === '0' || (violation.quotaId?.includes('PerDay') ?? false)));
}

function allowanceSpent(failure: APICallError, exhausted: ExhaustedAllowance): APICallError {
  const host = URL.parse(failure.url)?.host ?? failure.url;

  return new APICallError({
    message: exhausted.message ?? `HTTP 429 (${exhausted.marker})`,
    url: failure.url,
    requestBodyValues: undefined,
    statusCode: 429,
    ...(failure.responseHeaders !== undefined && { responseHeaders: failure.responseHeaders }),
    ...(failure.responseBody !== undefined && { responseBody: failure.responseBody }),
    isRetryable: false,
    cause: new KinuError('budget', `${host} answered HTTP 429 ${exhausted.marker}: the account's quota or spend limit is used up, and waiting does not restore it`),
  });
}

function providerMessage(body: string): string | undefined {
  const decoded = tolerate<unknown>(() => JSON.parse(body), 'malformed-input');
  const envelope = v.safeParse(ErrorEnvelopeSchema, decoded);

  if (envelope.success) return envelope.output.error?.message ?? envelope.output.errors?.[0]?.message;
  const text = body.trim();

  return decoded === undefined && text !== '' && text.length <= 300 ? text : undefined;
}

interface TooLong {
  readonly provider: string;
  readonly untilMs: number;
  readonly nowMs: number;
  readonly reason: string | undefined;
  readonly failure?: APICallError;
}

function waitTooLong(input: TooLong): APICallError {
  const resetsAt = `${new Date(input.untilMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const { failure } = input;

  return new APICallError({
    message: `${input.provider} is rate-limited until ${resetsAt} (in ${fmtSpan(input.untilMs - input.nowMs)})${input.reason === undefined ? '' : `: ${input.reason}`}`,
    url: failure?.url ?? input.provider,
    requestBodyValues: undefined,
    ...(failure?.statusCode !== undefined && { statusCode: failure.statusCode }),
    ...(failure?.responseHeaders !== undefined && { responseHeaders: failure.responseHeaders }),
    isRetryable: false,
    cause: new KinuError('budget', `${input.provider} declared a wait until ${resetsAt}, past the ${fmtSpan(MAX_RETRY_DELAY_MS)} a call waits`),
  });
}
