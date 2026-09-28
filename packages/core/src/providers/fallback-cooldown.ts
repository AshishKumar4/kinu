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
  responseHeaders: v.optional(v.record(v.string(), v.string())),
  cause: v.optional(v.unknown()),
});

export function statedRetryAfterMs(failure: { readonly cause: unknown }, nowMs: number = Date.now()): number | null {
  let at = v.safeParse(WithHeadersSchema, failure.cause);

  for (let depth = 0; at.success && depth < 4; depth += 1) {
    const headers = new Headers(at.output.responseHeaders ?? {});
    const ms = Number(headers.get('retry-after-ms') ?? Number.NaN);

    if (Number.isFinite(ms)) return ms;
    const after = headers.get('retry-after');

    if (after !== null) {
      const seconds = Number(after);

      if (Number.isFinite(seconds)) return seconds * 1000;
      const date = Date.parse(after);

      if (!Number.isNaN(date)) return Math.max(0, date - nowMs);
    }

    at = v.safeParse(WithHeadersSchema, at.output.cause);
  }

  return null;
}
