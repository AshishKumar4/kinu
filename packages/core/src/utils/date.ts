
export function isoDate(at: number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

export const MINUTE_MS = 60_000;

export const HOUR_MS = 60 * MINUTE_MS;

export const DAY_MS = 24 * HOUR_MS;
