/**
 * Every model's retry, once: a stated Retry-After is waited out up to a minute and shared with the lane's other calls,
 * an opening error or a silent attempt is backed off, and a call with no retries left hands over to the fallback chain.
 * A stream is bounded by silence, never by duration: each provider event, keepalives included, resets the bound.
 *
 * A stream's output is committed when its first output part leaves this layer: the SDK records it in the step, the
 * chat loop shows it and keeps it (`persistStreamPart`), and a tool call it carries runs. Until then (the stream's
 * start, the response's metadata, an empty text or reasoning opening) its parts are held, and a stream that fails,
 * stalls or ends short is the same failure as a refused request, retried under the same count. After it, the failure
 * reaches the step in the provider's own words, and the chain fails over from there: nothing replays output the step
 * already holds.
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
import { inAttempt, type Attempt } from './attempt';
import { generateFromStream } from './stream-generate';
import { abortableSleep, providerPacer, type ProviderPacer } from '../pacing';
import type { ProviderWaitInfo } from '../types';

/** Full-jitter backoff; unmeasured. */
const BASE_DELAY_MS = 2_000;

const BACKOFF_FACTOR = 2;

const MAX_DELAY_MS = 60_000;

/** OMP's `maxRetryDelayMs` (oh-my-pi ai/src/types.ts:499); a longer Retry-After means the account is spent. */
const MAX_RETRY_DELAY_MS = 60_000;

/** A lane known only by looking which credential the call bills (a sole named account stands in for `main`): looked up
 *  only when a wait is declared, or when some lane under `route` is cooling, so a call costs no lookup otherwise. */
export interface LaneLookup {
  readonly route: string;
  readonly billed: () => Promise<string>;
}

export interface RetryPolicy {
  /** Named in wait notices and refusals. */
  readonly provider: string;
  readonly modelId?: string;
  /** Calls on one lane (a provider and the credential it bills) share each declared wait. */
  readonly lane: string | LaneLookup;
  /** Called before each sleep, including joined cooldowns; a throw is reported and ignored. */
  readonly onWait?: (info: ProviderWaitInfo) => void;
  /** The provider streams every call on its wire (the ChatGPT plan): a generate is its stream collected, under the
   *  same silence bound. */
  readonly generateByStream?: boolean;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly warn?: (message: string) => void;
  readonly pacer?: ProviderPacer;
}

/** Kinu's own call options, read here and never passed to the provider. */
const KinuOptionsSchema = v.looseObject({ kinu: v.optional(v.looseObject({ retries: v.optional(v.number()) })) });

/** A call's own retries, as `providerOptions`; a chain entry takes a call with none. */
export function callRetries(retries: number): SharedV4ProviderOptions {
  return { kinu: { retries } };
}

interface KinuOptions {
  readonly retries: number;
  readonly raw: boolean;
}

/** Each provider call's own options, read off the call before it reaches the provider and kept by the call it became. */
const callOptions = new WeakMap<LanguageModelV4CallOptions, KinuOptions>();

function kinuOptions(params: LanguageModelV4CallOptions): KinuOptions {
  return callOptions.get(params) ?? { retries: DEFAULT_PROVIDER_RETRIES, raw: false };
}

type Opened<T> =
  | { readonly kind: 'answer'; readonly value: T }
  /** Final: no retry reads it again. */
  | { readonly kind: 'failed'; readonly error: unknown }
  /** The provider refused before answering, a failure the retry classifies. */
  | { readonly kind: 'refused'; readonly error: unknown }
  /** The stream failed before any output was committed: retried as a refusal is, unless the failure is final. */
  | { readonly kind: 'cut'; readonly error: unknown }
  | { readonly kind: 'stall' };

/** One call to the provider; `last` once no retry is left. */
type Open<T> = (last: boolean) => Promise<Opened<T>>;

