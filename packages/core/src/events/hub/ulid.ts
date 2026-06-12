/**
 * Crockford-base32 ULID — monotonic-ish, sortable by creation time.
 *
 * Format: 10 chars timestamp (48-bit ms since epoch) + 16 chars random.
 * All EventsHub primary keys use this. Keep one canonical implementation.
 */

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(): string {
  const ts = Date.now();
  const tsChars: string[] = [];
  let t = ts;
  for (let i = 9; i >= 0; i--) {
    tsChars[i] = ULID_ALPHABET[t % 32];
    t = Math.floor(t / 32);
  }
  const rand: string[] = [];
  for (let i = 0; i < 16; i++) {
    rand.push(ULID_ALPHABET[Math.floor(Math.random() * 32)]);
  }
  return tsChars.join('') + rand.join('');
}

/** Extract the timestamp (unix-ms) encoded in a ULID. */
export function ulidTime(id: string): number {
  let t = 0;
  for (let i = 0; i < 10; i++) {
    t = t * 32 + ULID_ALPHABET.indexOf(id[i]);
  }
  return t;
}

/** Compare two ULIDs lexically — equivalent to chronological order. */
export function ulidCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
