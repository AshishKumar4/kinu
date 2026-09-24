/** Isolate-scoped pacer: sibling requests to one provider host share its
 *  declared cooldown and connection-lane budget. */

import { PLATFORM_CATALOG } from '../platform-catalog';
import { abortCause } from '../utils/abort';

/** Requests per host awaiting response headers; a lane frees when headers arrive,
 *  matching the platform's `worker.simultaneous_connections` budget. */
const PROVIDER_REQUEST_LANES =
  PLATFORM_CATALOG['worker.simultaneous_connections'].limit.value;

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

/** One provider host's share of the pacer. */
interface HostLane {
  /** Requests currently holding a lane — out, and awaiting headers. */
  active: number;
  /** Woken as a set on release: a hand-off queue loses a wakeup when a woken waiter aborts. */
  waiting: Array<() => void>;
  /** The provider's declared cooldown, as a deadline. */
  coolUntilMs: number;
}

export interface ProviderPacerOptions {
  readonly lanes?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Keyed by host and, where named, account: accounts have their own budgets. */
export class ProviderPacer {
  private readonly lanes: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly hosts = new Map<string, HostLane>();

  constructor(opts: ProviderPacerOptions = {}) {
    this.lanes = opts.lanes ?? PROVIDER_REQUEST_LANES;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? abortableSleep;
  }

  /** Wait out any cooldown, then take a lane (cooldown first, so no lane idles through it).
   *  The returned release must be called; `onCooldown` gets the deadline to dedupe its own. */
  async admit(host: string, signal?: AbortSignal, opts?: { onCooldown?: (waitMs: number, untilMs: number) => void }): Promise<() => void> {
    const lane = this.laneFor(host);

    for (;;) {
      if (signal?.aborted) throw abortCause(signal);
      const cooling = lane.coolUntilMs - this.now();

      if (cooling > 0) {
        opts?.onCooldown?.(cooling, lane.coolUntilMs);
        await this.sleep(cooling, signal);
        continue;
      }

      if (lane.active < this.lanes) {
        lane.active += 1;
        let released = false;

        return () => {
          if (released) return;
          released = true;
          lane.active -= 1;
          this.wakeAll(lane);
        };
      }

      await this.queueForLane(lane, signal);
    }
  }

  /** Resolves on release or abort; the loop re-checks the signal, so only it throws. */
  private queueForLane(lane: HostLane, signal?: AbortSignal): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    lane.waiting.push(resolve);
    signal?.addEventListener('abort', () => { resolve(); }, { once: true });

    return promise;
  }

  /** Record a host cooldown of `ms`; the deadline only moves forward. */
  declareWait(host: string, ms: number): void {
    if (!(ms > 0)) return;
    const lane = this.laneFor(host);
    lane.coolUntilMs = Math.max(lane.coolUntilMs, this.now() + ms);
  }

  private laneFor(host: string): HostLane {
    const existing = this.hosts.get(host);

    if (existing) return existing;
    const lane: HostLane = { active: 0, waiting: [], coolUntilMs: 0 };
    this.hosts.set(host, lane);

    return lane;
  }

  private wakeAll(lane: HostLane): void {
    const waiters = lane.waiting.splice(0);

    for (const wake of waiters) wake();
  }
}

/** The isolate's shared pacer. */
export const providerPacer = new ProviderPacer();