export function retryMiddleware(policy: RetryPolicy): LanguageModelMiddleware {
  return {
    specificationVersion: 'v4',
    transformParams: async ({ params }) => {
      const { kinu: _kinu, ...providerOptions } = params.providerOptions ?? {};
      const stated = v.safeParse(KinuOptionsSchema, params.providerOptions ?? {});
      const call: LanguageModelV4CallOptions = { ...params, includeRawChunks: true, providerOptions };

      callOptions.set(call, {
        retries: (stated.success ? stated.output.kinu?.retries : undefined) ?? DEFAULT_PROVIDER_RETRIES,
        raw: params.includeRawChunks === true,
      });

      return call;
    },
    wrapGenerate: ({ doGenerate, doStream, params }) => settle(retrying(policy, params, policy.generateByStream === true
      ? async (last) => {
        const opened = await openStream({ provider: policy.provider, start: doStream, last, keepRaw: false, caller: params.abortSignal });

        if (opened.kind !== 'answer') return opened;
        const [collected] = await Promise.allSettled([generateFromStream(opened.value)]);

        return collected.status === 'fulfilled' ? { kind: 'answer', value: collected.value } : { kind: 'failed', error: collected.reason };
      }
      : async () => ({ kind: 'answer', value: await doGenerate() }))),
    wrapStream: ({ doStream, params }) => settle(retrying(policy, params, (last) => openStream({
      provider: policy.provider, start: doStream, last, keepRaw: kinuOptions(params).raw, caller: params.abortSignal,
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
  const lane = new CallLane(policy.lane);

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

    const spendRetry = (spent: () => Error): Effect.Effect<void> => Effect.suspend(() => (++waits > retries ? Effect.die(spent()) : Effect.void));

    for (let attemptNumber = 1; ; attemptNumber++) {
      const checked = yield* lane.toCheck(pacer);

      if (checked !== null) yield* cooledDown({ policy, pacer, lane: checked, owned, retries, now, signal, reportWait });

      const [opened] = yield* Effect.promise(() => Promise.allSettled([open(waits >= retries)]));
      const outcome: Opened<T> = opened.status === 'fulfilled' ? opened.value : { kind: 'refused', error: opened.reason };

      if (outcome.kind === 'answer') return outcome.value;

      if (outcome.kind === 'failed') return yield* Effect.die(outcome.error);

      if (outcome.kind === 'stall' || (outcome.kind === 'cut' && !APICallError.isInstance(outcome.error))) {
        yield* spendRetry(() => spentBy(outcome, policy.provider));
        const waitMs = Math.floor(random() * backoffCeiling(attemptNumber));

        yield* reportWait(waitMs, attemptNumber, outcome.kind === 'stall' ? 'stall' : 'backoff');
        yield* Effect.promise(() => sleep(waitMs, signal));
        continue;
      }

      const failure: unknown = outcome.error;

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
        pacer.declareWait(yield* lane.billed(), retryAfter, providerMessage(failure.responseBody ?? ''));

        return yield* Effect.die(waitTooLong({
          provider: policy.provider, untilMs: now() + retryAfter, nowMs: now(), reason: providerMessage(failure.responseBody ?? ''), failure,
        }));
      }

      const waitMs = retryAfter ?? Math.floor(random() * backoffCeiling(attemptNumber));
      const declared = pacer.declareWait(yield* lane.billed(), waitMs);

      yield* spendRetry(() => handedOver(policy.provider, waitMs, failure));
      owned = declared;
      warn(`[kinu] ${policy.provider} rate-limited: waiting ${fmtSpan(waitMs)} (attempt ${String(attemptNumber)})`);
      yield* reportWait(waitMs, attemptNumber, retryAfter !== null ? 'header' : 'backoff', limit.status);
      yield* Effect.promise(() => sleep(waitMs, signal));
    }
  });
}

/** The call's lane, looked up at most once and only when a wait is in play. */
class CallLane {
  private known: string | null;
  private readonly lookup: LaneLookup | null;

  constructor(lane: string | LaneLookup) {
    this.known = typeof lane === 'string' ? lane : null;
    this.lookup = typeof lane === 'string' ? null : lane;
  }

  billed(): Effect.Effect<string> {
    const { known, lookup } = this;

    if (known !== null || lookup === null) return Effect.succeed(known ?? '');

    return Effect.map(Effect.promise(lookup.billed), (billed) => {
      this.known = billed;

      return billed;
    });
  }

  /** The lane to check before an attempt, or null while nothing under its route is cooling. */
  toCheck(pacer: ProviderPacer): Effect.Effect<string | null> {
    return this.known !== null || this.lookup === null || pacer.coolingUnder(this.lookup.route) ? this.billed() : Effect.succeed(null);
  }
}

interface CooldownCheck {
  readonly policy: RetryPolicy;
  readonly pacer: ProviderPacer;
  readonly lane: string;
  /** The deadline this call declared itself, which it waits out without announcing. */
  readonly owned: number | null;
  readonly retries: number;
  readonly now: () => number;
  readonly signal: AbortSignal | undefined;
  readonly reportWait: (waitMs: number, attempt: number, source: ProviderWaitInfo['source']) => Effect.Effect<void>;
}

/** The lane's cooldown waited out, re-read after each wait since a sibling may extend it; one past the longest wait, or
 *  any for a call with no retries, ends the call instead. */
function cooledDown(check: CooldownCheck): Effect.Effect<void> {
  const { pacer, lane, policy, signal } = check;

  return Effect.gen(function* () {
    for (let cooling = pacer.cooling(lane); cooling !== null; cooling = pacer.cooling(lane)) {
      if (signal?.aborted === true) return yield* Effect.die(signal.reason);
      const { waitMs, untilMs, reason } = cooling;

      if (waitMs > MAX_RETRY_DELAY_MS) return yield* Effect.die(waitTooLong({ provider: policy.provider, untilMs, nowMs: check.now(), reason }));

      if (untilMs !== check.owned) {
        if (check.retries === 0) return yield* Effect.die(handedOver(policy.provider, waitMs));
        yield* check.reportWait(waitMs, 0, 'cooldown');
      }

      yield* Effect.promise(() => pacer.pause(waitMs, signal));
    }
  });
}

function backoffCeiling(attempt: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * BACKOFF_FACTOR ** Math.min(attempt - 1, 32));
}

interface StreamAttempt {
  readonly provider: string;
  /** Called inside the attempt, so the transport below reports its bytes and takes the attempt's cancel. */
  readonly start: () => PromiseLike<LanguageModelV4StreamResult>;
  readonly last: boolean;
  readonly keepRaw: boolean;
  /** The caller's own cancel, which ends the attempt too. */
  readonly caller: AbortSignal | undefined;
}

/**
 * The first output part decides: an error, a failed read or silence before it ends the attempt unless no retry is left;
 * an output part is the answer, still read under the bound. Silence, on the wire as in the parts, past the bound
 * abandons the attempt and aborts its request.
 */
async function openStream(attempt: StreamAttempt): Promise<Opened<LanguageModelV4StreamResult>> {
  const started = Date.now();
  const silent = Promise.withResolvers<null>();
  const bound = new SilenceBound(attempt.provider, attempt.caller, async () => { silent.resolve(null); });
  // Started a microtask on, so a provider that throws as it is called rejects the opening instead of escaping it.
  const opening = Promise.resolve().then(() => inAttempt(bound.attempt, attempt.start));
  const [first] = await Promise.allSettled([Promise.race([opening, silent.promise])]);

  // A refusal before any answer ends the attempt: its watchdog and its hold on the caller's cancel go with it.
  if (first.status === 'rejected') {
    bound.stop();

    return { kind: 'refused', error: first.reason };
  }

  const opened = first.value;

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

    // API failures, including the last, must become final in the common retry policy before the SDK sees them.
    if (read.status === 'rejected' && (!attempt.last || APICallError.isInstance(read.reason))) {
      bound.abandon();

      return cutBeforeOutput(read.reason);
    }

    if (read.status === 'rejected') return answered(opened, { bound, parts, held, keepRaw: attempt.keepRaw, ended: { reason: read.reason } });

    if (read.value === 'end') return answered(opened, { bound, parts, held, keepRaw: attempt.keepRaw, ended: 'closed' });
    const part = read.value;

    held.push(part);

    if (BEFORE_OUTPUT.has(part.type)) continue;

    if (part.type === 'error' && (!attempt.last || APICallError.isInstance(part.error))) {
      bound.abandon();
      await abandoned(parts.cancel());

      return cutBeforeOutput(part.error);
    }

    return answered(opened, { bound, parts, held, keepRaw: attempt.keepRaw, ended: null });
  }
}

