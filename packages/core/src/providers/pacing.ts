/**
 * ONE SHARED PROVIDER, PACED — and a provider-declared wait made OBSERVABLE.
 *
 * Two facts about one thing. A model provider is not per-agent: every node of a
 * swarm, every head, and the actor itself drive their turn loops against ONE
 * account credential, so a provider's rate limit is a property of the isolate
 * rather than of any one turn inside it. Nothing here held that fact, and two
 * defects followed from its absence — both measured on the owner's live
 * workspace (my-personal-assistant-f0e4afa6, kinu.run).
 *
 *  1. A FAN-OUT WITH NO PACING. `strategy/swarm-run.ts` starts a whole level of
 *     nodes in one expression, each running its own turn loop. A
 *     `preset:'ideate'` run therefore opened five concurrent first requests on
 *     one Cloudflare OAuth credential, the account rate-limited them together,
 *     and all five entered backoff together. Nothing spaced them, and nothing
 *     told the fourth node that the first had just been handed a `Retry-After`.
 *
 *  2. A DECLARED WAIT READ AS SILENCE. `withRateLimitRetry` sleeps INSIDE
 *     `fetch`, which is inside `model.doStream()`, which is upstream of the
 *     first chunk `chat.ts`'s stall watchdog waits for. So "the provider told us
 *     to wait" and "this request is dead" were the same observation, and the
 *     watchdog ended the turn with `Turn stalled: nothing flowed for 300s`. Two
 *     heads of one run errored with exactly that text while a `wrangler tail` on
 *     the same workspace carried `provider.rate_limited` for the same window.
 *     The work was never wedged; it was queued behind a rate limit.
 *
 * So a wait is DECLARED here and READ here. {@link withRateLimitRetry} declares
 * one before it sleeps, {@link ProviderPacer.admit} makes every other request
 * for that host respect it, and `chat.ts`'s watchdog asks whether the silence it
 * is looking at is a wait somebody was told to take.
 *
 * NO DURATION IS INVENTED IN THIS FILE. The only waits it takes are ones the
 * provider named (`Retry-After`, or the retry layer's own bounded backoff), and
 * the only bound it declares is a CONCURRENCY, derived below.
 *
 * WHY A MODULE SINGLETON. The quantity being shared is an account's rate limit,
 * whose scope is the isolate — the same scope `diagnostics` has, and for the same
 * reason. Threading a pacer through six provider factories and every model call
 * would make the plumbing per-turn while the fact stayed per-account, which is
 * how node A ends up unable to see node B's `Retry-After`. {@link ProviderPacer}
 * is constructible for tests; production shares {@link providerPacer}.
 */

import { PLATFORM_CATALOG } from '../platform-catalog';

/**
 * HOW MANY MODEL REQUESTS MAY BE AWAITING RESPONSE HEADERS AT ONCE, per provider
 * host.
 *
 * DERIVED, and from a limit the platform already enforces on us: Cloudflare
 * queues the seventh connection that is simultaneously waiting for headers
 * (`worker.simultaneous_connections`, and its note names this exact incident —
 * "N branches plus the orchestrator each opening a model call inside one
 * invocation serialise past six ... a plausible contributor to the delegation
 * rate-limit storm"). Read off the catalog rather than restated, so the number
 * lives in exactly one place.
 *
 * The GRANULARITY is what makes this the right bound rather than a coincidence.
 * A lane is held from the request going out until its headers arrive, and the
 * platform's own budget frees a connection at exactly that moment too — "once
 * headers arrive a connection stops counting". So a lane is not a cap on
 * concurrent STREAMS: five nodes stream their answers in parallel as before, and
 * only their request STARTS are spaced.
 *
 * What the pacing buys, given the platform queues past six anyway, is that the
 * queueing becomes OURS. A platform-queued request is invisible latency that
 * arrives at the provider the moment a slot frees, whatever the provider last
 * said; a lane-queued request waits behind {@link ProviderPacer.declareWait}, so
 * a `Retry-After` handed to one node is honoured by its siblings instead of
 * being raced past by five requests that never saw it.
 */
export const PROVIDER_REQUEST_LANES =
  PLATFORM_CATALOG['worker.simultaneous_connections'].limit.value;

/** What a caller timing a silence needs to know about provider-declared waits. */
export interface ProviderWaitState {
  /** The furthest declared deadline still in the future, or 0 when no wait is
   *  open. A caller waiting on silence may wait this out without calling it a
   *  stall: somebody was told to hold off until then. */
  readonly untilMs: number;
  /**
   * Monotonic count of waits ever declared.
   *
   * Present because "is a wait open right now" cannot answer "was this silence
   * caused by a rate limit". A wait that opened and elapsed inside the window a
   * watchdog was timing is gone by the time the watchdog looks, and the turn
   * would then be reported as unexplained silence when the cause is on record.
   * Comparing this count across the window says whether one happened at all.
   */
  readonly declared: number;
}

