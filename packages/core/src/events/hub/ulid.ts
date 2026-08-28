/**
 * Crockford-base32 ULID — monotonic (spec's monotonic mode), sortable by
 * creation time. Within one process, ids minted in the same millisecond
 * increment the random suffix instead of re-rolling it, so `ORDER BY id`
 * is true creation order — the hub's id-ordered scans rely on this
 * (`log.ts:572` latest phase, `log.ts:589` step trace).
 *
 * Format: 10 chars timestamp (48-bit ms since epoch) + 16 chars random.
 * All EventsHub primary keys use this. Keep one canonical implementation.
 */

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTs = -1;
let lastRand: number[] = [];

export function ulid(): string {
  const ts = Date.now();
  const tsChars: string[] = [];
  let t = ts;
  for (let i = 9; i >= 0; i--) {
    tsChars[i] = ULID_ALPHABET[t % 32];
    t = Math.floor(t / 32);
  }

  if (ts === lastTs) {
    // Same millisecond: increment the previous random suffix (base-32,
    // little chance of overflow across 16 chars; on overflow, re-roll).
    let i = 15;
    while (i >= 0) {
      if (lastRand[i] < 31) { lastRand[i]++; break; }
      lastRand[i] = 0;
      i--;
    }
    if (i < 0) lastRand = rollRandom();
  } else {
    lastTs = ts;
    lastRand = rollRandom();
  }

  let rand = '';
  for (let i = 0; i < 16; i++) rand += ULID_ALPHABET[lastRand[i]];
  return tsChars.join('') + rand;
}

/** Built from the alphabet above so the two cannot drift: a 26-char id in
 *  Crockford base32 is one `ulid()` could have minted. Callers that route on an
 *  id — the signed webhook delivery path — need to refuse anything else before
 *  it reaches a Durable Object name. */
const ULID_PATTERN = new RegExp(`^[${ULID_ALPHABET}]{26}$`, 'u');

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

function rollRandom(): number[] {
  const out: number[] = [];
  for (let i = 0; i < 16; i++) out.push(Math.floor(Math.random() * 32));
  return out;
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
