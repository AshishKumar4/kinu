import { Effect } from 'effect';
import { settleSync } from '../../obs/index';

/** A past-due retry is clamped to `now`, not dropped, or it stalls until an unrelated wake. */
export function nextAlarmTime(
  now: number,
  triggerFireTimes: ReadonlyArray<number | null | undefined>,
  ...retryAts: Array<number | null>
): number | null {
  const candidates = triggerFireTimes.filter((t): t is number => t != null && t > now);

  for (const retryAt of retryAts) {
    if (retryAt != null) candidates.push(Math.max(retryAt, now));
  }

  return candidates.length === 0 ? null : Math.min(...candidates);
}

/** Whether `zone` is an IANA time zone this runtime knows (`Europe/Lisbon`, `UTC`), an old alias a browser may still
 *  report (`Asia/Calcutta`) among them: a zone it does not know is the `RangeError` Intl answers. */
export function knownTimeZone(zone: string): boolean {
  return settleSync(Effect.try({ try: () => new Intl.DateTimeFormat('en', { timeZone: zone }), catch: (cause) => cause }).pipe(
    Effect.map(() => true),
    Effect.catch((cause) => (cause instanceof RangeError ? Effect.succeed(false) : Effect.die(cause))),
  ));
}

/** A wall clock in `zone`: each instant's local `YYYY-MM-DD HH:MM`, its hour and its minute. */
function wallClockOf(zone: string): (instant: number) => { readonly stamp: string; readonly hour: number; readonly minute: number } {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });

  return (instant) => {
    const part = Object.fromEntries(format.formatToParts(instant).map(({ type, value }) => [type, value]));

    return { stamp: `${part.year ?? ''}-${part.month ?? ''}-${part.day ?? ''} ${part.hour ?? ''}:${part.minute ?? ''}`, hour: Number(part.hour), minute: Number(part.minute) };
  };
}

const MINUTE_MS = 60_000;

/**
 * The first minute after `from` whose wall clock in `timeZone` (UTC when absent) the cron names. Only minute and hour
 * may be non-wildcard (`*`, `*\/n`, or an integer); otherwise null. In a zone with daylight saving a wall-clock minute
 * fires once: a minute the clocks skip does not fire that day, and a minute they repeat fires on its first pass only.
 */
export function nextCronFire(cron: string, from: number, timeZone?: string): number | null {
  const parts = cron.trim().split(/\s+/);

  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  if (dayOfMonth !== '*' || month !== '*' || dayOfWeek !== '*') return null;

  const minuteMatches = parseCronField(minute, 59);
  const hourMatches = parseCronField(hour, 23);

  if (!minuteMatches || !hourMatches || (timeZone !== undefined && !knownTimeZone(timeZone))) return null;
  const wall = wallClockOf(timeZone ?? 'UTC');
  const after = wall(from).stamp;
  const first = Math.floor(from / MINUTE_MS) * MINUTE_MS + MINUTE_MS;

  // A day and the hour a fall-back repeats, and its minutes: the next fire of a daily schedule may be 25 hours away.
  for (let candidate = first; candidate < first + 26 * 60 * MINUTE_MS; candidate += MINUTE_MS) {
    const local = wall(candidate);

    if (local.stamp > after && minuteMatches(local.minute) && hourMatches(local.hour)) return candidate;
  }

  return null;
}

function parseCronField(field: string, max: number): ((value: number) => boolean) | null {
  if (field === '*') return () => true;

  const stepMatch = /^\*\/(\d+)$/.exec(field);

  if (stepMatch) {
    const step = Number(stepMatch[1]);

    return Number.isFinite(step) && step > 0 ? (value) => value % step === 0 : null;
  }

  if (!/^\d+$/.test(field)) return null;
  const expected = Number(field);

  return expected <= max ? (value) => value === expected : null;
}
