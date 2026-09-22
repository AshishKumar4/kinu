/** Bounds a caller-supplied row count before SQL: SQLite reads `LIMIT -1` as no limit and rejects fractions/`NaN`. */

/**
 * `value` as a finite integer in `[min, max]`, or `fallback` when absent or non-finite. Fractions truncate then clamp.
 * Throws when min > max.
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

/** A surface's page policy: the default row count, and the most an untrusted caller may ask for. */
export interface PageBounds {
  readonly fallback: number;
  readonly max: number;
}

/** Close an untrusted page: `limit` becomes an integer in [1, `page.max`] (unstated takes `page.fallback`), `since` a non-negative integer. */
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
