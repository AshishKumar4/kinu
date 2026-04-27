/** Date helpers — no external dependencies. */

export function isoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function today(): string {
  return isoDate();
}

export function nowMs(): number {
  return Date.now();
}