/** Sleep that an abort ends, rejecting with the signal's own reason. Shared with
 *  {@link withRateLimitRetry}, which waits under the same signal for the same
 *  provider — two copies of this would be two abort semantics. */
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

/**
 * An abort's own reason, as an Error — so a cancelled wait is attributable to
 * whoever cancelled it.
 *
 * Three call sites need this in lockstep (the two arms of {@link abortableSleep}
 * and {@link ProviderPacer.admit}), and each of the three arms below is a real
 * case rather than defensive padding: a caller's own `Error` passes through
 * verbatim, because relabelling it would lose the reason; a bare
 * `controller.abort()` produces the shape every caller of this already handled;
 * and a non-Error reason is named here rather than thrown raw, because a thrown
 * string arrives at a `catch` with no cause chain at all.
 */
function abortCause(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  if (reason === undefined) return new DOMException('Aborted', 'AbortError');
  return new Error(`the wait was aborted: ${String(reason)}`);
}

/** One provider host's share of the pacer. */
interface HostLane {
  /** Requests currently holding a lane — out, and awaiting headers. */
  active: number;
  /** Everyone queued for a lane. Woken as a set on release: with lanes in the
   *  single digits a wake-all cannot starve anyone, and it has no lost-wakeup
   *  case, which a hand-off queue does the moment a woken waiter aborts. */
  waiting: Array<() => void>;
  /** The provider's own instruction, as a deadline. */
  coolUntilMs: number;
}

export interface ProviderPacerOptions {
  readonly lanes?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * The isolate's view of its model providers: how many requests are out, and
 * whether any of them has been told to wait.
 *
 * Keyed by HOST rather than by credential. The rate limit being respected is the
 * account's at a provider, and the host is what every call site already has —
 * `providerHost(input)` in the retry layer, with no credential in reach. Two
 * accounts against one host share a lane budget, which is conservative in the
 * only direction that matters here.
 */
export class ProviderPacer {
  private readonly lanes: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly hosts = new Map<string, HostLane>();
  private declaredCount = 0;

  constructor(opts: ProviderPacerOptions = {}) {
    this.lanes = opts.lanes ?? PROVIDER_REQUEST_LANES;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? abortableSleep;
  }

  /**
   * Wait until this host will accept another request, then hold a lane until the
   * returned release is called.
   *
   * Two gates in this order, and the order is the point: the provider's own
   * instruction FIRST, because a lane that were granted during a cooldown would
   * spend the cooldown holding capacity nobody may use, and only then the lane.
   *
   * The release MUST be called — every caller does it in a `finally`.
   */
  async admit(host: string, signal?: AbortSignal): Promise<() => void> {
    const lane = this.laneFor(host);
    for (;;) {
      if (signal?.aborted) throw abortCause(signal);
      const cooling = lane.coolUntilMs - this.now();
      if (cooling > 0) {
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

  /**
   * Wait to be woken by a release — or by the caller's own abort, whichever
   * comes first.
   *
   * The abort arm is not a nicety. Without it a queued request whose turn is
   * cancelled sits here until an unrelated release happens to wake it, which on
   * a fully-occupied host is a cancelled node still counted as working. Resolving
   * (rather than rejecting) hands the decision back to the loop, whose first act
   * is to re-check the signal — so there is one place that turns an abort into a
   * throw.
   */
  private queueForLane(lane: HostLane, signal?: AbortSignal): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    lane.waiting.push(resolve);
    signal?.addEventListener('abort', () => { resolve(); }, { once: true });
    return promise;
  }

  /**
   * Record that this host has asked us to hold off for `ms`.
   *
   * The deadline only ever moves FORWARD (`Math.max`), so a peer that receives a
   * shorter `Retry-After` cannot shorten a longer one already in force — the
   * conservative direction, and the one that stops a fan-out from converging on
   * the smallest number any of its members happened to be handed.
   */
  declareWait(host: string, ms: number): void {
    if (!(ms > 0)) return;
    const lane = this.laneFor(host);
    lane.coolUntilMs = Math.max(lane.coolUntilMs, this.now() + ms);
    this.declaredCount += 1;
  }

  /** Every open wait, as the turn loop's watchdog reads them. */
  waits(): ProviderWaitState {
    let untilMs = 0;
    const now = this.now();
    for (const lane of this.hosts.values()) {
      if (lane.coolUntilMs > now && lane.coolUntilMs > untilMs) untilMs = lane.coolUntilMs;
    }
    return { untilMs, declared: this.declaredCount };
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

/** The isolate's pacer. One provider account, one clock — see the file header for
 *  why the scope is the isolate and not the turn. */
export const providerPacer = new ProviderPacer();
