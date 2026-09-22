// Kept out of the SSE route, which reaches `cloudflare:*`, so tests can import the shipped rule.
/** `-1` replays from the start; blank (`Number('')` is 0), negative, fractional, or NaN ids also map to -1. */
export function resumeIndexFromLastEventId(lastEventId: string | null): number {
  if (lastEventId === null || lastEventId.trim() === '') return -1;
  const index = Number(lastEventId);

  return Number.isInteger(index) && index >= -1 ? index : -1;
}
