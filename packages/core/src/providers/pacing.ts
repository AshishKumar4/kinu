/** Isolate-scoped pacer: sibling requests to one provider host share its declared cooldown. It counts no requests:
 *  workerd bounds connections awaiting headers and cancels one parked on another's release as hung (HTTP 500 1101
 *  on kinu.run, 2026-09-23). */

import { Effect } from 'effect';
import { settle } from '../obs/effect';
import { abortCause } from '../utils/abort';

/** Sleep that an abort ends, rejecting with the signal's reason. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return settle(Effect.die(abortCause(signal)));
  const { promise, resolve, reject } = Promise.withResolvers<void>();

  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);

  const onAbort = () => {
    clearTimeout(timer);
    reject(abortCause(signal));
  };

  signal?.addEventListener('abort', onAbort, { once: true });

  return promise;
}

export interface ProviderPacerOptions {
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Keyed by host and, where named, account: accounts have their own budgets. */
export class ProviderPacer {
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Each host's declared cooldown, as a deadline. */
  private readonly cooldowns = new Map<string, { readonly untilMs: number; readonly reason: string | undefined; readonly wait: boolean }>();

  constructor(opts: ProviderPacerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? abortableSleep;
  }

  /** The lane's cooldown still to wait, or null: what a caller decides on before it waits. */
  cooling(host: string): { readonly waitMs: number; readonly untilMs: number; readonly reason: string | undefined } | null {
    const cooldown = this.cooldowns.get(host);
    const waitMs = (cooldown?.untilMs ?? 0) - this.now();

    return cooldown === undefined || !cooldown.wait || waitMs <= 0 ? null : { waitMs, untilMs: cooldown.untilMs, reason: cooldown.reason };
  }

  /** Whether any lane under `route` is cooling: only then is a call's own lane worth looking up. */
  coolingUnder(route: string): boolean {
    const now = this.now();

    for (const [lane, cooldown] of this.cooldowns) {
      if (cooldown.wait && lane.startsWith(`${route}|`) && cooldown.untilMs > now) return true;
    }

    return false;
  }

  /** Waits `ms` on this pacer's clock. */
  pause(ms: number, signal?: AbortSignal): Promise<void> {
    return this.sleep(ms, signal);
  }

  /** Record a cooldown of `ms`; its deadline, null if a later one holds. */
  declareWait(host: string, ms: number, reason?: string): number | null {
    if (!(ms > 0)) return null;
    const untilMs = this.now() + ms;

    const previous = this.cooldowns.get(host);

    if (previous?.wait === true && untilMs <= previous.untilMs) return null;
    this.cooldowns.set(host, { untilMs, reason, wait: true });

    return untilMs;
  }

  /** Selection is model-scoped; rate waits are lane-wide. Both are owned here and can only extend a deadline. */
  park(attempt: string, retryAfterMs: number | null): void {
    const duration = retryAfterMs !== null && retryAfterMs > 0 ? retryAfterMs : 5 * 60 * 1000;
    const untilMs = this.now() + duration;
    const previous = this.cooldowns.get(attempt);

    if (previous !== undefined && previous.untilMs >= untilMs) return;
    this.cooldowns.set(attempt, { untilMs, reason: previous?.reason, wait: previous?.wait ?? false });
  }

  parked(attempt: string): boolean {
    const deadline = this.cooldowns.get(attempt);

    if (deadline === undefined) return false;

    if (deadline.untilMs > this.now()) return true;
    this.cooldowns.delete(attempt);

    return false;
  }
}

/** The isolate's shared pacer. */
export const providerPacer = new ProviderPacer();
