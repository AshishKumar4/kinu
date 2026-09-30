/** The one fallback policy: a turn and a fixed-tier call walk the configured chain alike (T3). */
import { Effect } from 'effect';
import { attempt, classifyErrorCode, diagnostics, KinuError, settle } from '../obs/index';
import { DEFAULT_PROVIDER_RETRIES } from '../types/profile';
import { createFallbackCooldowns, statedRetryAfterMs, type FallbackCooldowns } from './fallback-cooldown';
import { describeProviderError, providerFailureFacts } from './util';

export interface CallFailure {
  readonly cause: unknown;
  readonly error: Error;
  /** The failing step had streamed text or started a tool. */
  readonly streamed: boolean;
}

export interface FallbackEntry {
  readonly spec: string;
}

export interface FallbackRouteOptions<E extends FallbackEntry> {
  readonly modelSpec?: string;
  readonly fallbacks?: readonly E[];
  readonly cooldowns?: FallbackCooldowns;
  readonly retries?: number;
  readonly credentialOf?: (spec: string) => Promise<string | null>;
}

/** A fallback takes a call that failed before streaming for a provider or account failure; a malformed or
 *  too-large request fails the call. */
function handsOver(failure: CallFailure): boolean {
  if (failure.streamed) return false;
  const { status } = providerFailureFacts({ cause: failure.cause });

  if (status !== undefined) return [401, 402, 403, 404, 408, 429].includes(status) || status >= 500;
  const code = classifyErrorCode({ cause: failure.error });

  return code === null || code === 'unavailable' || code === 'timeout' || code === 'budget';
}

/** A failed lookup is logged and unknown: it skips nothing. */
export function credentialOrUnknown(credentialOf: (spec: string) => Promise<string | null>, spec: string): Effect.Effect<string | null> {
  return attempt({ doing: 'look up the credential a model is called with', otherwise: 'io' }, () => credentialOf(spec)).pipe(
    Effect.catch((failed) => Effect.sync(() => {
      diagnostics.failure('llm_call.fallback_credential_unknown', failed, { spec });

      return null;
    })),
  );
}

const isolateCooldowns = createFallbackCooldowns();

/** OMP's chain (coding-agent session/turn-recovery.ts 2448-2490): hand over at once, park, retry only the last. */
export class FallbackRoute<E extends FallbackEntry> {
  readonly tried: string[];
  private readonly chain: E[];
  private readonly cooldowns: FallbackCooldowns;
  private readonly retries: number;

  constructor(private readonly opts: FallbackRouteOptions<E>) {
    this.chain = [...(opts.fallbacks ?? [])];
    this.cooldowns = opts.cooldowns ?? isolateCooldowns;
    this.retries = opts.retries ?? DEFAULT_PROVIDER_RETRIES;
    this.tried = [opts.modelSpec ?? 'the turn model'];
  }

  get callRetries(): number {
    return this.chain.length > 0 ? 0 : this.retries;
  }

  cooledStart(): E | undefined {
    const spec = this.opts.modelSpec;

    if (spec === undefined || !this.cooldowns.parked(spec)) return undefined;
    const at = this.chain.findIndex((entry) => !this.cooldowns.parked(entry.spec));

    return at < 0 ? undefined : this.chain.splice(0, at + 1).at(-1);
  }

  /** A 401 refuses the credential, so entries holding it are passed over; a 403 may be model-scoped. */
  async next(failed: string | undefined, failure: CallFailure): Promise<E | undefined> {
    if (!handsOver(failure)) return undefined;

    if (failed !== undefined) this.cooldowns.park(failed, statedRetryAfterMs({ cause: failure.cause }));
    const { status } = providerFailureFacts({ cause: failure.cause });
    const lookup = status === 401 && failed !== undefined ? this.opts.credentialOf : undefined;
    const { chain, cooldowns } = this;

    return await settle(Effect.gen(function* () {
      const refused = lookup !== undefined && failed !== undefined ? yield* credentialOrUnknown(lookup, failed) : null;

      for (let next = chain.shift(); next !== undefined; next = chain.shift()) {
        if (cooldowns.parked(next.spec) && chain.length > 0) continue;

        if (refused === null || lookup === undefined || (yield* credentialOrUnknown(lookup, next.spec)) !== refused) return next;
      }

      return undefined;
    }));
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
