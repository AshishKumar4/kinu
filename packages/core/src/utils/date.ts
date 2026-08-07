/** Date helpers — no external dependencies. */

export function isoDate(at: number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function today(): string {
  return isoDate();
}

export function nowMs(): number {
  return Date.now();
}
