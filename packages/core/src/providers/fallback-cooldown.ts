/** Provider-declared retry delays, read without replacing the response's headers. */

import * as v from 'valibot';

const WithHeadersSchema = v.looseObject({
  retryAfterMs: v.optional(v.number()),
  responseHeaders: v.optional(v.record(v.string(), v.string())),
  cause: v.optional(v.unknown()),
});

export function statedRetryAfterMs(failure: { readonly cause: unknown }, nowMs: number = Date.now()): number | null {
  let at = v.safeParse(WithHeadersSchema, failure.cause);

  for (let depth = 0; at.success && depth < 4; depth += 1) {
    const ms = at.output.retryAfterMs ?? retryAfterOf(new Headers(at.output.responseHeaders ?? {}), nowMs);

    if (ms !== null) return ms;
    at = v.safeParse(WithHeadersSchema, at.output.cause);
  }

  return null;
}

export function retryAfterOf(headers: Headers, nowMs: number): number | null {
  const ms = Number(headers.get('retry-after-ms') ?? Number.NaN);

  if (Number.isFinite(ms) && ms >= 0) return ms;
  const after = headers.get('retry-after')?.trim();

  if (!after) return null;
  const seconds = Number(after);

  // A number is never a date: `Date.parse('-1')` is the year 2001, which would read as no wait.
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const date = Date.parse(after);

  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}
