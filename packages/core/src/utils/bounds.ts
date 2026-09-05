/**
 * The one bound a caller-supplied row count passes through before it reaches
 * SQL.
 *
 * SQLite treats `LIMIT -1` as NO limit, so a single negative value turns a paged
 * read into a full table read, and it rejects a fraction or `NaN` as a datatype
 * mismatch — a 500 on a read that should simply have been clamped. Neither can
 * be left to a caller's manners, and neither is worth a bespoke expression at
 * every read site: this module is that expression, once.
 *
 * Each surface supplies its OWN default and ceiling. The policy here is only the
 * shape of a usable bound, never how much any particular read may ask for.
 */

/**
 * `value` as a finite integer inside `[min, max]`, or `fallback` when the caller
 * stated nothing usable.
 *
 * Absent and non-finite both mean UNSTATED. A route that forwards
 * `Number('abc')` cannot be told apart from one that asked for nothing, and
 * guessing at the difference is not a bound's job. A fraction truncates toward
 * zero and then clamps, so `0.5` reaches SQL as `min`, never as `0`.
 * A min above max is a caller bug and throws.
 */
export function boundedInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (min > max) throw new Error(`boundedInt: min ${min} exceeds max ${max}`);
  const n = value !== undefined && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** The two numbers one surface states about a caller-supplied page: the rows a
 *  read returns when the caller states nothing usable, and the most an
 *  UNTRUSTED caller may ask for. */
export interface PageBounds {
  readonly fallback: number;
  readonly max: number;
}

/**
 * Close an untrusted caller's page before it crosses an object boundary:
 * `limit` becomes a finite integer in [1, `page.max`] and `since` a finite
 * non-negative integer, whatever the caller passed.
 *
 * Absent and non-finite both mean UNSTATED and take `page.fallback`.
 *
 * Two logs cross a boundary this way — `run_events` and `agent_log` — and each
 * states its own two numbers. The SHAPE lives here once because the same
 * negative limit read both tables end to end, and the second one stayed open
 * for as long as the first one's bound was a body rather than a function.
 */
export function boundPageQuery<T extends { since?: number; limit?: number }>(
  query: T,
  page: PageBounds,
): T & { since: number; limit: number } {
  return {
    ...query,
    since: boundedInt(query.since, 0, 0, Number.MAX_SAFE_INTEGER),
    limit: boundedInt(query.limit, page.fallback, 1, page.max),
  };
}
