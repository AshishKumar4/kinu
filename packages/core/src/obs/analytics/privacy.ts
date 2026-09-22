/**
 * Keeps conversation text out of fleet analytics. Workspace ids are mission-derived (user text)
 * and admin ids are emails, so both are written as {@link analyticsDigest}. Not a secret-hiding
 * primitive: workspace names are enumerable, so this does not replace read-path authorization.
 */
import { RESERVED_LOG_FIELDS } from '../log';

/**
 * Refuse, at module load, a publishable name set containing a reserved log field or a duplicate
 * (readers resolve slots by name, so a duplicate would silently shadow). Values are never scrubbed.
 */
export function assertPublishableNames(where: string, names: readonly string[]): void {
  const seen: Record<string, true> = {};

  for (const name of names) {
    if (RESERVED_LOG_FIELDS.some((field) => field === name)) {
      throw new RangeError(`${where}: "${name}" is a reserved field name and may not be published`);
    }

    if (seen[name] === true) throw new RangeError(`${where}: "${name}" is declared twice`);
    seen[name] = true;
  }
}

/**
 * Stable non-reversing hex digest: 64-bit FNV-1a over UTF-8, synchronous because
 * `crypto.subtle.digest` is async and writes here are fire-and-forget. `''` stays `''`.
 */
export function analyticsDigest(value: string): string {
  if (value === '') return '';
  const bytes = new TextEncoder().encode(value);
  let high = 0x811c9dc5;
  let low = 0x811c9dc5;

  for (let i = 0; i < bytes.length; i += 1) {
    low = Math.imul(low ^ bytes[i], 0x01000193) >>> 0;
    high = Math.imul(high ^ ((bytes[i] + i) & 0xff), 0x01000193) >>> 0;
  }

  return high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0');
}
