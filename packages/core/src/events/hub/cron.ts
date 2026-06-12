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