/** A stream that failed before its output: final when the failure is, else retried as a refusal is. */
function cutBeforeOutput(error: Extract<Opened<never>, { readonly kind: 'cut' }>['error']): Opened<never> {
  const cut = { kind: 'cut', error } as const;

  return finalFailure(cut) ? { kind: 'failed', error } : cut;
}

/** Parts that carry no output: held, so a stream that fails after them is retried as a refused request is. */
const BEFORE_OUTPUT: ReadonlySet<LanguageModelV4StreamPart['type']> = new Set(['stream-start', 'raw', 'response-metadata', 'text-start', 'reasoning-start']);

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
        const [read] = await Promise.allSettled([parts.read()]);

        if (bound.fired) return;

        if (read.status === 'rejected' || read.value === 'end') {
          bound.stop();

          return read.status === 'rejected' ? controller.error(read.reason) : controller.close();
        }

        bound.hear();

        if (shown(read.value)) return controller.enqueue(read.value);
      }
    },
    cancel: () => {
      bound.stop();

      return parts.cancel();
    },
  });

  return { kind: 'answer', value: { ...opened, stream } };
}

/** The attempt's watchdog: one timer at a time, armed for what is left of the catalog's silence bound since the last
 *  event or wire chunk (a timer per event cost the heap gate's long turn 14 MB); silence past the bound aborts the
 *  attempt's request and declares the stall. The
 *  caller's cancel is forwarded by a listener the attempt removes when it ends, not joined with `AbortSignal.any`, whose
 *  dependents a turn-long signal holds for the whole turn. */
