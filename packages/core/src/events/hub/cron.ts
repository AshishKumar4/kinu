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

// Only minute and hour may be non-wildcard (`*`, `*/n`, or an integer); otherwise null.
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
  // setUTCMinutes rolls 60+ into the next hour; rolling the hour manually too fires an hour late.
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
