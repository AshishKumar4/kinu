/** Isolate-scoped pacer: sibling requests to one provider host share its declared cooldown.
 *
 *  It counts no requests. Workers bounds connections awaiting headers per invocation and queues past the bound
 *  itself (`worker.simultaneous_connections`). A count shared by the isolate's requests parked one request on a
 *  promise only another request's release settled; workerd cancels such a request as hung, and a holder the runtime
 *  cancelled never released (HTTP 500 1101 on kinu.run, 2026-09-23). */

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

/** Keyed by host, not credential: the retry layer has no credential in reach, and
 *  two accounts sharing one host's cooldown is the conservative direction. */
export class ProviderPacer {
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Each host's declared cooldown, as a deadline. */
  private readonly coolUntilMs = new Map<string, number>();

  constructor(opts: ProviderPacerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? abortableSleep;
  }

  /** Wait out the host's cooldown on the caller's own timer, re-read after each sleep because a sibling may extend it.
   *  `onCooldown` gets the deadline so a caller can skip announcing its own. */
  async admit(host: string, signal?: AbortSignal, opts?: { onCooldown?: (waitMs: number, untilMs: number) => void }): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw abortCause(signal);
      const untilMs = this.coolUntilMs.get(host) ?? 0;
      const cooling = untilMs - this.now();

      if (cooling <= 0) return;
      opts?.onCooldown?.(cooling, untilMs);
      await this.sleep(cooling, signal);
    }
  }

  /** Record a host cooldown of `ms`; the deadline only moves forward. */
  declareWait(host: string, ms: number): void {
    if (!(ms > 0)) return;
    this.coolUntilMs.set(host, Math.max(this.coolUntilMs.get(host) ?? 0, this.now() + ms));
  }
}

/** The isolate's shared pacer. */
export const providerPacer = new ProviderPacer();
