/** Recovery pace for durable lanes: unbounded attempts, bounded pace. One shared curve; do not redefine per caller. */

/** A wait doubling from `base` per attempt past the first (`attempt` 1-based), never past `ceiling`. */
export function doublingBackoffMs(curve: { readonly base: number; readonly ceiling: number }, attempt: number): number {
  return Math.min(curve.base * 2 ** Math.min(Math.max(0, attempt - 1), 32), curve.ceiling);
}

export const RECOVERY_BACKOFF_CEILING_MS = 60_000;

/** Wait before attempt `attempts + 1`: 1s doubling to a 60s ceiling. */
export function recoveryBackoffMs(attempts: number): number {
  return doublingBackoffMs({ base: 1000, ceiling: RECOVERY_BACKOFF_CEILING_MS }, attempts + 1);
}
