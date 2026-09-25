/** Isolate-scoped pacer: sibling requests to one provider host share its declared cooldown. It counts no requests:
 *  workerd bounds connections awaiting headers and cancels one parked on another's release as hung (HTTP 500 1101
 *  on kinu.run, 2026-09-23). */

import { abortCause } from '../utils/abort';

/** Sleep that an abort ends, rejecting with the signal's reason. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortCause(signal));
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
  private readonly cooldowns = new Map<string, { readonly untilMs: number; readonly reason: string | undefined }>();

  constructor(opts: ProviderPacerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? abortableSleep;
  }

  /** Waits out the host's cooldown, re-read after each sleep as a sibling may extend it. `onCooldown` gets the
   *  deadline so a caller can skip announcing its own. */
  async admit(
    host: string,
    signal?: AbortSignal,
    opts?: { onCooldown?: (waitMs: number, untilMs: number, reason: string | undefined) => void },
  ): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw abortCause(signal);
      const cooldown = this.cooldowns.get(host);
      const cooling = (cooldown?.untilMs ?? 0) - this.now();

      if (cooldown === undefined || cooling <= 0) return;
      opts?.onCooldown?.(cooling, cooldown.untilMs, cooldown.reason);
      await this.sleep(cooling, signal);
    }
  }

  /** Record a host cooldown of `ms`; the deadline only moves forward. */
  declareWait(host: string, ms: number, reason?: string): void {
    if (!(ms > 0)) return;
    const untilMs = this.now() + ms;

    if (untilMs > (this.cooldowns.get(host)?.untilMs ?? 0)) this.cooldowns.set(host, { untilMs, reason });
  }
}

/** The isolate's shared pacer. */
export const providerPacer = new ProviderPacer();
