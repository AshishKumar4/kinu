/**
 * Fold the next-soonest DO alarm out of the active triggers' fire times and
 * any durable-retry clocks (peer outbox, email outbox). Trigger times compete
 * only when in the future (due triggers were just handled by the alarm body);
 * a due/past-due retry is CLAMPED to `now` instead of dropped — a pending
 * delivery whose retry time already passed (reentrancy-skipped dispatch,
 * order-blocked receiver) must re-arm immediately, or it stalls until an
 * unrelated event wakes the DO. Returns null when nothing is pending.
 */
export function nextAlarmTime(
  now: number,
  triggerFireTimes: ReadonlyArray<number | null | undefined>,
  ...retryAts: Array<number | null>
): number | null {
  const candidates = triggerFireTimes.filter((t): t is number => typeof t === 'number' && t > now);
  for (const retryAt of retryAts) {
    if (retryAt != null) candidates.push(Math.max(retryAt, now));
  }
  return candidates.length === 0 ? null : Math.min(...candidates);
}

// Minimal cron next-fire computation for the trigger registry. The minute and
// hour fields accept wildcards, wildcard steps, or integer values. All other
// fields must be wildcards.
// Returns the next fire time (epoch ms) strictly after `from`, or null for an
// unsupported/malformed expression.
export function nextCronFire(cron: string, from: number): number | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (dayOfMonth !== '*' || month !== '*' || dayOfWeek !== '*') return null;

  const minuteMatches = parseCronField(minute, 59);
  const hourMatches = parseCronField(hour, 23);
  if (!minuteMatches || !hourMatches) return null;

  const candidate = new Date(from);
  candidate.setUTCSeconds(0, 0);
  // setUTCMinutes normalizes 60+ into the next hour; do not also roll the
  // hour manually or boundary firings move an hour late.
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  for (let elapsedMinutes = 0; elapsedMinutes < 24 * 60; elapsedMinutes++) {
    if (minuteMatches(candidate.getUTCMinutes()) && hourMatches(candidate.getUTCHours())) {
      return candidate.getTime();
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
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
