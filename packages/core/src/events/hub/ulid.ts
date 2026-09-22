/** Monotonic ULID: same-millisecond ids increment the suffix, so `ORDER BY id` is creation order
 *  (the hub's id-ordered scans rely on this). */

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

/** Routing callers (signed webhook path) refuse non-ULIDs before they reach a DO name. */
const ULID_PATTERN = new RegExp(`^[${ULID_ALPHABET}]{26}$`, 'u');

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

function rollRandom(): number[] {
  const out: number[] = [];

  for (let i = 0; i < 16; i++) out.push(Math.floor(Math.random() * 32));

  return out;
}
