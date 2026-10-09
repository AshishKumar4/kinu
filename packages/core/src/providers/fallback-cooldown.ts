/** OMP "cooldown-expiry" (turn-recovery.ts 1623-1630, 2184-2240): Retry-After, else 5 min; per isolate. */

import * as v from 'valibot';

const UNSTATED_COOLDOWN_MS = 5 * 60 * 1000;

export interface FallbackCooldowns {
  park(spec: string, retryAfterMs: number | null): void;
  parked(spec: string): boolean;
}

export function createFallbackCooldowns(now: () => number = Date.now): FallbackCooldowns {
  const until = new Map<string, number>();

  return {
    park: (spec, retryAfterMs) => {
      until.set(spec, now() + (retryAfterMs === null || retryAfterMs <= 0 ? UNSTATED_COOLDOWN_MS : retryAfterMs));
    },
    parked: (spec) => {
      const end = until.get(spec);

      if (end === undefined) return false;

      if (end > now()) return true;
      until.delete(spec);

      return false;
    },
  };
}

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
