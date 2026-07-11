/**
 * Fold the next-soonest DO alarm out of the active triggers' fire times and
 * the peer-outbox retry. Trigger times compete only when in the future (due
 * triggers were just handled by the alarm body); a due/past-due peer retry is
 * CLAMPED to `now` instead of dropped — a pending delivery whose retry time
 * already passed (reentrancy-skipped dispatch, order-blocked receiver) must
 * re-arm immediately, or it stalls until an unrelated event wakes the DO.
 * Returns null when nothing is pending.
 */
export function nextAlarmTime(
  now: number,
  triggerFireTimes: ReadonlyArray<number | null | undefined>,
  peerRetryAt: number | null,
): number | null {
  const candidates = triggerFireTimes.filter((t): t is number => typeof t === 'number' && t > now);
  if (peerRetryAt != null) candidates.push(Math.max(peerRetryAt, now));
  return candidates.length === 0 ? null : Math.min(...candidates);
}

// Minimal cron next-fire computation for the trigger registry. Supports:
// - every-N-minutes expressions such as "*/5 * * * *"
// - daily UTC expressions such as "30 2 * * *"
// Returns the next fire time (epoch ms) strictly after `from`, or null for an
// unsupported/malformed expression.
export function nextCronFire(cron: string, from: number): number | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour] = parts;
  const d = new Date(from);

  // every-n-minutes: `*/n * * * *`
  if (min.startsWith('*/')) {
    const n = parseInt(min.slice(2), 10);
    if (Number.isFinite(n) && n > 0) {
      const cur = d.getUTCMinutes();
      const next = (Math.floor(cur / n) + 1) * n;
      const nd = new Date(d);
      // setUTCMinutes normalizes 60+ into the next hour; do not also roll the
      // hour manually or boundary firings move an hour late.
      nd.setUTCMinutes(next, 0, 0);
      return nd.getTime();
    }
  }

  // daily at hh:mm UTC
  const m = parseInt(min, 10);
  const h = parseInt(hour, 10);
  if (Number.isFinite(m) && Number.isFinite(h)) {
    const nd = new Date(d);
    nd.setUTCHours(h, m, 0, 0);
    if (nd.getTime() <= from) nd.setUTCDate(nd.getUTCDate() + 1);
    return nd.getTime();
  }
  return null;
}
