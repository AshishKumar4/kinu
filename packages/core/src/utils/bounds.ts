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
 */
export function boundedInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = value !== undefined && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}
