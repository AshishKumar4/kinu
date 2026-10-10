import { Effect } from 'effect';
import type { LanguageModel } from 'ai';
import { DEFAULT_PROVIDER_RETRIES } from '../types/profile';
import { KinuError, attempt, classifyErrorCode, diagnostics, settle } from '../obs/index';
import { codeForStatus, describeProviderError, providerFailureFacts } from './util';
import { createFallbackCooldowns, statedRetryAfterMs, type FallbackCooldowns } from './fallback-cooldown';
import { attemptKey, modelAttempt, type ModelAttemptIdentity } from './attempt-identity';

export interface CallFailure {
  readonly error: Error;
  readonly cause: Parameters<typeof providerFailureFacts>[0]['cause'];
  readonly streamed: boolean;
}

interface FallbackEntry {
  readonly spec: string;
  readonly model?: LanguageModel;
}

export interface FallbackRouteOptions<E extends FallbackEntry> {
  readonly modelSpec?: string;
  readonly model?: LanguageModel;
  readonly fallbacks?: readonly E[];
  readonly cooldowns?: FallbackCooldowns;
  readonly retries?: number;
  readonly attemptOf?: (spec: string) => Promise<ModelAttemptIdentity | null>;
}

/** Handover requires a provider/account failure before output; malformed or too-large requests end the call. */
function handsOver(failure: CallFailure): boolean {
  if (failure.streamed) return false;
  const { status } = providerFailureFacts({ cause: failure.cause });

  if (status !== undefined) {
    const said = codeForStatus(status);

    return said !== null && said !== 'bad_input';
  }

  const code = classifyErrorCode({ cause: failure.error });

  return code === null || code === 'unavailable' || code === 'timeout' || code === 'budget';
}

/** A failed metadata lookup is unknown: it skips and parks nothing; the actual call keeps its own failure. */
export function attemptOrUnknown(lookup: (spec: string) => Promise<ModelAttemptIdentity | null>, spec: string): Effect.Effect<ModelAttemptIdentity | null> {
  return attempt({ doing: 'look up the attempt a model is called with', otherwise: 'io' }, () => lookup(spec)).pipe(
    Effect.catch((failed) => Effect.sync(() => {
      diagnostics.failure('llm_call.fallback_credential_unknown', failed, { spec });

      return null;
    })),
  );
}

const isolateCooldowns = createFallbackCooldowns();

/** One chain: hand over at once, park the exact failed attempt, and retry only the final entry. */
export class FallbackRoute<E extends FallbackEntry> {
  readonly tried: string[];
  private readonly chain: E[];
  private readonly cooldowns: FallbackCooldowns;
  private readonly retries: number;
  private current: ModelAttemptIdentity | null = null;

  constructor(private readonly opts: FallbackRouteOptions<E>) {
    this.chain = [...(opts.fallbacks ?? [])];
    this.cooldowns = opts.cooldowns ?? isolateCooldowns;
    this.retries = opts.retries ?? DEFAULT_PROVIDER_RETRIES;
    this.tried = [opts.modelSpec ?? 'the turn model'];
  }

  get callRetries(): number {
    return this.chain.length > 0 ? 0 : this.retries;
  }

  private identity(spec: string | undefined, model?: LanguageModel): Promise<ModelAttemptIdentity | null> {
    if (this.opts.attemptOf !== undefined && spec !== undefined) return settle(attemptOrUnknown(this.opts.attemptOf, spec));

    return model === undefined ? Promise.resolve(null) : modelAttempt(model);
  }

  async cooledStart(): Promise<E | undefined> {
    this.current = await this.identity(this.opts.modelSpec, this.opts.model);

    if (this.current === null || !this.cooldowns.parked(attemptKey(this.current))) return undefined;

    for (let at = 0; at < this.chain.length; at++) {
      const entry = this.chain[at];
      const identity = await this.identity(entry.spec, entry.model);

      if (identity !== null && this.cooldowns.parked(attemptKey(identity))) continue;
      this.current = identity;

      return this.chain.splice(0, at + 1).at(-1);
    }

    return undefined;
  }

  /** A 401 refuses its credential snapshot: aliases of that login are passed over, but a replacement is usable. */
  async next(failure: CallFailure): Promise<E | undefined> {
    if (!handsOver(failure)) return undefined;

    if (this.current !== null) this.cooldowns.park(attemptKey(this.current), statedRetryAfterMs({ cause: failure.cause }));
    const { status } = providerFailureFacts({ cause: failure.cause });
    const refused = status === 401 ? this.current?.credential ?? null : null;

    for (let next = this.chain.shift(); next !== undefined; next = this.chain.shift()) {
      const identity = await this.identity(next.spec, next.model);

      if (identity !== null && this.cooldowns.parked(attemptKey(identity)) && this.chain.length > 0) continue;

      if (refused !== null && identity?.credential === refused) continue;
      this.current = identity;

      return next;
    }

    return undefined;
  }

  exhausted(failure: CallFailure): Error {
    if (this.tried.length < 2) return failure.error;

    return new KinuError(
      classifyErrorCode({ cause: failure.error }) ?? 'unavailable',
      `Tried ${this.tried.join(', ')}: ${describeProviderError({ cause: failure.cause })}`,
      { cause: failure.error },
    );
  }
}
