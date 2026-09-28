/** Recovery pace for durable lanes: unbounded attempts, bounded pace. One shared curve; do not redefine per caller. */

/** Wait before attempt `attempts + 1`: 1s doubling to a 60s ceiling. */
export function recoveryBackoffMs(attempts: number): number {
  return Math.min(1000 * 2 ** Math.min(attempts, 6), RECOVERY_BACKOFF_CEILING_MS);
}

export const RECOVERY_BACKOFF_CEILING_MS = 60_000;
