// Debounces the event→turn drain so a burst of events coalesces into one turn.
// Fixed window, not sliding: a steady stream must not starve the drain.
// A lost timer only delays the drain; events stay in the EventLog until markConsumed.

import { diagnostics, toKinuError } from '../obs/index';

/** Coalescing window. */
export const DRAIN_DEBOUNCE_MS = 250;

/** One-shot platform timer; see BackendHost.setTimer for the per-backend contract. */
export type DrainTimer = (fn: () => Promise<void>, ms: number) => void;

export class DrainScheduler {
  private armed = false;

  constructor(
    private readonly drain: () => Promise<void>,
    private readonly setTimer: DrainTimer,
  ) {}

  /** Disarms before draining so an event landing mid-drain arms a fresh window. */
  schedule(): void {
    if (this.armed) return;
    this.armed = true;
    this.setTimer(async () => {
      this.armed = false;

      try {
        await this.drain();
      } catch (err) {
        // Window already disarmed; the next schedule() re-arms.
        diagnostics.failure(
          'orchestrator.debounced_drain_failed',
          toKinuError({ doing: 'run the debounced event drain', cause: err, otherwise: 'unavailable' }),
        );
      }
    }, DRAIN_DEBOUNCE_MS);
  }
}
