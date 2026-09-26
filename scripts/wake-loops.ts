/**
 * Wake-loop detection over startups counted per object per hour, for `prod-logs.ts wakes`.
 *
 * Threshold, measured 2026-09-26 over 7 days of production telemetry (activations counted by
 * `vector.store_registered`, one per runtime build; seven unsampled 24 h queries): 1,854
 * object-hours had a startup and they split in two, 1,421 under 5 and 264 at 60 or more, with 55
 * between 10 and 29. 23 of 1,153 objects reached 30 in some hour, among them warm-forge-4d6acc02's
 * 30 s loop (peak 120) and the eval workspace looping since 09-23 (peak 129). 30 an hour is one
 * activation every two minutes.
 */

export const WAKE_LOOP_STARTUPS_PER_HOUR = 30;

const HOUR_MS = 3_600_000;

export interface StartupHour {
  /** Workspace digest (Analytics Engine) or Durable Object id (telemetry). */
  readonly object: string;
  /** Start of the hour, epoch ms. */
  readonly hour: number;
  readonly startups: number;
}

export interface WakeLoop {
  readonly object: string;
  readonly startups: number;
  readonly peakPerHour: number;
  /** Hours at or over the threshold. */
  readonly loopHours: number;
  /** Longest run of consecutive loop hours. */
  readonly longestRunHours: number;
  readonly firstLoopHour: number;
  readonly lastLoopHour: number;
  /** Two or more consecutive loop hours: a loop, not a burst of reconnects. */
  readonly sustained: boolean;
}

/** Objects with at least one loop hour, most loop hours first. */
export function findWakeLoops(
  rows: readonly StartupHour[],
  threshold = WAKE_LOOP_STARTUPS_PER_HOUR,
): WakeLoop[] {
  const byObject = new Map<string, Map<number, number>>();

  for (const row of rows) {
    const hours = byObject.get(row.object) ?? new Map<number, number>();
    const hour = Math.floor(row.hour / HOUR_MS) * HOUR_MS;
    hours.set(hour, (hours.get(hour) ?? 0) + row.startups);
    byObject.set(row.object, hours);
  }

  const loops: WakeLoop[] = [];

  for (const [object, hours] of byObject) {
    const ordered = [...hours.entries()].sort(([a], [b]) => a - b);
    const loopHours = ordered.filter(([, n]) => n >= threshold).map(([hour]) => hour);

    if (loopHours.length === 0) continue;
    let longest = 1;
    let run = 1;

    for (let i = 1; i < loopHours.length; i += 1) {
      run = loopHours[i] - loopHours[i - 1] === HOUR_MS ? run + 1 : 1;
      longest = Math.max(longest, run);
    }

    loops.push({
      object,
      startups: ordered.reduce((sum, [, n]) => sum + n, 0),
      peakPerHour: Math.max(...ordered.map(([, n]) => n)),
      loopHours: loopHours.length,
      longestRunHours: longest,
      firstLoopHour: loopHours[0],
      lastLoopHour: loopHours[loopHours.length - 1],
      sustained: longest >= 2,
    });
  }

  return loops.sort((a, b) => b.loopHours - a.loopHours || b.peakPerHour - a.peakPerHour);
}
