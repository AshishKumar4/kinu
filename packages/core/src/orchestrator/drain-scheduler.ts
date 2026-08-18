// DrainScheduler — debounces the event→turn drain so a burst of external
// events (webhook fan-in, an email plus its bounce, several peer messages)
// coalesces into ONE programmatic turn instead of fragmenting into many.
// Without it the first event drains instantly (a turn for one event) and each
// event landing milliseconds later misses that batch and spawns its own turn.
//
// Debounce discipline: FIXED window (leading-edge armed, trailing fire). The
// first schedule() arms a ~250ms timer; schedule()s inside the window are
// absorbed; the timer fires once → drain → disarm. Deliberately NOT a sliding
// window (reset-on-every-call): a steady event stream would push a sliding
// deadline forever and starve the drain, while a fixed window bounds worst-case
// latency at windowMs no matter the arrival rate.
//
// The timer primitive is injected — platform-shaped (BackendHost.setTimer):
// the CF DO must keep itself alive through the window (keepAliveWhile), the
// CLI uses a plain setTimeout, tests use a hand-cranked fake. Losing an armed
// timer (DO eviction) only DELAYS the drain: events are durable in the
// EventLog until markConsumed, and the next trigger (ingress, cron alarm,
// post-turn drain) picks the backlog up.

import { diagnostics, toProteusError } from '../obs/index.js';

/** The coalescing window. Long enough to absorb a same-cause burst, short
 *  enough to be imperceptible against a multi-second agent turn. */
export const DRAIN_DEBOUNCE_MS = 250;

/** One-shot platform timer: run `fn` after `ms`, keeping the platform alive
 *  until it settles. See BackendHost.setTimer for the per-backend contract. */
export type DrainTimer = (fn: () => Promise<void>, ms: number) => void;

export class DrainScheduler {
  private armed = false;

  constructor(
    private readonly drain: () => Promise<void>,
    private readonly setTimer: DrainTimer,
  ) {}

  /** Coalesce: arm the window on the first call, absorb calls while armed.
   *  Disarms BEFORE draining so an event landing mid-drain (after the drain's
   *  pending-select) arms a fresh window rather than being silently absorbed. */
  schedule(): void {
    if (this.armed) return;
    this.armed = true;
    this.setTimer(async () => {
      this.armed = false;
      try {
        await this.drain();
      } catch (err) {
        // Never wedge: the window is already disarmed, the next schedule()
        // re-arms. Events stay pending in the EventLog for the next drain.
        diagnostics.failure(
          'orchestrator.debounced_drain_failed',
          toProteusError({ doing: 'run the debounced event drain', cause: err, otherwise: 'unavailable' }),
        );
      }
    }, DRAIN_DEBOUNCE_MS);
  }
}