class SilenceBound {
  fired = false;
  readonly attempt: Attempt;
  private stopped = false;
  private heard = Date.now();
  private stall: APICallError | undefined;
  private readonly cut = new AbortController();
  private readonly forward: () => void;
  private silenced: () => Promise<void>;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly provider: string, private readonly caller: AbortSignal | undefined, silenced: () => Promise<void>) {
    this.silenced = silenced;
    this.attempt = { signal: this.cut.signal, heard: () => { this.hear(); } };
    this.forward = () => { this.cut.abort(caller?.reason); };

    if (caller?.aborted === true) this.forward();
    else caller?.addEventListener('abort', this.forward, { once: true });
    this.arm(silenceBoundMs('provider.stream.idle_ms'));
  }

  /** Built when first needed: an error's stack is not paid by every attempt that never stalls. */
  get failure(): APICallError {
    this.stall ??= stalled(this.provider);

    return this.stall;
  }

  hear(): void {
    this.heard = Date.now();
  }

  onSilence(silenced: () => Promise<void>): void {
    this.silenced = silenced;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.caller?.removeEventListener('abort', this.forward);
  }

  /** No longer wanted: its request is aborted. */
  abandon(): void {
    this.stop();
    this.cut.abort(this.failure);
  }

  private arm(ms: number): void {
    this.timer = setTimeout(() => {
      detach(Effect.promise(async () => {
        if (this.expired()) await this.silenced();
      }));
    }, ms);
  }

  /** Waits again for what is left of the bound, or, silent for all of it, aborts the request. */
  private expired(): boolean {
    const left = this.heard + silenceBoundMs('provider.stream.idle_ms') - Date.now();

    if (this.stopped) return false;

    if (left > 0) {
      this.arm(left);

      return false;
    }

    this.fired = true;
    this.caller?.removeEventListener('abort', this.forward);
    this.cut.abort(this.failure);

    return true;
  }
}

/** A failure no retry can mend: the provider's own final refusal, or Kinu's classification of a refusal as the owner's
 *  to fix (a spent allowance, a refused sign-in, a bad request). A failure of any other shape, a dropped connection
 *  or a provider's error event, is transient. */
function finalFailure({ error }: Extract<Opened<never>, { readonly kind: 'cut' }>): boolean {
  if (APICallError.isInstance(error)) return !error.isRetryable;

  return error instanceof KinuError && error.code !== 'unavailable' && error.code !== 'timeout';
}

/** What a call that spent its retries on stalls or cut streams ends with. */
function spentBy(outcome: Extract<Opened<never>, { readonly kind: 'stall' | 'cut' }>, provider: string): Error {
  return outcome.kind === 'stall' ? stalled(provider) : new KinuError('unavailable', `the ${provider} stream failed before its output`, { cause: outcome.error });
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

/** A final refusal, with this layer's next-attempt delay separate from the provider's response. */
function handedOver(provider: string, retryAfterMs: number, failure?: APICallError): APICallError & { readonly retryAfterMs: number } {
  const refused = failure === undefined ? new APICallError({
    message: `${provider} is cooling down after a refused request`,
    url: provider, requestBodyValues: undefined, isRetryable: false,
  }) : final(failure);

  return Object.assign(refused, { cause: failure, retryAfterMs });
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
  // Kinu's own error mapping (`errorResponse`) carries the code as text.
  const allocation = errors?.find((entry) => String(entry.code) === String(WORKERS_AI_DAILY_ALLOCATION));

  if (allocation !== undefined) return { marker: String(WORKERS_AI_DAILY_ALLOCATION), message: allocation.message };

  if (error === undefined) return null;
  const anthropic = v.safeParse(AnthropicErrorDetailsSchema, error.details);

  const named = [error.code, error.type, anthropic.success ? anthropic.output.error_code : undefined, error.metadata?.provider_code]
    .find((field) => String(field) === String(WORKERS_AI_DAILY_ALLOCATION) || v.is(ExhaustedAllowanceCodeSchema, field));

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

/** The refusal no wait cures, a 429 saying the account's allowance is spent, as its budget failure; null for any other.
 *  The one reading for the model stack and for a call beside it (`restDecisionRun`). */
export function spentAllowanceRefusal(failure: APICallError): APICallError | null {
  const spent = rateLimitOf(failure)?.spent ?? null;

  return spent === null ? null : allowanceSpent(failure, spent);
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
